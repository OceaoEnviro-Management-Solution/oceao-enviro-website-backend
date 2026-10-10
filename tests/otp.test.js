import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import {
    startTestEnv,
    stopTestEnv,
    resetState,
    getApp,
    emailOutbox,
    rateLimiting,
    TEST_OTP_SECRET,
    TEST_BOOKING_TOKEN_SECRET,
    TEST_COMPANY_MAIL,
} from "./helpers/setup.js";

const SEND = "/api/v1/vm/otp/send";
const VERIFY = "/api/v1/vm/otp/verify";
const EMAIL = "rahul@example.com";

let OtpChallenge;
let VmBooking;

const send = (email = EMAIL) => request(getApp()).post(SEND).send({ email });
const verify = (otp, email = EMAIL) => request(getApp()).post(VERIFY).send({ email, otp: String(otp) });

// The code only ever appears inside the email.
const lastCode = () => {
    const mails = emailOutbox.all();
    const match = /verification code is: (\d{6})/.exec(mails[mails.length - 1].text);
    assert.ok(match, "the OTP email contains a 6-digit code");
    return match[1];
};
const wrongCodeFor = (code) => (code === "000000" ? "111111" : "000000");

const hmac = (email, code) =>
    crypto.createHmac("sha256", TEST_OTP_SECRET).update(`${email}:${code}`).digest("hex");

const challenge = (email = EMAIL) => OtpChallenge.findOne({ email }).lean();

// Moves the stored timestamps back so a test does not have to wait.
const rewind = async ({ lastSentMs = 0, windowMs = 0, codeExpiredMs = 0 }, email = EMAIL) => {
    const doc = await challenge(email);
    await OtpChallenge.updateOne(
        { email },
        {
            $set: {
                lastSentAt: new Date(doc.lastSentAt.getTime() - lastSentMs),
                windowStartedAt: new Date(doc.windowStartedAt.getTime() - windowMs),
                ...(codeExpiredMs ? { codeExpiresAt: new Date(Date.now() - codeExpiredMs) } : {}),
            },
        }
    );
};
const pastCooldown = (email) => rewind({ lastSentMs: 61 * 1000 }, email);

