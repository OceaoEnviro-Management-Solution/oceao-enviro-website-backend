// Email one-time codes for the virtual meeting booking.
//
// Storage: one OtpChallenge document per email holding only
//   HMAC-SHA256(OTP_SECRET, email + ":" + code)
// never the code itself. The code is never logged (it appears only in the email).
//
// Concurrency: every state change is a single atomic update guarded by its limit, so
// parallel requests can neither bypass the cooldown/hourly cap nor get extra guesses.
//
// Both functions take an optional `now` so tests can freeze time.

import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { BOOKING } from "../config/booking.js";
import { config } from "../config/env.js";
import { OtpChallenge } from "../models/otpChallenge.model.js";
import { ApiError } from "../utils/ApiError.js";
import { sendOtpEmail } from "./notify.service.js";

const { otp: OTP } = BOOKING;

// The send-count window: starts at the first send and lasts one hour (OTP.maxSendsPerHour sends).
const SEND_WINDOW_MS = 60 * 60 * 1000;
const BOOKING_TOKEN_PURPOSE = "vm-booking";

const seconds = (ms) => Math.max(1, Math.ceil(ms / 1000));

const generateCode = () =>
    String(crypto.randomInt(0, 10 ** OTP.length)).padStart(OTP.length, "0");

const hashCode = (email, code) =>
    crypto.createHmac("sha256", config.OTP_SECRET).update(`${email}:${code}`).digest("hex");

const hashesMatch = (storedHash, candidateHash) => {
    const stored = Buffer.from(typeof storedHash === "string" ? storedHash : "", "hex");
    const candidate = Buffer.from(candidateHash, "hex");
    return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
};

const normalizeEmail = (email) => String(email).trim().toLowerCase();

/**
 * Claims a send slot for this email by atomically storing the new code hash.
 * Returns the document as it was BEFORE the claim (null if there was none) so a failed
 * email can be rolled back. Throws OTP_SEND_LIMIT / OTP_COOLDOWN when not allowed.
 */
const claimSend = async (email, codeHash, now) => {
    const cooldownCutoff = new Date(now.getTime() - OTP.resendCooldownSeconds * 1000);
    const windowCutoff = new Date(now.getTime() - SEND_WINDOW_MS);
    const freshCode = {
        codeHash,
        codeExpiresAt: new Date(now.getTime() + OTP.validityMinutes * 60 * 1000),
        attempts: 0,
        lastSentAt: now,
    };
    const options = { returnDocument: "before", runValidators: true };

    // 1. The previous window has ended: start a new one.
    const restarted = await OtpChallenge.findOneAndUpdate(
        { email, windowStartedAt: { $lte: windowCutoff }, lastSentAt: { $lte: cooldownCutoff } },
        {
            $set: {
                ...freshCode,
                sendCount: 1,
                windowStartedAt: now,
                expireAt: new Date(now.getTime() + SEND_WINDOW_MS),
            },
        },
        options
    );
    if (restarted) return restarted;

    // 2. Inside the current window, under the hourly cap and past the cooldown.
    const continued = await OtpChallenge.findOneAndUpdate(
        {
            email,
            windowStartedAt: { $gt: windowCutoff },
            sendCount: { $lt: OTP.maxSendsPerHour },
            lastSentAt: { $lte: cooldownCutoff },
        },
        { $set: freshCode, $inc: { sendCount: 1 } },
        options
    );
    if (continued) return continued;

    // 3. First code for this email.
    try {
        await OtpChallenge.create({
            email,
            ...freshCode,
            sendCount: 1,
            windowStartedAt: now,
            expireAt: new Date(now.getTime() + SEND_WINDOW_MS),
        });
        return null;
    } catch (error) {
        if (error?.code !== 11000) throw error;
    }

    // 4. A document exists and the conditions above did not match: say why.
    const existing = await OtpChallenge.findOne({ email }).lean();
    if (!existing) {
        // Removed between the steps (TTL): treat as a plain cooldown so the client retries.
        throw new ApiError(429, "OTP_COOLDOWN", "Please wait before requesting another code.", {
            retryAfterSec: OTP.resendCooldownSeconds,
        });
    }

    const windowEndsAt = existing.windowStartedAt.getTime() + SEND_WINDOW_MS;
    if (existing.sendCount >= OTP.maxSendsPerHour && windowEndsAt > now.getTime()) {
        throw new ApiError(429, "OTP_SEND_LIMIT", "Too many codes requested. Please try again later.", {
            retryAfterSec: seconds(windowEndsAt - now.getTime()),
        });
    }

    const cooldownEndsAt = existing.lastSentAt.getTime() + OTP.resendCooldownSeconds * 1000;
    throw new ApiError(429, "OTP_COOLDOWN", "Please wait before requesting another code.", {
        retryAfterSec: seconds(cooldownEndsAt - now.getTime()),
    });
};

