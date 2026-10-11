// Fires parallel requests at a RUNNING LOCAL server to prove capacity cannot be oversold.
//
//   npm run check:concurrency
//
//   1. 20 parallel POST /vm/bookings for ONE free slot        expect exactly 1 success
//   2. 20 parallel POST /callback/requests for ONE period     expect as many successes as the
//                                                              period has capacity left
//
// How it works
// - Booking tokens are signed here with BOOKING_TOKEN_SECRET (read from .env), one per fake
//   address, so no OTP or email is involved. Addresses end in @concurrency-check.invalid.
// - The slot and the period are chosen from the public calendar endpoints (first free ones).
// - After the burst the database is read back: exactly one booking holds the slot and the period's
//   counter equals its capacity, with one request document per success.
//
// Safety
// - Refuses to run when NODE_ENV=production, and only talks to localhost / 127.0.0.1 / ::1.
// - It writes real rows (bookings, requests, counters) into the database the server uses, so point
//   the server at a throwaway local database. They expire with the normal 30 day retention.
// - Start the server with limiters off and a Turnstile test key (see README "Concurrency check"):
//       cross-env NODE_ENV=test EMAIL_MODE=test node src/index.js
//   with TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA in .env. Leave the Google
//   variables empty, otherwise the one winning booking creates a real calendar event.
//
// Exit code 0 when both checks pass, 1 when one fails, 2 when it could not run.

import { pathToFileURL } from "node:url";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { BOOKING } from "../src/config/booking.js";
import { addDays, nowIST } from "../src/utils/time.js";

const PARALLEL = 20;
const LOOKAHEAD_DAYS = 28;
const BOOKING_TOKEN_PURPOSE = "vm-booking";   // must match src/services/otp.service.js
const FAKE_DOMAIN = "concurrency-check.invalid";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

class CheckError extends Error {}   // the check could not run (exit code 2)

