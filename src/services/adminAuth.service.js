// Admin session for the one shared account (AGENT_CONTEXT.md section 9).
//
// Login compares the email and ALWAYS runs bcrypt.compare, so a wrong email costs the same
// as a wrong password. The session is an HS256 JWT { sub: "admin", pwv } kept in an httpOnly
// cookie. `pwv` is derived from ADMIN_PASSWORD_HASH, so changing the password invalidates
// every session issued under the old one. Nothing about the session is stored server side.

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../config/env.js";

const ADMIN_COOKIE_NAME = "oe_admin";
const ADMIN_COOKIE_PATH = "/api/v1/admin";
const ADMIN_SUBJECT = "admin";
const SESSION_SECONDS = 8 * 60 * 60;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest();

// Constant-time equality for strings of any length.
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));

const normalizeEmail = (email) => String(email).trim().toLowerCase();

// First 12 hex characters of sha256(ADMIN_PASSWORD_HASH).
const PASSWORD_VERSION = sha256(config.ADMIN_PASSWORD_HASH).toString("hex").slice(0, 12);

/** True only when the email AND the password match. Always runs bcrypt.compare. */
const verifyCredentials = async (email, password) => {
    const emailMatches = safeEqual(normalizeEmail(email), normalizeEmail(config.ADMIN_EMAIL));
    const passwordMatches = await bcrypt.compare(String(password), config.ADMIN_PASSWORD_HASH);
    return emailMatches && passwordMatches;
};

/** A fresh 8 hour session token. */
const issueSessionToken = () =>
    jwt.sign({ sub: ADMIN_SUBJECT, pwv: PASSWORD_VERSION }, config.ADMIN_JWT_SECRET, {
        algorithm: "HS256",
        expiresIn: SESSION_SECONDS,
    });

/**
 * Returns { expiresAt: Date } for a valid session token, or null for anything else
 * (bad signature, wrong algorithm, expired, wrong subject, or issued under a previous password).
 */
const verifySessionToken = (token) => {
    let payload;
    try {
        payload = jwt.verify(token, config.ADMIN_JWT_SECRET, { algorithms: ["HS256"] });
    } catch {
        return null;
    }

    if (
        !payload ||
        typeof payload !== "object" ||
        payload.sub !== ADMIN_SUBJECT ||
        typeof payload.pwv !== "string" ||
        typeof payload.exp !== "number" ||
        !safeEqual(payload.pwv, PASSWORD_VERSION)
    ) {
        return null;
    }

    return { expiresAt: new Date(payload.exp * 1000) };
};

// Options for res.cookie / res.clearCookie. clearCookie only works with the same path, so both share these.
const sessionCookieOptions = () => ({
    httpOnly: true,
    sameSite: "lax",
    secure: config.NODE_ENV === "production",
    path: ADMIN_COOKIE_PATH,
});

const SESSION_COOKIE_MAX_AGE_MS = SESSION_SECONDS * 1000;

const getAdminEmail = () => config.ADMIN_EMAIL;

export {
    ADMIN_COOKIE_NAME,
    ADMIN_COOKIE_PATH,
    SESSION_SECONDS,
    SESSION_COOKIE_MAX_AGE_MS,
    verifyCredentials,
    issueSessionToken,
    verifySessionToken,
    sessionCookieOptions,
    getAdminEmail,
};