describe("virtual meeting OTP", () => {
    before(async () => {
        await startTestEnv();
        ({ OtpChallenge } = await import("../src/models/otpChallenge.model.js"));
        ({ VmBooking } = await import("../src/models/vmBooking.model.js"));
    });
    after(stopTestEnv);
    beforeEach(resetState);

    describe("POST /vm/otp/send", () => {
        it("sends a 6-digit code by email and stores only its HMAC", async () => {
            const res = await send();

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { expiresInSec: 300, resendAfterSec: 60 });
            assert.equal(res.body.success, true);

            const mails = emailOutbox.all();
            assert.equal(mails.length, 1);
            assert.equal(mails[0].to, EMAIL);
            assert.equal(mails[0].replyTo, undefined);
            const code = lastCode();
            assert.match(code, /^\d{6}$/);
            assert.ok(mails[0].html.includes(code));
            assert.equal(mails[0].subject.includes(code), false, "no code in the subject");

            const doc = await challenge();
            assert.equal(doc.codeHash, hmac(EMAIL, code), "stores HMAC-SHA256(OTP_SECRET, email:code)");
            assert.match(doc.codeHash, /^[0-9a-f]{64}$/);
            for (const [key, value] of Object.entries(doc)) {
                assert.notEqual(String(value), code, `no plaintext code in field ${key}`);
            }
            assert.equal(doc.attempts, 0);
            assert.equal(doc.sendCount, 1);
        });

        it("is valid for 5 minutes and the window lasts one hour", async () => {
            const before = Date.now();
            await send();
            const doc = await challenge();

            const validFor = doc.codeExpiresAt.getTime() - before;
            assert.ok(validFor >= 299000 && validFor <= 302000, `valid for ${validFor} ms`);
            const windowFor = doc.expireAt.getTime() - doc.windowStartedAt.getTime();
            assert.equal(windowFor, 60 * 60 * 1000);
        });

        it("normalizes the email", async () => {
            const res = await send("  RAHUL@Example.COM ");

            assert.equal(res.status, 200);
            assert.equal(emailOutbox.all()[0].to, "rahul@example.com");
            assert.ok(await challenge("rahul@example.com"));
        });

        it("rejects an invalid email with VALIDATION_FAILED", async () => {
            for (const body of [{}, { email: "" }, { email: "not-an-email" }, { email: 42 }, { email: "a@b" }]) {
                const res = await request(getApp()).post(SEND).send(body);

                assert.equal(res.status, 400, JSON.stringify(body));
                assert.equal(res.body.code, "VALIDATION_FAILED");
                assert.ok(Array.isArray(res.body.errors.email));
            }
            assert.equal(emailOutbox.all().length, 0);
        });

        it("answers identically whether or not the email has booked before", async () => {
            await VmBooking.create({
                bookingId: "OE-VM-261015-K7Q2", date: "2099-10-15", time: "10:00", name: "Rahul Kumar",
                email: "booked@example.com", mobileNumber: "+919876543210", status: "confirmed",
                expireAt: new Date(Date.now() + 86400000),
            });

            const existing = await send("booked@example.com");
            const fresh = await send("new@example.com");

            assert.equal(existing.status, fresh.status);
            assert.deepEqual(existing.body, fresh.body);
        });

        it("enforces the 60 second cooldown with retryAfterSec", async () => {
            await send();
            const firstCode = lastCode();

            const res = await send();

            assert.equal(res.status, 429);
            assert.equal(res.body.code, "OTP_COOLDOWN");
            assert.equal(res.body.success, false);
            assert.ok(res.body.errors.retryAfterSec >= 1 && res.body.errors.retryAfterSec <= 60);
            assert.equal(emailOutbox.all().length, 1, "no second email");
            assert.equal((await challenge()).codeHash, hmac(EMAIL, firstCode), "the original code is untouched");
        });

        it("after the cooldown a new code replaces the old one and resets attempts", async () => {
            await send();
            const oldCode = lastCode();
            await verify(wrongCodeFor(oldCode));
            await verify(wrongCodeFor(oldCode));
            assert.equal((await challenge()).attempts, 2);

            await pastCooldown();
            const res = await send();
            const newCode = lastCode();

            assert.equal(res.status, 200);
            const doc = await challenge();
            assert.equal(doc.attempts, 0, "a new code resets attempts");
            assert.equal(doc.sendCount, 2);
            assert.equal(doc.codeHash, hmac(EMAIL, newCode));
            if (newCode !== oldCode) {
                const stale = await verify(oldCode);
                assert.equal(stale.status, 400);
                assert.equal(stale.body.code, "OTP_INVALID");
            }
        });

        it("allows 5 sends per hour and then answers OTP_SEND_LIMIT", async () => {
            for (let i = 1; i <= 5; i++) {
                const res = await send();
                assert.equal(res.status, 200, `send ${i}`);
                await pastCooldown();
            }

            const res = await send();

            assert.equal(res.status, 429);
            assert.equal(res.body.code, "OTP_SEND_LIMIT");
            assert.ok(res.body.errors.retryAfterSec > 3000 && res.body.errors.retryAfterSec <= 3600,
                `retryAfterSec ${res.body.errors.retryAfterSec}`);
            assert.equal(emailOutbox.all().length, 5);
            assert.equal((await challenge()).sendCount, 5);
        });

        it("reports the hourly limit rather than the cooldown right after the 5th send", async () => {
            for (let i = 1; i <= 4; i++) {
                await send();
                await pastCooldown();
            }
            await send();   // 5th

            const res = await send();   // immediately: both limits apply

            assert.equal(res.body.code, "OTP_SEND_LIMIT");
        });

        it("starts a new window once the hour has passed", async () => {
            for (let i = 1; i <= 5; i++) {
                await send();
                await pastCooldown();
            }
            assert.equal((await send()).body.code, "OTP_SEND_LIMIT");

            await rewind({ windowMs: 61 * 60 * 1000, lastSentMs: 61 * 60 * 1000 });
            const res = await send();

            assert.equal(res.status, 200);
            assert.equal((await challenge()).sendCount, 1, "the send count starts again");
        });

        it("returns 502 EMAIL_SEND_FAILED and does not count a failed send", async () => {
            emailOutbox.failNext("customer");

            const failed = await send();

            assert.equal(failed.status, 502);
            assert.equal(failed.body.code, "EMAIL_SEND_FAILED");
            assert.doesNotMatch(JSON.stringify(failed.body), /Simulated|stack/);
            assert.equal(await challenge(), null, "nothing stored for a code nobody received");

            const retry = await send();   // no cooldown to wait out
            assert.equal(retry.status, 200);
            assert.equal((await challenge()).sendCount, 1);
        });

        it("a failed re-send keeps the previous code usable", async () => {
            await send();
            const firstCode = lastCode();
            await pastCooldown();
            emailOutbox.failNext("customer");

            const failed = await send();
            assert.equal(failed.status, 502);

            const doc = await challenge();
            assert.equal(doc.codeHash, hmac(EMAIL, firstCode));
            assert.equal(doc.sendCount, 1);

            const ok = await verify(firstCode);
            assert.equal(ok.status, 200);
        });

        it("applies the IP limiter: 10 per 15 minutes", async () => {
            rateLimiting.enable();

            for (let i = 1; i <= 10; i++) {
                const res = await send(`user${i}@example.com`);
                assert.equal(res.status, 200, `request ${i}`);
            }
            const limited = await send("user11@example.com");

            assert.equal(limited.status, 429);
            assert.equal(limited.body.code, "RATE_LIMITED");
            assert.ok(limited.headers["retry-after"]);
        });

        it("lets only one of several parallel sends through", async () => {
            const results = await Promise.all(Array.from({ length: 6 }, () => send()));

            const ok = results.filter((r) => r.status === 200);
            const cooled = results.filter((r) => r.status === 429 && r.body.code === "OTP_COOLDOWN");
            assert.equal(ok.length, 1);
            assert.equal(cooled.length, 5);
            assert.equal(emailOutbox.all().length, 1);
            assert.equal((await challenge()).sendCount, 1);
        });
    });

    describe("POST /vm/otp/verify", () => {
        it("returns a 30 minute HS256 booking token and consumes the code", async () => {
            await send();
            const code = lastCode();

            const res = await verify(code);

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(res.body.data.expiresInSec, 1800);
            const token = res.body.data.bookingToken;
            assert.equal(typeof token, "string");

            const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
            assert.equal(header.alg, "HS256");
            const payload = jwt.verify(token, TEST_BOOKING_TOKEN_SECRET, { algorithms: ["HS256"] });
            assert.equal(payload.sub, EMAIL);
            assert.equal(payload.purpose, "vm-booking");
            assert.equal(payload.exp - payload.iat, 1800);
            assert.equal(await challenge(), null, "the code is cleared");
        });

        it("a code cannot be used twice", async () => {
            await send();
            const code = lastCode();
            assert.equal((await verify(code)).status, 200);

            const again = await verify(code);

            assert.equal(again.status, 400);
            assert.equal(again.body.code, "OTP_NOT_FOUND");
        });

        it("answers OTP_NOT_FOUND when no code was requested", async () => {
            const res = await verify("123456");

            assert.equal(res.status, 400);
            assert.equal(res.body.code, "OTP_NOT_FOUND");
            assert.equal(res.body.success, false);
        });

        it("a code for one email does not work for another", async () => {
            await send("a@example.com");
            const code = lastCode();

            const res = await verify(code, "b@example.com");

            assert.equal(res.body.code, "OTP_NOT_FOUND");
        });

        it("counts down attemptsLeft and locks on the 5th wrong attempt", async () => {
            await send();
            const wrong = wrongCodeFor(lastCode());

            const left = [];
            for (let i = 1; i <= 4; i++) {
                const res = await verify(wrong);
                assert.equal(res.status, 400, `attempt ${i}`);
                assert.equal(res.body.code, "OTP_INVALID");
                left.push(res.body.errors.attemptsLeft);
            }
            assert.deepEqual(left, [4, 3, 2, 1]);

            const fifth = await verify(wrong);
            assert.equal(fifth.status, 429);
            assert.equal(fifth.body.code, "OTP_LOCKED");
        });

        it("stays locked even for the correct code until a new code is requested", async () => {
            await send();
            const code = lastCode();
            for (let i = 0; i < 5; i++) await verify(wrongCodeFor(code));

            const locked = await verify(code);
            assert.equal(locked.status, 429);
            assert.equal(locked.body.code, "OTP_LOCKED");

            await pastCooldown();
            await send();
            const fresh = lastCode();
            const ok = await verify(fresh);
            assert.equal(ok.status, 200);
        });

        it("accepts the correct code on the 5th attempt", async () => {
            await send();
            const code = lastCode();
            for (let i = 0; i < 4; i++) await verify(wrongCodeFor(code));

            const res = await verify(code);

            assert.equal(res.status, 200);
        });

        it("answers 410 OTP_EXPIRED for an expired code", async () => {
            await send();
            const code = lastCode();
            await rewind({ codeExpiredMs: 1000 });

            const res = await verify(code);

            assert.equal(res.status, 410);
            assert.equal(res.body.code, "OTP_EXPIRED");
        });

        it("rejects a malformed code with VALIDATION_FAILED", async () => {
            for (const otp of ["12345", "1234567", "abcdef", "12 456", ""]) {
                const res = await verify(otp);

                assert.equal(res.status, 400, JSON.stringify(otp));
                assert.equal(res.body.code, "VALIDATION_FAILED");
                assert.ok(Array.isArray(res.body.errors.otp));
            }
            const asNumber = await request(getApp()).post(VERIFY).send({ email: EMAIL, otp: 123456 });
            assert.equal(asNumber.body.code, "VALIDATION_FAILED");
        });

        it("keeps a leading zero in the code", async () => {
            await send();
            const code = "012345";
            await OtpChallenge.updateOne({ email: EMAIL }, { $set: { codeHash: hmac(EMAIL, code) } });

            const res = await verify(code);

            assert.equal(res.status, 200);
        });

        it("cannot be guessed past 5 attempts, even in parallel", async () => {
            await send();
            const wrong = wrongCodeFor(lastCode());

            const results = await Promise.all(Array.from({ length: 30 }, () => verify(wrong)));

            assert.equal(results.filter((r) => r.status === 200).length, 0);
            assert.ok(results.filter((r) => r.body.code === "OTP_INVALID").length <= 4);
            assert.equal((await challenge()).attempts, 5, "no more than the allowed attempts are ever recorded");
        });

        it("two parallel verifications of the right code: exactly one succeeds", async () => {
            await send();
            const code = lastCode();

            const results = await Promise.all([verify(code), verify(code), verify(code)]);

            assert.equal(results.filter((r) => r.status === 200).length, 1);
            assert.equal(results.filter((r) => r.body.code === "OTP_NOT_FOUND").length, 2);
        });

        it("applies the IP limiter: 10 per 15 minutes", async () => {
            rateLimiting.enable();

            for (let i = 1; i <= 10; i++) {
                assert.equal((await verify("123456", `user${i}@example.com`)).status, 400, `request ${i}`);
            }
            const limited = await verify("123456", "user11@example.com");

            assert.equal(limited.status, 429);
            assert.equal(limited.body.code, "RATE_LIMITED");
        });
    });

    describe("requireBookingToken middleware", () => {
        let probe;
        let errorHandler;

        before(async () => {
            const { requireBookingToken } = await import("../src/middlewares/requireBookingToken.js");
            ({ errorHandler } = await import("../src/middlewares/error.middleware.js"));

            probe = express();
            probe.get("/protected", requireBookingToken, (req, res) => res.json({ email: req.verifiedEmail }));
            probe.use(errorHandler);
        });

        const sign = (claims, options = {}, secret = TEST_BOOKING_TOKEN_SECRET) =>
            jwt.sign(claims, secret, { algorithm: "HS256", expiresIn: 1800, ...options });
        const call = (authorization) => {
            const req = request(probe).get("/protected");
            return authorization === undefined ? req : req.set("Authorization", authorization);
        };
        const expectRejected = (res) => {
            assert.equal(res.status, 401);
            assert.equal(res.body.success, false);
            assert.equal(res.body.code, "BOOKING_TOKEN_INVALID");
            assert.equal(typeof res.body.message, "string");
            assert.deepEqual(res.body.errors, {});
        };

        it("accepts a valid token and sets req.verifiedEmail", async () => {
            const res = await call(`Bearer ${sign({ sub: EMAIL, purpose: "vm-booking" })}`);

            assert.equal(res.status, 200);
            assert.deepEqual(res.body, { email: EMAIL });
        });

        it("accepts the token issued by POST /vm/otp/verify", async () => {
            await send();
            const issued = (await verify(lastCode())).body.data.bookingToken;

            const res = await call(`Bearer ${issued}`);

            assert.equal(res.status, 200);
            assert.equal(res.body.email, EMAIL);
        });

        it("rejects a missing Authorization header", async () => {
            expectRejected(await call(undefined));
        });

        it("rejects other schemes, a missing token and extra parts", async () => {
            const good = sign({ sub: EMAIL, purpose: "vm-booking" });
            for (const header of ["", "Bearer", "Bearer ", `Basic ${good}`, good, `Bearer ${good} extra`]) {
                expectRejected(await call(header));
            }
        });

        it("rejects an expired token", async () => {
            const expired = sign({ sub: EMAIL, purpose: "vm-booking" }, { expiresIn: -10 });

            expectRejected(await call(`Bearer ${expired}`));
        });

        it("rejects a token with the wrong or missing purpose", async () => {
            expectRejected(await call(`Bearer ${sign({ sub: EMAIL, purpose: "admin" })}`));
            expectRejected(await call(`Bearer ${sign({ sub: EMAIL })}`));
        });

        it("rejects a token without a subject", async () => {
            expectRejected(await call(`Bearer ${sign({ purpose: "vm-booking" })}`));
            expectRejected(await call(`Bearer ${sign({ sub: "", purpose: "vm-booking" })}`));
        });

        it("rejects a token signed with another secret, another algorithm, or none", async () => {
            const claims = { sub: EMAIL, purpose: "vm-booking" };

            expectRejected(await call(`Bearer ${sign(claims, {}, "x".repeat(40))}`));
            expectRejected(await call(`Bearer ${jwt.sign(claims, TEST_BOOKING_TOKEN_SECRET, { algorithm: "HS512", expiresIn: 60 })}`));
            const unsigned = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ ...claims, exp: 9999999999 })).toString("base64url")}.`;
            expectRejected(await call(`Bearer ${unsigned}`));
        });

        it("rejects garbage", async () => {
            for (const token of ["abc", "a.b.c", "....", "null"]) {
                expectRejected(await call(`Bearer ${token}`));
            }
        });
    });

    describe("logging (C7)", () => {
        const emailServices = pathToFileURL(
            fileURLToPath(new URL("../src/services/email/email.services.js", import.meta.url))
        ).href;

        const logsFor = (nodeEnv, emailMode) => {
            const script = `
                import { sendMailService } from ${JSON.stringify(emailServices)};
                await sendMailService({ from: "a@b.c", to: "customer@example.com", subject: "Your code",
                    text: "Your Oceao Enviro verification code is: 482913", html: "<p>482913</p>" });
            `;
            const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
                encoding: "utf8",
                env: {
                    PATH: process.env.PATH,
                    SystemRoot: process.env.SystemRoot,
                    NODE_ENV: nodeEnv,
                    EMAIL_MODE: emailMode,
                    MONGODB_URI: "mongodb://127.0.0.1:27017",
                    CORS_ORIGINS: "http://localhost:5173",
                    MAIL_FROM: "a@b.c",
                    COMPANY_MAIL: TEST_COMPANY_MAIL,
                    OTP_SECRET: TEST_OTP_SECRET,
                    BOOKING_TOKEN_SECRET: TEST_BOOKING_TOKEN_SECRET,
                },
            });
            assert.equal(result.status, 0, result.stderr);
            return `${result.stdout}\n${result.stderr}`;
        };

        it("EMAIL_MODE=log in development prints the plain-text body (so the OTP can be read)", () => {
            const output = logsFor("development", "log");

            assert.match(output, /Email \(log mode\)/);
            assert.match(output, /verification code is: 482913/);
        });

        it("EMAIL_MODE=log anywhere else prints only the recipient and subject", () => {
            for (const env of ["test", "production"]) {
                const output = logsFor(env, "log");

                assert.match(output, /Email \(log mode\)/, env);
                assert.match(output, /customer@example\.com/, env);
                assert.match(output, /Your code/, env);
                assert.doesNotMatch(output, /482913/, `${env} must not print the body`);
            }
        });
    });
});
