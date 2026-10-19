// Stage 6.1: security and operations baseline (docs/SECURITY_CHECKLIST.md, items C1 to C8).

import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import request from "supertest";
import {
    startTestEnv, stopTestEnv, resetState, getApp, rateLimiting, emailOutbox,
    TEST_ADMIN_PASSWORD_HASH, TEST_ADMIN_JWT_SECRET, TEST_ADMIN_ENV, TEST_ORIGIN,
    TEST_BOOKING_TOKEN_SECRET, TEST_OTP_SECRET, TEST_CAPTCHA_TOKEN,
} from "./helpers/setup.js";
import { OtpChallenge } from "../src/models/otpChallenge.model.js";
import { VmSlot } from "../src/models/vmSlot.model.js";
import { VmBooking } from "../src/models/vmBooking.model.js";
import { Holiday } from "../src/models/holiday.model.js";
import { addDays, dayOfWeek, nowIST } from "../src/utils/time.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC_DIR = path.join(ROOT, "src");
const SRC = (file) => pathToFileURL(path.join(SRC_DIR, file)).href;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADMIN = "/api/v1/admin";

const passwordVersion = crypto.createHash("sha256").update(TEST_ADMIN_PASSWORD_HASH).digest("hex").slice(0, 12);
const adminCookie = () =>
    `oe_admin=${jwt.sign({ sub: "admin", pwv: passwordVersion }, TEST_ADMIN_JWT_SECRET, { algorithm: "HS256", expiresIn: 3600 })}`;

// A session, the allowed Origin and a JSON body: what the admin UI sends.
const adminGet = (url) => request(getApp()).get(url).set("Cookie", adminCookie());
const adminSend = (method, url, body) =>
    request(getApp())[method](url).set("Cookie", adminCookie()).set("Origin", TEST_ORIGIN).send(body);

const nextWeekday = (offset = 3) => {
    let date = addDays(nowIST().dateKey, offset);
    while (dayOfWeek(date) === 0 || dayOfWeek(date) === 6) date = addDays(date, 1);
    return date;
};

const capture = (stream) => mock.method(console, stream, () => {});
const lines = (spy) => spy.mock.calls.map((call) => call.arguments.map(String).join(" "));

const isStrictObject = (schema) => {
    let current = schema;
    while (current?._zod?.def?.type === "pipe") current = current._zod.def.in;
    return current?._zod?.def?.type === "object" && current._zod.def.catchall?._zod?.def?.type === "never";
};

