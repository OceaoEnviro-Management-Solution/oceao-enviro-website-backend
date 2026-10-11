import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";
import {
    startTestEnv, stopTestEnv, resetState, getApp, rateLimiting,
    TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, TEST_ADMIN_PASSWORD_HASH, TEST_ADMIN_JWT_SECRET,
    TEST_ADMIN_ENV, TEST_ORIGIN, TEST_BOOKING_TOKEN_SECRET, TEST_OTP_SECRET,
} from "./helpers/setup.js";

const BASE = "/api/v1/admin";
const LOGIN = `${BASE}/auth/login`;
const LOGOUT = `${BASE}/auth/logout`;
const ME = `${BASE}/auth/me`;
const COOKIE = "oe_admin";
const EIGHT_HOURS = 8 * 60 * 60;
const FOREIGN_ORIGIN = "http://evil.example";

const pwvOf = (hash) => crypto.createHash("sha256").update(hash).digest("hex").slice(0, 12);
const CURRENT_PWV = pwvOf(TEST_ADMIN_PASSWORD_HASH);

const sign = (payload, { secret = TEST_ADMIN_JWT_SECRET, algorithm = "HS256", ...options } = {}) =>
    jwt.sign(payload, secret, { algorithm, ...options });
const goodToken = (options = {}) => sign({ sub: "admin", pwv: CURRENT_PWV }, { expiresIn: EIGHT_HOURS, ...options });
const asCookie = (token) => `${COOKIE}=${token}`;
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

const app = () => getApp();
const login = (body = {}, origin = TEST_ORIGIN) => {
    const req = request(app()).post(LOGIN);
    if (origin) req.set("Origin", origin);
    return req.send({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD, ...body });
};
const me = (token) => {
    const req = request(app()).get(ME);
    if (token !== undefined) req.set("Cookie", asCookie(token));
    return req;
};
const logout = (token, { origin = TEST_ORIGIN, contentType = "application/json" } = {}) => {
    const req = request(app()).post(LOGOUT);
    if (token !== undefined) req.set("Cookie", asCookie(token));
    if (origin) req.set("Origin", origin);
    if (contentType) req.set("Content-Type", contentType);
    // A JSON content type (with or without a charset) carries a real JSON body.
    return req.send(contentType?.startsWith("application/json") ? "{}" : "x=1");
};

// "oe_admin=abc; Max-Age=28800; Path=/api/v1/admin; HttpOnly; SameSite=Lax" -> { value, flags, attrs }
const parseSetCookie = (header) => {
    const [pair, ...parts] = header.split(";").map((part) => part.trim());
    const eq = pair.indexOf("=");
    const attrs = {};
    const flags = new Set();
    for (const part of parts) {
        const at = part.indexOf("=");
        if (at === -1) flags.add(part.toLowerCase());
        else attrs[part.slice(0, at).toLowerCase()] = part.slice(at + 1);
    }
    return { name: pair.slice(0, eq), value: pair.slice(eq + 1), flags, attrs };
};
const sessionCookie = (res) => {
    const headers = res.headers["set-cookie"] || [];
    assert.equal(headers.length, 1, "exactly one Set-Cookie header");
    return parseSetCookie(headers[0]);
};

const assertUnauthorized = (res) => {
    assert.equal(res.status, 401);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, "ADMIN_UNAUTHORIZED");
};

// Boots src/config/env.js in a child process with the given environment.
const SCRIPT_DIR = fileURLToPath(new URL("../scripts/", import.meta.url));
const SRC = (file) => pathToFileURL(fileURLToPath(new URL(`../src/${file}`, import.meta.url))).href;
const BASE_CHILD_ENV = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: "test",
    EMAIL_MODE: "test",
    MONGODB_URI: "mongodb://127.0.0.1:27017",
    CORS_ORIGINS: TEST_ORIGIN,
    MAIL_FROM: "a@b.c",
    COMPANY_MAIL: "d@e.f",
    OTP_SECRET: TEST_OTP_SECRET,
    BOOKING_TOKEN_SECRET: TEST_BOOKING_TOKEN_SECRET,
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    ...TEST_ADMIN_ENV,
};
const runInChild = (code, env = {}) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        encoding: "utf8",
        env: Object.fromEntries(Object.entries({ ...BASE_CHILD_ENV, ...env }).filter(([, v]) => v !== undefined)),
    });

