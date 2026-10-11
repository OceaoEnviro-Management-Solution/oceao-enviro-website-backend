import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { startTestEnv, stopTestEnv, TEST_CAPTCHA_TOKEN } from "./helpers/setup.js";

let turnstile;

describe("Turnstile verification", () => {
    before(async () => {
        await startTestEnv();
        turnstile = await import("../src/services/turnstile.service.js");
    });
    after(stopTestEnv);

    // These tests exercise the real verifier against a stubbed network.
    beforeEach(() => turnstile.setTurnstileVerifier(null));
    afterEach(() => {
        mock.restoreAll();
        turnstile.setTurnstileVerifier(async (token) => token === TEST_CAPTCHA_TOKEN);
    });

    const stubFetch = (impl) => mock.method(globalThis, "fetch", impl);
    const json = (body, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    it("posts secret, response and remoteip as a form to the siteverify URL with a 5 second timeout", async () => {
        let call;
        stubFetch(async (url, init) => {
            call = { url, init };
            return json({ success: true });
        });

        const ok = await turnstile.verifyTurnstile("token-abc", "203.0.113.9");

        assert.equal(ok, true);
        assert.equal(call.url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
        assert.equal(call.init.method, "POST");
        assert.ok(call.init.body instanceof URLSearchParams, "form-encoded body");
        assert.equal(call.init.body.get("secret"), "1x0000000000000000000000000000000AA");
        assert.equal(call.init.body.get("response"), "token-abc");
        assert.equal(call.init.body.get("remoteip"), "203.0.113.9");
        assert.ok(call.init.signal instanceof AbortSignal, "has an abort signal for the timeout");
        assert.equal(turnstile.TURNSTILE_TIMEOUT_MS, 5000);
    });

    it("leaves remoteip out when there is no IP", async () => {
        let body;
        stubFetch(async (url, init) => {
            body = init.body;
            return json({ success: true });
        });

        await turnstile.verifyTurnstile("token-abc");

        assert.equal(body.has("remoteip"), false);
    });

    it("returns false when Cloudflare says success is false", async () => {
        stubFetch(async () => json({ success: false, "error-codes": ["invalid-input-response"] }));

        assert.equal(await turnstile.verifyTurnstile("token-abc", "1.2.3.4"), false);
    });

    it("only a literal success: true counts", async () => {
        for (const answer of [{ success: "true" }, { success: 1 }, {}, null, []]) {
            stubFetch(async () => json(answer));

            assert.equal(await turnstile.verifyTurnstile("token-abc"), false, JSON.stringify(answer));
            mock.restoreAll();
        }
    });

    it("fails closed on a network error, a timeout, an HTTP error and a non-JSON answer", async () => {
        stubFetch(async () => { throw new TypeError("fetch failed"); });
        assert.equal(await turnstile.verifyTurnstile("token-abc"), false);
        mock.restoreAll();

        stubFetch(async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); });
        assert.equal(await turnstile.verifyTurnstile("token-abc"), false);
        mock.restoreAll();

        stubFetch(async () => json({ success: true }, 500));
        assert.equal(await turnstile.verifyTurnstile("token-abc"), false);
        mock.restoreAll();

        stubFetch(async () => new Response("<html>oops</html>", { status: 200 }));
        assert.equal(await turnstile.verifyTurnstile("token-abc"), false);
    });

    it("does not call Cloudflare for a missing, blank, non-string or oversized token", async () => {
        const fetchMock = stubFetch(async () => json({ success: true }));

        for (const token of [undefined, null, "", "   ", 123, {}, ["a"], "x".repeat(2049)]) {
            assert.equal(await turnstile.verifyTurnstile(token, "1.2.3.4"), false, String(token));
        }
        assert.equal(fetchMock.mock.callCount(), 0);
    });

    it("never logs the token", async () => {
        stubFetch(async () => { throw new TypeError("fetch failed"); });
        const warn = mock.method(console, "warn", () => {});

        await turnstile.verifyTurnstile("super-secret-token-value");

        const logged = warn.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
        assert.match(logged, /Turnstile verification failed/);
        assert.doesNotMatch(logged, /super-secret-token-value/);
    });

    describe("requireTurnstile middleware", () => {
        let probe;
        let seenByHandler;

        before(async () => {
            const { requireTurnstile } = await import("../src/middlewares/requireTurnstile.js");
            const { errorHandler } = await import("../src/middlewares/error.middleware.js");

            probe = express();
            probe.use(express.json());
            probe.post("/guarded", requireTurnstile, (req, res) => {
                seenByHandler = { ...req.body };
                res.json({ ok: true });
            });
            probe.use(errorHandler);
        });

        beforeEach(() => {
            seenByHandler = undefined;
            turnstile.setTurnstileVerifier(async (token) => token === TEST_CAPTCHA_TOKEN);
        });

        it("removes turnstileToken from req.body before the handler (and so before validation)", async () => {
            const res = await request(probe).post("/guarded").send({ name: "A", turnstileToken: TEST_CAPTCHA_TOKEN });

            assert.equal(res.status, 200);
            assert.deepEqual(seenByHandler, { name: "A" });
        });

        it("passes the visitor's IP to the verifier", async () => {
            let seenIp;
            turnstile.setTurnstileVerifier(async (token, ip) => { seenIp = ip; return true; });

            await request(probe).post("/guarded").send({ turnstileToken: "anything" });

            assert.ok(seenIp, "an IP was passed");
        });

        it("answers 400 CAPTCHA_FAILED for a missing or wrong token and never runs the handler", async () => {
            for (const body of [{}, { turnstileToken: "wrong" }, { turnstileToken: "" }]) {
                const res = await request(probe).post("/guarded").send(body);

                assert.equal(res.status, 400, JSON.stringify(body));
                assert.equal(res.body.success, false);
                assert.equal(res.body.code, "CAPTCHA_FAILED");
                assert.deepEqual(res.body.errors, {});
            }
            assert.equal(seenByHandler, undefined);
        });

        it("also rejects a request with no body at all", async () => {
            const res = await request(probe).post("/guarded");

            assert.equal(res.status, 400);
            assert.equal(res.body.code, "CAPTCHA_FAILED");
        });
    });

    it("an injected verifier replaces the network call, and a throwing one fails closed", async () => {
        const fetchMock = stubFetch(async () => json({ success: true }));

        turnstile.setTurnstileVerifier(async (token, ip) => token === "good" && ip === "9.9.9.9");
        assert.equal(await turnstile.verifyTurnstile("good", "9.9.9.9"), true);
        assert.equal(await turnstile.verifyTurnstile("good", "1.1.1.1"), false);

        turnstile.setTurnstileVerifier(async () => { throw new Error("boom"); });
        assert.equal(await turnstile.verifyTurnstile("good", "9.9.9.9"), false);

        assert.equal(fetchMock.mock.callCount(), 0);
    });
});