describe("Security baseline", () => {
    let routers;

    before(async () => {
        await startTestEnv();
        routers = {
            query: (await import("../src/routes/query.route.js")).queryRouter,
            feedback: (await import("../src/routes/feedback.route.js")).feedbackRouter,
            vm: (await import("../src/routes/vm.route.js")).vmRouter,
            callback: (await import("../src/routes/callback.route.js")).callbackRouter,
            admin: (await import("../src/routes/admin.route.js")).adminRouter,
            visits: (await import("../src/routes/visits.route.js")).visitsRouter,
            aqi: (await import("../src/routes/aqi.route.js")).aqiRouter,
            updates: (await import("../src/routes/updates.route.js")).updatesRouter,
            hero: (await import("../src/routes/hero.route.js")).heroRouter,
        };
    });
    after(stopTestEnv);
    beforeEach(resetState);
    afterEach(() => mock.restoreAll());

    // ── C1 ────────────────────────────────────────────────────────────────────────
    describe("C1: validated input, strict schemas", () => {
        it("every route validates the parts it reads, and every schema is .strict()", () => {
            const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
            let routeCount = 0;
            const problems = [];

            for (const [routerName, router] of Object.entries(routers)) {
                for (const layer of router.stack.filter((item) => item.route)) {
                    for (const method of Object.keys(layer.route.methods).map((m) => m.toUpperCase())) {
                        routeCount++;
                        const label = `${method} ${routerName} ${layer.route.path}`;
                        const checks = layer.route.stack.map((item) => item.handle).filter((fn) => fn.validates);
                        const validated = new Set(checks.map((fn) => fn.validates));

                        if (WRITES.has(method) && !validated.has("body")) problems.push(`${label}: body not validated`);
                        if (method === "GET" && !validated.has("query")) problems.push(`${label}: query not validated`);
                        if (layer.route.path.includes(":") && !validated.has("params")) {
                            problems.push(`${label}: params not validated`);
                        }
                        for (const fn of checks) {
                            if (!isStrictObject(fn.schema)) problems.push(`${label}: ${fn.validates} schema is not .strict()`);
                        }
                    }
                }
            }

            assert.ok(routeCount >= 30, `the audit saw ${routeCount} routes`);
            assert.deepEqual(problems, []);
        });

        it("the holiday list items are strict too", async () => {
            const { holidayBulkSchema } = await import("../src/validators/adminCallback.validator.js");
            const base = { performedBy: "Anita", reason: "Festival" };

            assert.equal(holidayBulkSchema.safeParse({ ...base, holidays: [{ date: "2030-01-26", name: "Republic Day" }] }).success, true);
            assert.equal(
                holidayBulkSchema.safeParse({ ...base, holidays: [{ date: "2030-01-26", name: "Republic Day", extra: 1 }] }).success,
                false
            );
        });

        it("public route: { $gt: '' } as the email is 400 and never reaches Mongo", async () => {
            const find = mock.method(OtpChallenge, "findOne");
            const update = mock.method(OtpChallenge, "findOneAndUpdate");

            const res = await request(getApp()).post("/api/v1/vm/otp/send").send({ email: { $gt: "" } });

            assert.equal(res.status, 400);
            assert.equal(res.body.code, "VALIDATION_FAILED");
            assert.ok(res.body.errors.email);
            assert.equal(find.mock.callCount() + update.mock.callCount(), 0);
        });

        it("public route: a query-string operator is 400", async () => {
            const res = await request(getApp()).get("/api/v1/vm/availability?date[$gt]=");

            assert.equal(res.status, 400);
            assert.equal(res.body.code, "VALIDATION_FAILED");
        });

        it("admin login: { $gt: '' } as email and password is 400, not a failed login, and sets no cookie", async () => {
            const res = await request(getApp())
                .post(`${ADMIN}/auth/login`)
                .set("Origin", TEST_ORIGIN)
                .send({ email: { $gt: "" }, password: { $gt: "" } });

            assert.equal(res.status, 400);
            assert.equal(res.body.code, "VALIDATION_FAILED");
            assert.equal(res.headers["set-cookie"], undefined);
        });

        it("admin write with a session: operators in every field are 400 and no query runs", async () => {
            const spies = [
                mock.method(VmSlot, "findOneAndUpdate"),
                mock.method(VmSlot, "updateOne"),
                mock.method(VmSlot, "create"),
                mock.method(VmBooking, "findOne"),
            ];

            const res = await adminSend("post", `${ADMIN}/vm/blocks`, {
                date: { $gt: "" },
                time: { $ne: null },
                performedBy: { $gt: "" },
                reason: { $regex: ".*" },
            });

            assert.equal(res.status, 400);
            assert.equal(res.body.code, "VALIDATION_FAILED");
            assert.equal(spies.reduce((sum, spy) => sum + spy.mock.callCount(), 0), 0);
        });

        it("admin read with a session: an operator in the query string is 400", async () => {
            const res = await adminGet(`${ADMIN}/bookings?from[$gt]=&to=2030-01-02`);

            assert.equal(res.status, 400);
            assert.equal(res.body.code, "VALIDATION_FAILED");
        });

        it("admin path parameter: an encoded operator is 400", async () => {
            const res = await adminSend("patch", `${ADMIN}/holidays/%7B%22%24gt%22%3A%22%22%7D`, {
                name: "Diwali", performedBy: "Anita", reason: "Rename",
            });

            assert.equal(res.status, 400);
            assert.equal(res.body.code, "VALIDATION_FAILED");
        });

        it("an unknown body key is 400 on public and admin routes", async () => {
            const publicRes = await request(getApp()).post("/api/v1/vm/otp/send").send({ email: "a@example.com", extra: 1 });
            const adminRes = await adminSend("post", `${ADMIN}/vm/blocks`, {
                date: nextWeekday(), allDay: true, performedBy: "Anita", reason: "Closed", isAdmin: true,
            });

            assert.equal(publicRes.status, 400);
            assert.deepEqual(publicRes.body.errors, { extra: ["Unexpected field"] });
            assert.equal(adminRes.status, 400);
            assert.deepEqual(adminRes.body.errors, { isAdmin: ["Unexpected field"] });
        });

        it("an unknown query key is 400 on public routes and on the no-input admin routes", async () => {
            const availability = await request(getApp()).get(`/api/v1/vm/availability?date=${nextWeekday()}&debug=1`);
            const me = await adminGet(`${ADMIN}/auth/me?x=1`);
            const settings = await adminGet(`${ADMIN}/settings?x=1`);
            const logout = await adminSend("post", `${ADMIN}/auth/logout`, { x: 1 });

            assert.equal(availability.status, 400);
            assert.equal(me.status, 400);
            assert.equal(settings.status, 400);
            assert.equal(logout.status, 400);
        });

        it("the no-input admin routes still work with nothing sent", async () => {
            assert.equal((await adminGet(`${ADMIN}/auth/me`)).status, 200);
            assert.equal((await adminGet(`${ADMIN}/settings`)).status, 200);
            assert.equal((await adminSend("post", `${ADMIN}/auth/logout`, {})).status, 200);
        });

        it("an `email` in the VM booking body is accepted and discarded (the token decides)", async () => {
            const { createVmBookingSchema } = await import("../src/validators/vmBooking.validator.js");

            const parsed = createVmBookingSchema.parse({
                email: "someone.else@example.com",
                name: "Rahul Kumar",
                mobileNumber: "9876543210",
                date: nextWeekday(),
                time: "10:00",
            });

            assert.equal("email" in parsed, false);
            assert.equal(parsed.name, "Rahul Kumar");
        });
    });

    // ── C2 ────────────────────────────────────────────────────────────────────────
    describe("C2: rate limiters", () => {
        beforeEach(() => rateLimiting.enable());

        const exhaust = async (send, limit) => {
            for (let i = 1; i <= limit; i++) {
                const res = await send();
                assert.notEqual(res.status, 429, `request ${i} of ${limit} must not be limited`);
            }
            const over = await send();
            assert.equal(over.status, 429);
            assert.equal(over.body.code, "RATE_LIMITED");
            assert.ok(over.headers["retry-after"], "Retry-After is set");
        };

        it("public forms: one counter is shared by query, feedback and callback", async () => {
            const app = getApp();
            const sends = [
                () => request(app).post("/api/v1/query/new-query").send({}),
                () => request(app).post("/api/v1/query/new-query").send({}),
                () => request(app).post("/api/v1/callback/requests").send({}),
                () => request(app).post("/api/v1/callback/requests").send({}),
                () => request(app).post("/api/v1/feedback/new-feedback").field("type", "x"),
            ];
            for (const send of sends) assert.notEqual((await send()).status, 429);

            const sixth = await request(app).post("/api/v1/query/new-query").send({});
            assert.equal(sixth.status, 429);
        });

        it("public forms: exactly 5 are allowed", async () => {
            await exhaust(() => request(getApp()).post("/api/v1/callback/requests").send({}), 5);
        });

        it("OTP send: 10 per 15 minutes per IP", async () => {
            await exhaust(() => request(getApp()).post("/api/v1/vm/otp/send").send({}), 10);
        });

        it("OTP verify: 10 per 15 minutes per IP, counted apart from send", async () => {
            await exhaust(() => request(getApp()).post("/api/v1/vm/otp/verify").send({}), 10);

            const send = await request(getApp()).post("/api/v1/vm/otp/send").send({});
            assert.equal(send.status, 400, "send still has its own allowance");
        });

        it("admin login: 5 per 15 minutes per IP", async () => {
            await exhaust(() => request(getApp()).post(`${ADMIN}/auth/login`).send({}), 5);
        });

        it("global /api: 300 per 15 minutes per IP", async () => {
            await exhaust(() => request(getApp()).get("/api/v1/no-such-route"), 300);
        });

        it("/health is outside the limiter", async () => {
            for (let i = 0; i < 310; i++) {
                const res = await request(getApp()).get("/health");
                assert.equal(res.status, 200);
            }
        });
    });

    // ── C3 ────────────────────────────────────────────────────────────────────────
    describe("C3: settings come from config", () => {
        it("the fixed settings live in config/security.js", async () => {
            const { SECURITY } = await import("../src/config/security.js");

            assert.equal(SECURITY.bodyLimit, "20kb");
            assert.deepEqual({ ...SECURITY.upload }, { maxFileBytes: 5 * 1024 * 1024, maxFiles: 1, maxFields: 10, maxFieldBytes: 10 * 1024 });
            assert.deepEqual(
                { ...SECURITY.rateLimits },
                { windowMinutes: 15, publicForms: 5, otpSend: 10, otpVerify: 10, adminLogin: 5, globalApi: 300 }
            );
            assert.equal(Object.isFrozen(SECURITY), true);
        });

        it("a body over 20kb is 413 and one under it is parsed", async () => {
            const big = await request(getApp()).post("/api/v1/vm/otp/send").send({ email: "a".repeat(21 * 1024) });
            const small = await request(getApp()).post("/api/v1/vm/otp/send").send({ email: "a".repeat(5 * 1024) });

            assert.equal(big.status, 413);
            assert.equal(big.body.code, "PAYLOAD_TOO_LARGE");
            assert.equal(small.status, 400);
            assert.equal(small.body.code, "VALIDATION_FAILED");
        });

        it("helmet headers are set and x-powered-by is not", async () => {
            const res = await request(getApp()).get("/health");

            assert.equal(res.headers["x-content-type-options"], "nosniff");
            assert.ok(res.headers["strict-transport-security"]);
            assert.ok(res.headers["x-frame-options"]);
            assert.equal(res.headers["x-powered-by"], undefined);
        });

        it("CORS answers only origins on the allowlist", async () => {
            const allowed = await request(getApp()).get("/health").set("Origin", TEST_ORIGIN);
            const denied = await request(getApp()).get("/health").set("Origin", "http://evil.example");

            assert.equal(allowed.headers["access-control-allow-origin"], TEST_ORIGIN);
            assert.equal(allowed.headers["access-control-allow-credentials"], "true");
            assert.equal(denied.headers["access-control-allow-origin"], undefined);
        });
    });

    // ── C4 ────────────────────────────────────────────────────────────────────────
    describe("C4: nothing sensitive in logs", () => {
        it("the logger redacts tokens, URIs with credentials, phone numbers, OTPs and passwords", async () => {
            const { logger } = await import("../src/utils/logger.js");
            const error = capture("error");
            const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.c2lnbmF0dXJlLXZhbHVl";

            logger.error(
                "failure",
                { token: fakeJwt },
                `Authorization: Bearer abc.def-123 uri=mongodb+srv://user:pa55@cluster.example.net/db`,
                "callback +91 98765 43210 and 9876543210",
                `{"otp":"123456","password":"hunter2"}`,
            );

            const [line] = lines(error);
            for (const secret of [fakeJwt, "abc.def-123", "pa55", "98765 43210", "9876543210", "123456", "hunter2"]) {
                assert.ok(!line.includes(secret), `${secret} must be redacted: ${line}`);
            }
            assert.ok(line.includes("[ERROR]"));
        });

        it("outside a request there is no request ID", async () => {
            const { logger } = await import("../src/utils/logger.js");
            const out = capture("log");

            logger.info("startup");

            assert.doesNotMatch(lines(out)[0], /requestId=/);
        });

        it("development log mode is the only place a message is left untouched", () => {
            const child = spawnSync(
                process.execPath,
                [
                    "--input-type=module",
                    "-e",
                    `const { logger } = await import(${JSON.stringify(SRC("utils/logger.js"))});
                     logger.info("otp=123456");`,
                ],
                { cwd: ROOT, encoding: "utf8", env: childEnv({ NODE_ENV: "development" }) }
            );

            assert.equal(child.status, 0, child.stderr);
            assert.match(child.stdout, /otp=123456/);
        });

        it("no logger or console call in src/ passes request data, credentials or message bodies", () => {
            const FORBIDDEN = /\breq\.(?:body|headers|cookies|query|params|file|ip)\b|\.(?:password|passwd|otp|text|html|body|mobileNumber|mobile|phone|token|headers|cookies)\b|\b(?:password|otp|token|body|html|text|mobileNumber)\b/;
            // The development-only email body is the one allowed exception; its guard is checked below.
            const ALLOWED = [{ file: path.join("services", "email", "email.services.js"), text: "Email body (development only)" }];

            const offenders = [];
            for (const file of walk(SRC_DIR)) {
                const source = fs.readFileSync(file, "utf8");
                for (const call of logCalls(source)) {
                    const expressions = expressionsOf(call);
                    if (!FORBIDDEN.test(expressions)) continue;
                    const relative = path.relative(SRC_DIR, file);
                    if (ALLOWED.some((allowed) => relative === allowed.file && call.includes(allowed.text))) continue;
                    offenders.push(`${relative}: ${call.replace(/\s+/g, " ").slice(0, 120)}`);
                }
            }

            assert.deepEqual(offenders, []);
        });

        it("the development-only email body is guarded by NODE_ENV === 'development'", () => {
            const source = fs.readFileSync(path.join(SRC_DIR, "services", "email", "email.services.js"), "utf8");
            const at = source.indexOf("Email body (development only)");

            assert.ok(at > -1);
            assert.match(source.slice(Math.max(0, at - 160), at), /config\.NODE_ENV === "development"/);
        });

        it("only one place stores a logger method in a variable (the Meet warning)", () => {
            const found = [];
            for (const file of walk(SRC_DIR)) {
                const source = fs.readFileSync(file, "utf8");
                for (const match of source.matchAll(/\blogger\.(?:info|warn|error)\b(?!\s*\()/g)) {
                    found.push(`${path.relative(SRC_DIR, file)}:${match.index}`);
                }
            }

            assert.ok(found.length > 0);
            assert.ok(found.every((place) => /vmBooking\.service\.js/.test(place)), found.join(", "));
        });
    });

    // ── C5 ────────────────────────────────────────────────────────────────────────
    describe("C5: production 500s are generic", () => {
        // The database is never connected in the child and buffering is off, so the first query throws
        // an internal Mongoose error whose message must not reach the client.
        const run = (nodeEnv) => {
            const code = `
                import mongoose from "mongoose";
                mongoose.set("bufferCommands", false);
                const { app } = await import(${JSON.stringify(SRC("app.js"))});
                const { default: request } = await import("supertest");
                const res = await request(app).post("/api/v1/vm/otp/send").send({ email: "someone@example.com" });
                console.log(JSON.stringify({ status: res.status, body: res.body, requestId: res.headers["x-request-id"] }));
                process.exit(0);
            `;
            const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
                cwd: ROOT, encoding: "utf8", env: childEnv({ NODE_ENV: nodeEnv }),
            });
            assert.equal(child.status, 0, child.stderr);
            const line = child.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
            return { ...JSON.parse(line), stderr: child.stderr };
        };

        it("NODE_ENV=production: 500 INTERNAL_ERROR with a generic message and no stack", () => {
            const { status, body, requestId, stderr } = run("production");

            assert.equal(status, 500);
            assert.deepEqual(body, {
                success: false,
                message: "Something went wrong. Please try again later.",
                code: "INTERNAL_ERROR",
                errors: {},
            });
            assert.match(requestId, UUID);

            // The detail is kept server side, under the same request ID.
            assert.match(stderr, new RegExp(`\\[ERROR\\] requestId=${requestId} POST /api/v1/vm/otp/send failed with 500`));
            assert.match(stderr, /\n\s+at /, "the stack is in the server log");
        });

        it("outside production the internal message is still returned (so the test above proves something)", () => {
            const { status, body } = run("test");

            assert.equal(status, 500);
            assert.notEqual(body.message, "Something went wrong. Please try again later.");
        });
    });

    // ── C6 ────────────────────────────────────────────────────────────────────────
    describe("C6: GET /health", () => {
        it("200 { status, db: up, uptime } while mongoose is connected", async () => {
            const res = await request(getApp()).get("/health");

            assert.equal(res.status, 200);
            assert.deepEqual(Object.keys(res.body).sort(), ["db", "status", "uptime"]);
            assert.equal(res.body.status, "ok");
            assert.equal(res.body.db, "up");
            assert.equal(typeof res.body.uptime, "number");
            assert.ok(res.body.uptime >= 0);
        });

        it("503 { db: down } when mongoose readyState is not 1", async () => {
            for (const state of [0, 2, 3]) {
                Object.defineProperty(mongoose.connection, "readyState", { get: () => state, configurable: true });
                try {
                    const res = await request(getApp()).get("/health");

                    assert.equal(res.status, 503, `readyState ${state}`);
                    assert.equal(res.body.db, "down");
                    assert.equal(res.body.status, "unavailable");
                    assert.equal(typeof res.body.uptime, "number");
                } finally {
                    delete mongoose.connection.readyState;
                }
            }
            assert.equal((await request(getApp()).get("/health")).status, 200);
        });
    });

    // ── C7 ────────────────────────────────────────────────────────────────────────
    describe("C7: X-Request-Id", () => {
        it("every response has a fresh UUID, including 400, 401, 404 and 429", async () => {
            rateLimiting.enable();
            const app = getApp();
            const responses = [
                await request(app).get("/health"),
                await request(app).get("/api/v1/nope"),
                await request(app).post("/api/v1/vm/otp/send").send({}),
                await request(app).get(`${ADMIN}/auth/me`),
            ];
            for (let i = 0; i < 5; i++) responses.push(await request(app).post(`${ADMIN}/auth/login`).send({}));
            responses.push(await request(app).post(`${ADMIN}/auth/login`).send({}));

            assert.deepEqual(responses.map((r) => r.status).slice(1, 4), [404, 400, 401]);
            assert.equal(responses.at(-1).status, 429);
            const ids = responses.map((r) => r.headers["x-request-id"]);
            for (const id of ids) assert.match(id, UUID);
            assert.equal(new Set(ids).size, ids.length, "each request gets its own ID");
        });

        it("an X-Request-Id sent by the client is not used", async () => {
            const res = await request(getApp()).get("/health").set("X-Request-Id", "attacker-chosen-id");

            assert.match(res.headers["x-request-id"], UUID);
            assert.notEqual(res.headers["x-request-id"], "attacker-chosen-id");
        });

        it("a 500 is logged with the same request ID that the response carries", async () => {
            const errors = capture("error");
            mock.method(Holiday, "exists", () => {
                throw new Error("simulated internal failure");
            });

            const res = await request(getApp()).get(`/api/v1/vm/availability?date=${nextWeekday()}`);

            assert.equal(res.status, 500);
            const id = res.headers["x-request-id"];
            const line = lines(errors).find((entry) => entry.includes("failed with 500"));
            assert.ok(line, "an error line was logged");
            assert.ok(line.includes(`requestId=${id}`), line);
        });

        it("work started without awaiting (email failure) logs under the request ID too", async () => {
            const errors = capture("error");
            emailOutbox.failNext("customer");

            const res = await request(getApp())
                .post("/api/v1/callback/requests")
                .send({
                    name: "Rahul Kumar",
                    email: "rahul@example.com",
                    mobileNumber: "9876543210",
                    date: nextWeekday(),
                    period: "morning",
                    turnstileToken: TEST_CAPTCHA_TOKEN,
                });
            assert.equal(res.status, 201, JSON.stringify(res.body));
            const id = res.headers["x-request-id"];

            // The confirmation email is sent after the response, so wait for its failure line.
            let line;
            for (let i = 0; i < 50 && !line; i++) {
                line = lines(errors).find((entry) => entry.includes("Email not sent"));
                if (!line) await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assert.ok(line, "the failure was logged");
            assert.ok(line.includes(`requestId=${id}`), line);
        });
    });

    // ── C8 ────────────────────────────────────────────────────────────────────────
    describe("C8: concurrency check", () => {
        const SCRIPT = path.join(ROOT, "scripts", "concurrency-check.js");
        let server;
        let baseUrl;

        before(async () => {
            server = getApp().listen(0, "127.0.0.1");
            await new Promise((resolve) => server.once("listening", resolve));
            baseUrl = `http://127.0.0.1:${server.address().port}`;
        });
        after(() => new Promise((resolve) => server.close(resolve)));

        it("is an npm script", () => {
            const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

            assert.equal(pkg.scripts["check:concurrency"], "node scripts/concurrency-check.js");
        });

        it("20 parallel bookings win once, 20 parallel callbacks win exactly the capacity", async () => {
            const { runConcurrencyCheck } = await import("../scripts/concurrency-check.js");

            const [vm, callback] = await runConcurrencyCheck({
                baseUrl,
                bookingTokenSecret: TEST_BOOKING_TOKEN_SECRET,
                captchaToken: TEST_CAPTCHA_TOKEN,
                nodeEnv: "test",
            });

            assert.equal(vm.successes, 1);
            assert.equal(vm.expected, 1);
            assert.equal(vm.passed, true, JSON.stringify(vm));
            assert.equal(vm.counts["409 SLOT_TAKEN"], 19);

            assert.ok(callback.expected >= 1);
            assert.equal(callback.successes, callback.expected);
            assert.equal(callback.passed, true, JSON.stringify(callback));
            assert.equal(callback.counts["409 PERIOD_FULL"], 20 - callback.expected);
        });

        it("refuses NODE_ENV=production (API and command line)", async () => {
            const { runConcurrencyCheck } = await import("../scripts/concurrency-check.js");

            await assert.rejects(
                runConcurrencyCheck({ baseUrl, bookingTokenSecret: TEST_BOOKING_TOKEN_SECRET, nodeEnv: "production" }),
                /NODE_ENV=production/
            );

            const child = spawnSync(process.execPath, [SCRIPT, "--url", baseUrl], {
                cwd: os.tmpdir(),
                encoding: "utf8",
                env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: "production", BOOKING_TOKEN_SECRET: TEST_BOOKING_TOKEN_SECRET },
            });
            assert.equal(child.status, 2);
            assert.match(child.stderr, /Refusing to run: NODE_ENV=production/);
        });

        it("refuses a server that is not on this machine", async () => {
            const { runConcurrencyCheck } = await import("../scripts/concurrency-check.js");

            await assert.rejects(
                runConcurrencyCheck({ baseUrl: "https://api.example.com", bookingTokenSecret: TEST_BOOKING_TOKEN_SECRET, nodeEnv: "test" }),
                /only localhost/
            );
        });
    });

    // ── C3: trust proxy ───────────────────────────────────────────────────────────
    describe("C3: trust proxy comes from TRUST_PROXY", () => {
        const read = (value) => {
            const code = `
                const { app } = await import(${JSON.stringify(SRC("app.js"))});
                console.log(JSON.stringify(app.get("trust proxy")));
                process.exit(0);
            `;
            const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
                cwd: ROOT, encoding: "utf8", env: childEnv({ TRUST_PROXY: value }),
            });
            assert.equal(child.status, 0, child.stderr);
            return JSON.parse(child.stdout.trim());
        };

        it("defaults to 0 and follows the variable", () => {
            assert.equal(read(undefined), 0);
            assert.equal(read("1"), 1);
        });
    });
});

