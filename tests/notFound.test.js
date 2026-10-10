import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { startTestEnv, stopTestEnv, resetState, getApp } from "./helpers/setup.js";

describe("JSON 404 handler", () => {
    before(startTestEnv);
    after(stopTestEnv);
    beforeEach(resetState);

    const expectNotFound = (res) => {
        assert.equal(res.status, 404);
        assert.match(res.headers["content-type"], /application\/json/);
        assert.equal(res.body.success, false);
        assert.equal(res.body.code, "NOT_FOUND");
        assert.equal(typeof res.body.message, "string");
        assert.deepEqual(res.body.errors, {});
    };

    it("returns the standard error format for an unknown route", async () => {
        expectNotFound(await request(getApp()).get("/nope"));
    });

    it("returns it for an unknown route under /api/v1", async () => {
        expectNotFound(await request(getApp()).get("/api/v1/does-not-exist"));
    });

    it("returns it for an unknown method on a known path", async () => {
        expectNotFound(await request(getApp()).get("/api/v1/query/new-query"));
    });

    it("keeps /health working", async () => {
        const res = await request(getApp()).get("/health");

        assert.equal(res.status, 200);
    });
});