describe("Admin auth", () => {
    before(startTestEnv);
    after(stopTestEnv);
    beforeEach(resetState);
    afterEach(() => mock.restoreAll());

    describe("POST /admin/auth/login", () => {
        it("success: 200 { email } and an httpOnly session cookie", async () => {
            const res = await login();

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.deepEqual(res.body.data, { email: TEST_ADMIN_EMAIL });

            const cookie = sessionCookie(res);
            assert.equal(cookie.name, COOKIE);
            assert.ok(cookie.value.length > 20);
            assert.ok(cookie.flags.has("httponly"), "HttpOnly");
            assert.equal(cookie.attrs.samesite, "Lax");
            assert.equal(cookie.attrs.path, "/api/v1/admin");
            assert.equal(cookie.attrs["max-age"], String(EIGHT_HOURS));
            assert.ok(!cookie.flags.has("secure"), "not Secure outside production");
            assert.ok(!JSON.stringify(res.body).includes(cookie.value), "the token is not in the body");
        });

        it("the token is an HS256 JWT { sub: admin, pwv } valid for 8 hours", async () => {
            const res = await login();
            const token = sessionCookie(res).value;

            const { header } = jwt.decode(token, { complete: true });
            assert.equal(header.alg, "HS256");

            const payload = jwt.verify(token, TEST_ADMIN_JWT_SECRET, { algorithms: ["HS256"] });
            assert.deepEqual(Object.keys(payload).sort(), ["exp", "iat", "pwv", "sub"]);
            assert.equal(payload.sub, "admin");
            assert.match(payload.pwv, /^[0-9a-f]{12}$/);
            assert.equal(payload.pwv, CURRENT_PWV);
            assert.equal(payload.exp - payload.iat, EIGHT_HOURS);
        });

        it("the cookie it sets works on /me", async () => {
            const res = await login();
            const token = sessionCookie(res).value;

            const check = await me(token);

            assert.equal(check.status, 200);
        });

        it("compares the email case-insensitively and ignores surrounding spaces", async () => {
            const res = await login({ email: `  ${TEST_ADMIN_EMAIL.toUpperCase()} ` });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { email: TEST_ADMIN_EMAIL });
        });

        it("wrong password: 401 INVALID_CREDENTIALS and no cookie", async () => {
            const res = await login({ password: "not the password" });

            assert.equal(res.status, 401);
            assert.equal(res.body.success, false);
            assert.equal(res.body.code, "INVALID_CREDENTIALS");
            assert.deepEqual(res.body.errors, {});
            assert.equal(res.headers["set-cookie"], undefined);
        });

        it("wrong email: the same 401 as a wrong password (no hint which one was wrong)", async () => {
            const wrongPassword = await login({ password: "not the password" });
            const wrongEmail = await login({ email: "someone.else@example.com" });

            assert.equal(wrongEmail.status, 401);
            assert.equal(wrongEmail.body.code, "INVALID_CREDENTIALS");
            assert.deepEqual(wrongEmail.body, wrongPassword.body);
            assert.equal(wrongEmail.headers["set-cookie"], undefined);
        });

        it("a wrong email with the right password is still refused", async () => {
            const res = await login({ email: "someone.else@example.com", password: TEST_ADMIN_PASSWORD });

            assert.equal(res.status, 401);
            assert.equal(res.body.code, "INVALID_CREDENTIALS");
        });

        it("always runs bcrypt.compare, even when the email is wrong", async () => {
            const compare = mock.method(bcrypt, "compare");

            await login({ email: "someone.else@example.com", password: "anything" });
            assert.equal(compare.mock.callCount(), 1, "wrong email");

            await login({ password: "wrong" });
            assert.equal(compare.mock.callCount(), 2, "wrong password");

            await login();
            assert.equal(compare.mock.callCount(), 3, "correct credentials");
        });

        it("a missing email or password is 400 VALIDATION_FAILED", async () => {
            const noPassword = await request(app()).post(LOGIN).send({ email: TEST_ADMIN_EMAIL });
            const noEmail = await request(app()).post(LOGIN).send({ password: "x" });
            const empty = await request(app()).post(LOGIN).send({});

            for (const res of [noPassword, noEmail, empty]) {
                assert.equal(res.status, 400);
                assert.equal(res.body.code, "VALIDATION_FAILED");
            }
            assert.ok(noPassword.body.errors.password);
            assert.ok(noEmail.body.errors.email);
        });

        it("login is open to a request with no Origin header (it is the one unguarded admin route)", async () => {
            const res = await login({}, null);

            assert.equal(res.status, 200);
        });

        it("is limited to 5 attempts per 15 minutes per IP: the 6th is 429 RATE_LIMITED", async () => {
            rateLimiting.enable();

            for (let attempt = 1; attempt <= 5; attempt++) {
                const res = await login({ password: `wrong-${attempt}` });
                assert.equal(res.status, 401, `attempt ${attempt}`);
            }

            const blocked = await login({ password: "wrong-6" });
            assert.equal(blocked.status, 429);
            assert.equal(blocked.body.code, "RATE_LIMITED");
            assert.ok(blocked.headers["retry-after"], "Retry-After header");

            // Even the correct password is refused until the window passes.
            const correct = await login();
            assert.equal(correct.status, 429);
            assert.equal(correct.headers["set-cookie"], undefined);
        });
    });

    describe("GET /admin/auth/me", () => {
        it("with a valid cookie: 200 { email, expiresAt }", async () => {
            const before = Date.now();
            const res = await me(goodToken());

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(res.body.data.email, TEST_ADMIN_EMAIL);

            const expiresAt = Date.parse(res.body.data.expiresAt);
            assert.ok(Number.isFinite(expiresAt), "expiresAt is an ISO date");
            assert.match(res.body.data.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
            assert.ok(Math.abs(expiresAt - (before + EIGHT_HOURS * 1000)) < 60_000, "about 8 hours from now");
        });

        it("without a cookie: 401 ADMIN_UNAUTHORIZED", async () => {
            assertUnauthorized(await me());
        });

        it("with an empty or garbage cookie: 401", async () => {
            for (const value of ["", "not-a-jwt", "a.b.c", "....", "Bearer abc"]) {
                assertUnauthorized(await me(value));
            }
        });

        it("a bearer token in the Authorization header is not a session", async () => {
            const res = await request(app()).get(ME).set("Authorization", `Bearer ${goodToken()}`);

            assertUnauthorized(res);
        });

        it("an expired token: 401", async () => {
            const expired = sign({ sub: "admin", pwv: CURRENT_PWV }, { expiresIn: -10 });

            assertUnauthorized(await me(expired));
        });

        it("a token with only seconds left still works", async () => {
            const almost = goodToken({ expiresIn: 30 });

            assert.equal((await me(almost)).status, 200);
        });

        it("a tampered payload (signature kept): 401", async () => {
            const [header, payload, signature] = goodToken().split(".");
            const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
            const forged = base64url({ ...claims, exp: claims.exp + 10 * EIGHT_HOURS });

            assertUnauthorized(await me(`${header}.${forged}.${signature}`));
        });

        it("a tampered signature: 401", async () => {
            const [header, payload, signature] = goodToken().split(".");
            const flipped = `${signature.slice(0, 10)}${signature[10] === "A" ? "B" : "A"}${signature.slice(11)}`;

            assertUnauthorized(await me(`${header}.${payload}.${flipped}`));
        });

        it("a token signed with another secret: 401", async () => {
            const other = sign({ sub: "admin", pwv: CURRENT_PWV }, { secret: "another-secret-0123456789-abcdefghijklmnop", expiresIn: 600 });

            assertUnauthorized(await me(other));
        });

        it("an unsigned (alg none) token: 401", async () => {
            const unsigned = `${base64url({ alg: "none", typ: "JWT" })}.${base64url({ sub: "admin", pwv: CURRENT_PWV, exp: Math.floor(Date.now() / 1000) + 600 })}.`;

            assertUnauthorized(await me(unsigned));
        });

        it("a token signed with another algorithm (HS512, right secret): 401", async () => {
            const hs512 = sign({ sub: "admin", pwv: CURRENT_PWV }, { algorithm: "HS512", expiresIn: 600 });

            assertUnauthorized(await me(hs512));
        });

        it("a token with the wrong subject, no pwv or no expiry: 401", async () => {
            assertUnauthorized(await me(sign({ sub: "someone", pwv: CURRENT_PWV }, { expiresIn: 600 })));
            assertUnauthorized(await me(sign({ sub: "admin" }, { expiresIn: 600 })));
            assertUnauthorized(await me(sign({ sub: "admin", pwv: CURRENT_PWV })));   // never expires
        });

        it("a changed password hash kills sessions issued under the old one", async () => {
            const oldHash = bcrypt.hashSync("the previous password", 4);
            assert.notEqual(pwvOf(oldHash), CURRENT_PWV);
            const oldSession = sign({ sub: "admin", pwv: pwvOf(oldHash) }, { expiresIn: 600 });

            assertUnauthorized(await me(oldSession));
            assert.equal((await me(goodToken())).status, 200, "a session for the current hash still works");
        });

        it("a VM booking token is not an admin session", async () => {
            const booking = sign({ sub: "rahul@example.com", purpose: "vm-booking" }, { secret: TEST_BOOKING_TOKEN_SECRET, expiresIn: 600 });

            assertUnauthorized(await me(booking));
        });
    });

    describe("POST /admin/auth/logout", () => {
        it("clears the cookie (same path, empty value, already expired)", async () => {
            const res = await logout(goodToken());

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(res.body.data, null);

            const cookie = sessionCookie(res);
            assert.equal(cookie.name, COOKIE);
            assert.equal(cookie.value, "");
            assert.equal(cookie.attrs.path, "/api/v1/admin");
            assert.ok(Date.parse(cookie.attrs.expires) < Date.now(), "expires in the past");
            assert.ok(cookie.flags.has("httponly"));
        });

        it("without a session: 401", async () => {
            assertUnauthorized(await logout());
        });
    });

    describe("CSRF check on admin writes", () => {
        it("a POST from a foreign Origin is 403 CSRF_REJECTED, even with a valid session", async () => {
            const res = await logout(goodToken(), { origin: FOREIGN_ORIGIN });

            assert.equal(res.status, 403);
            assert.equal(res.body.success, false);
            assert.equal(res.body.code, "CSRF_REJECTED");
            assert.equal(res.headers["set-cookie"], undefined, "the cookie is not cleared by a rejected request");
        });

        it("a POST with no Origin header is rejected", async () => {
            const res = await logout(goodToken(), { origin: null });

            assert.equal(res.status, 403);
            assert.equal(res.body.code, "CSRF_REJECTED");
        });

        it("a POST that is not JSON is rejected, even from an allowed Origin", async () => {
            for (const contentType of ["application/x-www-form-urlencoded", "text/plain", "multipart/form-data; boundary=x", null]) {
                const res = await logout(goodToken(), { contentType });

                assert.equal(res.status, 403, String(contentType));
                assert.equal(res.body.code, "CSRF_REJECTED", String(contentType));
            }
        });

        it("application/json with a charset parameter is accepted", async () => {
            const res = await logout(goodToken(), { contentType: "application/json; charset=utf-8" });

            assert.equal(res.status, 200);
        });

        it("the Origin must match a CORS_ORIGINS entry exactly", async () => {
            for (const origin of [`${TEST_ORIGIN}.evil.example`, "http://localhost:5174", "https://localhost:5173", "null"]) {
                const res = await logout(goodToken(), { origin });

                assert.equal(res.status, 403, origin);
            }
        });

        it("GET requests are not subject to the check (foreign Origin is only a CORS matter)", async () => {
            const res = await request(app()).get(ME).set("Cookie", asCookie(goodToken())).set("Origin", FOREIGN_ORIGIN);

            assert.equal(res.status, 200);
        });

        it("authentication comes first: a foreign Origin with no session is 401, not 403", async () => {
            assertUnauthorized(await logout(undefined, { origin: FOREIGN_ORIGIN }));
        });
    });

    describe("route protection", () => {
        it("every admin path except login needs a session, whatever the method", async () => {
            for (const method of ["get", "post", "put", "patch", "delete"]) {
                for (const path of [`${BASE}/anything`, `${BASE}/bookings`, `${BASE}/auth/me`, `${BASE}/auth/logout`, BASE]) {
                    const res = await request(app())[method](path).set("Origin", TEST_ORIGIN);

                    assertUnauthorized(res);
                }
            }
        });

        it("with a session, an admin path that does not exist is a normal 404", async () => {
            const res = await request(app()).get(`${BASE}/not-a-route`).set("Cookie", asCookie(goodToken()));

            assert.equal(res.status, 404);
            assert.equal(res.body.code, "NOT_FOUND");
        });
    });

    describe("configuration", () => {
        const loadConfigCode = `import { config } from ${JSON.stringify(SRC("config/env.js"))}; console.log("loaded " + config.ADMIN_EMAIL);`;

        it("boots with the admin settings in place", () => {
            const result = runInChild(loadConfigCode);

            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, new RegExp(`loaded ${TEST_ADMIN_EMAIL}`));
        });

        it("each of ADMIN_EMAIL, ADMIN_PASSWORD_HASH and ADMIN_JWT_SECRET is required", () => {
            for (const name of ["ADMIN_EMAIL", "ADMIN_PASSWORD_HASH", "ADMIN_JWT_SECRET"]) {
                const result = runInChild(loadConfigCode, { [name]: undefined });

                assert.notEqual(result.status, 0, `${name} missing should stop the server`);
                assert.match(result.stderr, new RegExp(`${name}: is missing`));
            }
        });

        it("ADMIN_JWT_SECRET must be at least 32 characters", () => {
            const result = runInChild(loadConfigCode, { ADMIN_JWT_SECRET: "too-short" });

            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /ADMIN_JWT_SECRET: must be at least 32 characters/);
            assert.doesNotMatch(result.stderr, /too-short/, "values are never printed");
        });

        it("ADMIN_PASSWORD_HASH must be a bcrypt hash", () => {
            const result = runInChild(loadConfigCode, { ADMIN_PASSWORD_HASH: "plain-text-password" });

            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /ADMIN_PASSWORD_HASH: must be a bcrypt hash/);
            assert.doesNotMatch(result.stderr, /plain-text-password/);
        });

        it("the session cookie is Secure in production only", () => {
            const code = `import { sessionCookieOptions } from ${JSON.stringify(SRC("services/adminAuth.service.js"))};
                console.log(JSON.stringify(sessionCookieOptions()));`;

            const production = runInChild(code, { NODE_ENV: "production" });
            assert.equal(production.status, 0, production.stderr);
            assert.deepEqual(JSON.parse(production.stdout), {
                httpOnly: true, sameSite: "lax", secure: true, path: "/api/v1/admin",
            });

            const development = runInChild(code, { NODE_ENV: "development" });
            assert.equal(JSON.parse(development.stdout).secure, false);
        });
    });

    describe("scripts/hash-password.js (npm run admin:hash)", () => {
        let script;

        before(async () => {
            script = await import(pathToFileURL(`${SCRIPT_DIR}hash-password.js`).href);
        });

        const fakeTerminal = () => {
            const input = new PassThrough();
            input.isTTY = true;
            input.setRawMode = mock.fn();
            const output = new PassThrough();
            let shown = "";
            output.on("data", (chunk) => { shown += chunk; });
            return { input, output, shown: () => shown };
        };

        it("makes a bcrypt hash with cost 12 that verifies against the password", async () => {
            const hash = await script.hashPassword("a long enough passphrase");

            assert.match(hash, /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/);
            assert.equal(await bcrypt.compare("a long enough passphrase", hash), true);
            assert.equal(await bcrypt.compare("another one", hash), false);
        });

        it("refuses an empty password and one over bcrypt's 72 byte limit", async () => {
            await assert.rejects(() => script.hashPassword(""), /cannot be empty/);
            await assert.rejects(() => script.hashPassword("x".repeat(73)), /longer than 72 bytes/);
            await assert.doesNotReject(() => script.hashPassword("x".repeat(72), 4));
        });

        it("hidden prompt: returns what was typed and never echoes it", async () => {
            const term = fakeTerminal();
            const answer = script.promptHidden("Admin password: ", term);
            term.input.write("hunter2-secret\r");

            assert.equal(await answer, "hunter2-secret");
            assert.equal(term.input.setRawMode.mock.calls[0].arguments[0], true, "raw mode on");
            assert.equal(term.input.setRawMode.mock.calls.at(-1).arguments[0], false, "raw mode restored");
            assert.ok(term.shown().startsWith("Admin password: "));
            assert.doesNotMatch(term.shown(), /hunter2|secret/);
        });

        it("hidden prompt: backspace edits, a pasted chunk works, Ctrl+C cancels", async () => {
            const edited = fakeTerminal();
            const first = script.promptHidden("> ", edited);
            edited.input.write("abx\u007fc\r");
            assert.equal(await first, "abc");

            const pasted = fakeTerminal();
            const second = script.promptHidden("> ", pasted);
            pasted.input.write("p");
            pasted.input.write("a ss\r");
            assert.equal(await second, "pa ss");

            const cancelled = fakeTerminal();
            const third = script.promptHidden("> ", cancelled);
            cancelled.input.write("abc\u0003");
            await assert.rejects(third, /Cancelled/);
            assert.equal(cancelled.input.setRawMode.mock.calls.at(-1).arguments[0], false);
        });

        it("piped input: the first line is the password", async () => {
            const input = new PassThrough();
            const output = new PassThrough();
            const answer = script.promptHidden("pw: ", { input, output });
            input.write("from a pipe\nsecond line\n");

            assert.equal(await answer, "from a pipe");
        });

        it("run as a command: prints a hash for the piped password, never the password, writes nothing", () => {
            const password = "piped-test-password-123";
            const result = spawnSync(process.execPath, [`${SCRIPT_DIR}hash-password.js`], {
                input: `${password}\n`,
                encoding: "utf8",
                cwd: fileURLToPath(new URL("../", import.meta.url)),
                env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
            });

            assert.equal(result.status, 0, result.stderr);
            const hash = /\$2[aby]\$12\$[./A-Za-z0-9]{53}/.exec(result.stdout)?.[0];
            assert.ok(hash, `a bcrypt hash is printed:\n${result.stdout}`);
            assert.equal(bcrypt.compareSync(password, hash), true);
            assert.ok(!result.stdout.includes(password) && !result.stderr.includes(password), "the password is not printed");
        });

        it("run as a command with an empty password: exits 1 with a message", () => {
            const result = spawnSync(process.execPath, [`${SCRIPT_DIR}hash-password.js`], {
                input: "\n",
                encoding: "utf8",
                env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
            });

            assert.equal(result.status, 1);
            assert.match(result.stderr, /cannot be empty/);
        });
    });
});
