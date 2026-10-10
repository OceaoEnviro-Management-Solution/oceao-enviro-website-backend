import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startTestEnv, stopTestEnv, resetState } from "./helpers/setup.js";

let getCallbackCapacity;
let setCallbackCapacity;
let Settings;

const rejectsValidation = async (promise, expectedFields) => {
    await assert.rejects(promise, (error) => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, "VALIDATION_FAILED");
        assert.deepEqual(Object.keys(error.errors).sort(), [...expectedFields].sort());
        return true;
    });
};

describe("settings service", () => {
    before(async () => {
        await startTestEnv();
        ({ getCallbackCapacity, setCallbackCapacity } = await import("../src/services/settings.service.js"));
        ({ Settings } = await import("../src/models/settings.model.js"));
        await Settings.init();
    });
    after(stopTestEnv);
    beforeEach(resetState);

    it("falls back to the config defaults when there is no settings document", async () => {
        assert.equal(await Settings.countDocuments(), 0);

        assert.deepEqual(await getCallbackCapacity(), { morning: 5, afternoon: 5, evening: 3 });
    });

    it("saves and returns the capacity, keeping a single document", async () => {
        const saved = await setCallbackCapacity({ morning: 8, afternoon: 0, evening: 50 });
        await setCallbackCapacity({ morning: 7, afternoon: 1, evening: 2 });

        assert.deepEqual(saved, { morning: 8, afternoon: 0, evening: 50 });
        assert.deepEqual(await getCallbackCapacity(), { morning: 7, afternoon: 1, evening: 2 });
        assert.equal(await Settings.countDocuments(), 1);
        assert.equal((await Settings.findOne()).key, "main");
    });

    it("accepts the limits 0 and 50", async () => {
        await setCallbackCapacity({ morning: 0, afternoon: 0, evening: 0 });
        assert.deepEqual(await getCallbackCapacity(), { morning: 0, afternoon: 0, evening: 0 });

        await setCallbackCapacity({ morning: 50, afternoon: 50, evening: 50 });
        assert.deepEqual(await getCallbackCapacity(), { morning: 50, afternoon: 50, evening: 50 });
    });

    it("rejects values outside 0 to 50 and non-integers, and saves nothing", async () => {
        await setCallbackCapacity({ morning: 4, afternoon: 4, evening: 4 });

        await rejectsValidation(setCallbackCapacity({ morning: -1, afternoon: 4, evening: 4 }), ["morning"]);
        await rejectsValidation(setCallbackCapacity({ morning: 4, afternoon: 51, evening: 4 }), ["afternoon"]);
        await rejectsValidation(setCallbackCapacity({ morning: 2.5, afternoon: 4, evening: 4 }), ["morning"]);
        await rejectsValidation(setCallbackCapacity({ morning: "3", afternoon: 4, evening: 4 }), ["morning"]);
        await rejectsValidation(setCallbackCapacity({ morning: NaN, afternoon: 4, evening: Infinity }), ["morning", "evening"]);

        assert.deepEqual(await getCallbackCapacity(), { morning: 4, afternoon: 4, evening: 4 });
    });

    it("requires every period and rejects unknown ones", async () => {
        await rejectsValidation(setCallbackCapacity({ morning: 4, afternoon: 4 }), ["evening"]);
        await rejectsValidation(setCallbackCapacity({ morning: 4, afternoon: 4, evening: 4, night: 1 }), ["night"]);
        await rejectsValidation(setCallbackCapacity({}), ["morning", "afternoon", "evening"]);
        await rejectsValidation(setCallbackCapacity(null), ["morning", "afternoon", "evening"]);
        await rejectsValidation(setCallbackCapacity([1, 2, 3]), ["morning", "afternoon", "evening"]);
    });

    it("uses the default for any stored value that is unusable", async () => {
        await Settings.collection.insertOne({
            key: "main",
            callbackCapacity: { morning: 9, afternoon: 99, evening: "x" },
        });

        assert.deepEqual(await getCallbackCapacity(), { morning: 9, afternoon: 5, evening: 3 });
    });

    it("does not allow a second settings document", async () => {
        await setCallbackCapacity({ morning: 1, afternoon: 1, evening: 1 });

        await assert.rejects(
            Settings.create({ key: "main", callbackCapacity: { morning: 2, afternoon: 2, evening: 2 } }),
            (error) => error.code === 11000
        );
        await assert.rejects(
            Settings.create({ key: "other", callbackCapacity: { morning: 2, afternoon: 2, evening: 2 } }),
            /key/
        );
    });
});