// Puts back what claimSend overwrote, but only if our code is still the current one.
const rollbackSend = async (email, codeHash, previous) => {
    if (!previous) {
        await OtpChallenge.deleteOne({ email, codeHash });
        return;
    }
    await OtpChallenge.updateOne(
        { email, codeHash },
        {
            $set: {
                codeHash: previous.codeHash,
                codeExpiresAt: previous.codeExpiresAt,
                attempts: previous.attempts,
                sendCount: previous.sendCount,
                windowStartedAt: previous.windowStartedAt,
                lastSentAt: previous.lastSentAt,
                expireAt: previous.expireAt,
            },
        }
    );
};

/**
 * Generates a code, stores its hash and emails it.
 * @returns {Promise<{ expiresInSec: number, resendAfterSec: number }>}
 */
const sendOtp = async (rawEmail, { now = new Date() } = {}) => {
    const email = normalizeEmail(rawEmail);
    const code = generateCode();
    const codeHash = hashCode(email, code);

    const previous = await claimSend(email, codeHash, now);

    try {
        await sendOtpEmail({ email, code });
    } catch (error) {
        // The code never reached the customer: do not let it count against their limits.
        await rollbackSend(email, codeHash, previous).catch(() => {});
        throw error;
    }

    return {
        expiresInSec: OTP.validityMinutes * 60,
        resendAfterSec: OTP.resendCooldownSeconds,
    };
};

const issueBookingToken = (email) =>
    jwt.sign({ sub: email, purpose: BOOKING_TOKEN_PURPOSE }, config.BOOKING_TOKEN_SECRET, {
        algorithm: "HS256",
        expiresIn: OTP.bookingTokenMinutes * 60,
    });

/**
 * Checks a code. Each check first reserves one of the maxAttempts atomically, so
 * parallel guesses cannot exceed the limit. A correct code is consumed (single use).
 * @returns {Promise<{ bookingToken: string, expiresInSec: number }>}
 */
const verifyOtp = async (rawEmail, code, { now = new Date() } = {}) => {
    const email = normalizeEmail(rawEmail);

    const challenge = await OtpChallenge.findOneAndUpdate(
        { email, attempts: { $lt: OTP.maxAttempts } },
        { $inc: { attempts: 1 } },
        { returnDocument: "after" }
    );

    if (!challenge) {
        const existing = await OtpChallenge.findOne({ email }).lean();
        if (!existing || !existing.codeHash) {
            throw new ApiError(400, "OTP_NOT_FOUND", "No active code for this email. Please request a new one.");
        }
        if (existing.codeExpiresAt.getTime() <= now.getTime()) {
            throw new ApiError(410, "OTP_EXPIRED", "This code has expired. Please request a new one.");
        }
        throw new ApiError(429, "OTP_LOCKED", "Too many incorrect attempts. Please request a new code.");
    }

    if (challenge.codeExpiresAt.getTime() <= now.getTime()) {
        throw new ApiError(410, "OTP_EXPIRED", "This code has expired. Please request a new one.");
    }

    if (!hashesMatch(challenge.codeHash, hashCode(email, String(code)))) {
        const attemptsLeft = OTP.maxAttempts - challenge.attempts;
        if (attemptsLeft <= 0) {
            throw new ApiError(429, "OTP_LOCKED", "Too many incorrect attempts. Please request a new code.");
        }
        throw new ApiError(400, "OTP_INVALID", "That code is not correct.", { attemptsLeft });
    }

    // Single use: only one concurrent verification can consume the code.
    const consumed = await OtpChallenge.deleteOne({ email, codeHash: challenge.codeHash });
    if (consumed.deletedCount !== 1) {
        throw new ApiError(400, "OTP_NOT_FOUND", "No active code for this email. Please request a new one.");
    }

    return {
        bookingToken: issueBookingToken(email),
        expiresInSec: OTP.bookingTokenMinutes * 60,
    };
};

export { sendOtp, verifyOtp, BOOKING_TOKEN_PURPOSE };