// ── helpers ─────────────────────────────────────────────────────────────────────
function childEnv(extra = {}) {
    const env = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        NODE_ENV: "test",
        EMAIL_MODE: "test",
        MONGODB_URI: "mongodb://127.0.0.1:27017",
        CORS_ORIGINS: TEST_ORIGIN,
        MAIL_FROM: "Oceao Enviro <no-reply@oceao.test>",
        COMPANY_MAIL: "company@oceao.test",
        OTP_SECRET: TEST_OTP_SECRET,
        BOOKING_TOKEN_SECRET: TEST_BOOKING_TOKEN_SECRET,
        TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
        DATA_GOV_API_KEY: "test-data-gov-api-key",
        CLOUDINARY_CLOUD_NAME: "test-cloud",
        CLOUDINARY_API_KEY: "test-cloudinary-key",
        CLOUDINARY_API_SECRET: "test-cloudinary-secret-0123456789",
        ...TEST_ADMIN_ENV,
        ...extra,
    };
    return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else if (entry.name.endsWith(".js")) yield full;
    }
}

// The text of every logger.* / console.* call (up to the matching parenthesis).
function logCalls(source) {
    const calls = [];
    const start = /\b(?:logger\.(?:info|warn|error)|console\.(?:log|info|warn|error|debug))\s*\(/g;
    for (const match of source.matchAll(start)) {
        let depth = 0;
        let quote = null;
        let end = -1;
        for (let i = match.index + match[0].length - 1; i < source.length; i++) {
            const ch = source[i];
            if (quote) {
                if (ch === "\\") i++;
                else if (ch === quote) quote = null;
                continue;
            }
            if (ch === '"' || ch === "'" || ch === "`") quote = ch;
            else if (ch === "(") depth++;
            else if (ch === ")" && --depth === 0) {
                end = i;
                break;
            }
        }
        if (end > -1) calls.push(source.slice(match.index, end + 1));
    }
    return calls;
}

// What a call evaluates (identifiers and ${} expressions), without the static message text.
function expressionsOf(call) {
    return call
        .replace(/`(?:[^`\\]|\\.)*`/gs, (template) => (template.match(/\$\{[^}]*\}/g) ?? []).join(" "))
        .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}