const tally = (results) => {
    const counts = new Map();
    for (const { status, code } of results) {
        const key = status >= 200 && status < 300 ? String(status) : `${status} ${code ?? "no code"}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Object.fromEntries([...counts.entries()].sort());
};

const send = async (baseUrl, path, { method = "GET", body, token } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
        json = await response.json();
    } catch {
        // not JSON
    }
    return { status: response.status, code: json?.code, data: json?.data };
};

const get = async (baseUrl, path) => {
    const result = await send(baseUrl, path);
    if (result.status !== 200) {
        throw new CheckError(`GET ${path.split("?")[0]} answered ${result.status}${result.code ? ` ${result.code}` : ""}`);
    }
    return result.data;
};

const signBookingToken = (secret, email) =>
    jwt.sign({ sub: email, purpose: BOOKING_TOKEN_PURPOSE }, secret, { algorithm: "HS256", expiresIn: 10 * 60 });

const findFreeSlot = async (baseUrl, from, to) => {
    const { days } = await get(baseUrl, `/api/v1/vm/calendar?from=${from}&to=${to}`);
    for (const day of days.filter((d) => d.bookable)) {
        const availability = await get(baseUrl, `/api/v1/vm/availability?date=${day.date}`);
        const slot = availability.slots.find((s) => s.status === "available");
        if (slot) return { date: day.date, time: slot.time };
    }
    throw new CheckError(`No free virtual meeting slot in the next ${LOOKAHEAD_DAYS} days.`);
};

const findOpenPeriod = async (baseUrl, from, to) => {
    const { days } = await get(baseUrl, `/api/v1/callback/calendar?from=${from}&to=${to}`);
    for (const day of days.filter((d) => d.bookable)) {
        const availability = await get(baseUrl, `/api/v1/callback/availability?date=${day.date}`);
        const period = availability.periods.find((p) => p.available);
        if (period) return { date: day.date, period: period.key };
    }
    throw new CheckError(`No open callback period in the next ${LOOKAHEAD_DAYS} days.`);
};

// 20 parallel bookings of one slot. Every request has its own verified address.
const checkVmSlot = async ({ baseUrl, bookingTokenSecret, models, from, to, runId }) => {
    const { date, time } = await findFreeSlot(baseUrl, from, to);

    const results = await Promise.all(
        Array.from({ length: PARALLEL }, (_, index) => {
            const email = `vm-${runId}-${index}@${FAKE_DOMAIN}`;
            return send(baseUrl, "/api/v1/vm/bookings", {
                method: "POST",
                token: signBookingToken(bookingTokenSecret, email),
                body: {
                    name: `Concurrency Check ${index}`,
                    mobileNumber: "9876543210",
                    date,
                    time,
                },
            });
        })
    );

    const successes = results.filter((r) => r.status === 201).length;
    const stored = await models.VmBooking.countDocuments({ date, time, status: "confirmed" });
    const slots = await models.VmSlot.countDocuments({ date, time });

    return {
        name: "VM booking: 20 parallel requests, one slot",
        target: `${date} ${time}`,
        expected: 1,
        successes,
        counts: tally(results),
        database: `${stored} confirmed booking(s), ${slots} slot document(s) for that slot`,
        passed: successes === 1 && stored === 1 && slots === 1,
    };
};

// 20 parallel callback requests for one period. Every request has its own email address.
const checkCallbackPeriod = async ({ baseUrl, captchaToken, models, from, to, runId }) => {
    const { date, period } = await findOpenPeriod(baseUrl, from, to);

    // What the period can still take: capacity minus what is already booked.
    const settings = await models.Settings.findOne({ key: models.SETTINGS_KEY }).lean();
    const saved = settings?.callbackCapacity?.[period];
    const capacity = Number.isInteger(saved) ? saved : BOOKING.callback.periods[period].defaultCapacity;
    const bucketBefore = await models.CallbackBucket.findOne({ date, period }).lean();
    const remaining = Math.max(0, capacity - (bucketBefore?.booked ?? 0));
    const requestsBefore = await models.CallbackRequest.countDocuments({ date, period, status: { $ne: "cancelled" } });

    const results = await Promise.all(
        Array.from({ length: PARALLEL }, (_, index) =>
            send(baseUrl, "/api/v1/callback/requests", {
                method: "POST",
                body: {
                    name: `Concurrency Check ${index}`,
                    email: `cb-${runId}-${index}@${FAKE_DOMAIN}`,
                    mobileNumber: "9876543210",
                    date,
                    period,
                    turnstileToken: captchaToken,
                },
            })
        )
    );

    const successes = results.filter((r) => r.status === 201).length;
    const bucketAfter = await models.CallbackBucket.findOne({ date, period }).lean();
    const requestsAfter = await models.CallbackRequest.countDocuments({ date, period, status: { $ne: "cancelled" } });

    return {
        name: "Callback: 20 parallel requests, one period",
        target: `${date} ${period} (capacity ${capacity}, ${remaining} left)`,
        expected: remaining,
        successes,
        counts: tally(results),
        database: `counter ${bucketBefore?.booked ?? 0} -> ${bucketAfter?.booked ?? 0}, ${requestsAfter - requestsBefore} new request document(s)`,
        passed:
            successes === remaining &&
            (bucketAfter?.booked ?? 0) === (bucketBefore?.booked ?? 0) + remaining &&
            requestsAfter - requestsBefore === remaining,
    };
};

const loadModels = async () => {
    const [{ VmBooking }, { VmSlot }, { CallbackBucket }, { CallbackRequest }, settingsModule] = await Promise.all([
        import("../src/models/vmBooking.model.js"),
        import("../src/models/vmSlot.model.js"),
        import("../src/models/callbackBucket.model.js"),
        import("../src/models/callbackRequest.model.js"),
        import("../src/models/settings.model.js"),
    ]);
    return {
        VmBooking, VmSlot, CallbackBucket, CallbackRequest,
        Settings: settingsModule.Settings,
        SETTINGS_KEY: settingsModule.SETTINGS_KEY,
    };
};

/**
 * Runs both checks and returns [{ name, target, expected, successes, counts, database, passed }].
 * Throws CheckError when it cannot run. Options exist so tests can point it at another server.
 */
const runConcurrencyCheck = async ({
    baseUrl,
    bookingTokenSecret = process.env.BOOKING_TOKEN_SECRET,
    captchaToken = "concurrency-check",
    nodeEnv = process.env.NODE_ENV,
    mongoUri = process.env.MONGODB_URI,
    now = new Date(),
} = {}) => {
    if (nodeEnv === "production") {
        throw new CheckError("Refusing to run: NODE_ENV=production. This check writes test bookings and requests.");
    }
    if (!baseUrl) throw new CheckError("No target server URL.");
    let host;
    try {
        host = new URL(baseUrl).hostname;
    } catch {
        throw new CheckError(`Not a valid URL: ${baseUrl}`);
    }
    if (!LOOPBACK_HOSTS.has(host)) {
        throw new CheckError(`Refusing to run against ${host}: only localhost, 127.0.0.1 and ::1 are allowed.`);
    }
    if (typeof bookingTokenSecret !== "string" || bookingTokenSecret.length < 32) {
        throw new CheckError("BOOKING_TOKEN_SECRET is missing or shorter than 32 characters (set it in .env).");
    }

    const ownsConnection = mongoose.connection.readyState !== 1;
    if (ownsConnection) {
        if (!mongoUri) throw new CheckError("MONGODB_URI is missing (set it in .env).");
        await mongoose.connect(mongoUri);
    }

    try {
        const models = await loadModels();
        const today = nowIST(now).dateKey;
        const range = { from: today, to: addDays(today, LOOKAHEAD_DAYS) };
        const runId = `${Date.now().toString(36)}`;

        const vm = await checkVmSlot({ baseUrl, bookingTokenSecret, models, runId, ...range });
        const callback = await checkCallbackPeriod({ baseUrl, captchaToken, models, runId, ...range });
        return [vm, callback];
    } finally {
        if (ownsConnection) await mongoose.disconnect();
    }
};

const print = (results) => {
    for (const result of results) {
        console.log(`\n${result.passed ? "PASS" : "FAIL"}  ${result.name}`);
        console.log(`      target:    ${result.target}`);
        console.log(`      successes: ${result.successes} (expected ${result.expected})`);
        console.log(`      answers:   ${JSON.stringify(result.counts)}`);
        console.log(`      database:  ${result.database}`);
    }
    console.log("");
};

const main = async () => {
    await import("dotenv/config");   // only when run as a command; importing this file loads nothing

    const urlFlag = process.argv.indexOf("--url");
    const baseUrl =
        (urlFlag !== -1 ? process.argv[urlFlag + 1] : undefined) ??
        process.env.CHECK_BASE_URL ??
        `http://localhost:${process.env.PORT || 8000}`;

    try {
        const results = await runConcurrencyCheck({ baseUrl });
        print(results);

        const limited = results.some((r) => Object.keys(r.counts).some((key) => key.startsWith("429")));
        const captcha = results.some((r) => Object.keys(r.counts).some((key) => key.includes("CAPTCHA_FAILED")));
        if (limited) console.log("Some requests were rate limited (429). Start the server with NODE_ENV=test so the limiters are off.");
        if (captcha) console.log("Turnstile rejected the requests. Set TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA for this run.");

        process.exitCode = results.every((r) => r.passed) ? 0 : 1;
    } catch (error) {
        if (error instanceof CheckError) {
            console.error(`concurrency-check: ${error.message}`);
        } else {
            const reason = error?.cause?.code ?? error?.code ?? error?.name ?? "error";
            console.error(`concurrency-check: could not complete (${reason}). Is the server running at ${baseUrl}?`);
        }
        process.exitCode = 2;
    }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}

export { runConcurrencyCheck, CheckError };
