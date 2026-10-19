// Homepage hero: the Cloudinary helpers, the slide model, the timed switch and GET /hero.
// Cloudinary is always a fake: nothing here touches the network.

import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { startTestEnv, stopTestEnv, resetState, getApp, TEST_ADMIN_ENV, TEST_ORIGIN } from "./helpers/setup.js";

const SECRET = "test-cloudinary-secret-0123456789";
const API_KEY = "test-cloudinary-key";
const CLOUD = "test-cloud";

// 25 Oct 2026 is the switch day in most tests. In IST it starts at 24 Oct 18:30 UTC.
const SWITCH_DAY = "2026-10-25";
const MIDNIGHT_IST = new Date("2026-10-24T18:30:00.000Z");        // 00:00 IST on 25 Oct
const ONE_MS_BEFORE = new Date("2026-10-24T18:29:59.999Z");       // 23:59:59.999 IST on 24 Oct

let cloudinary;          // the service under test
let hero;                // hero.service.js
let HeroSlide;
let Settings;
let fake;

// A stand-in for the Cloudinary SDK. Every call is recorded; `dbAtDestroy` shows what the
// database looked like at the moment each picture was deleted.
const makeFake = () => {
    const state = {
        uploads: [],
        destroys: [],
        failUpload: null,
        failDestroy: false,
        destroyResult: { result: "ok" },
        dbAtDestroy: [],
    };
    const client = {
        state,
        uploader: {
            upload_stream(options, done) {
                state.uploads.push(options);
                return {
                    end(buffer) {
                        state.lastBuffer = buffer;
                        queueMicrotask(() => {
                            if (state.failUpload) return done(state.failUpload);
                            done(null, { public_id: "oceao/hero/new123", secure_url: "https://res.cloudinary.com/test-cloud/image/upload/v1/oceao/hero/new123.jpg", width: 4000, height: 2250 });
                        });
                    },
                };
            },
            async destroy(publicId, options) {
                state.destroys.push({ publicId, options });
                state.dbAtDestroy.push((await HeroSlide.find().lean()).map((slide) => `${slide.set}:${slide.publicId}`).sort());
                if (state.failDestroy) throw new Error(`network down for ${SECRET}`);
                return state.destroyResult;
            },
        },
    };
    return client;
};

const slide = (set, order, overrides = {}) => ({
    set, order,
    publicId: `oceao/hero/${set}-${order}`,
    url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1/oceao/hero/${set}-${order}.jpg`,
    width: 3000, height: 2000,
    name: `${set} slide ${order}`, location: "Himachal Pradesh", description: "A short description.", credit: "Photo: A. Kumar",
    ...overrides,
});

const seedSlides = (set, count) => HeroSlide.insertMany(Array.from({ length: count }, (_, index) => slide(set, index + 1)));

// The settings document with a switch date. (callbackCapacity is required by the model.)
const planSwitch = (date) =>
    Settings.findOneAndUpdate(
        { key: "main" },
        { $set: { heroSwitchDate: date, callbackCapacity: { morning: 5, afternoon: 5, evening: 3 } } },
        { upsert: true }
    );
const switchDate = async () => (await Settings.findOne({ key: "main" }).lean())?.heroSwitchDate ?? null;
const sets = async () => {
    const all = await HeroSlide.find().sort({ set: 1, order: 1 }).lean();
    return { live: all.filter((s) => s.set === "live").map((s) => s.publicId), scheduled: all.filter((s) => s.set === "scheduled").map((s) => s.publicId) };
};

const captureConsole = () => {
    const lines = [];
    for (const method of ["log", "info", "warn", "error"]) mock.method(console, method, (...args) => lines.push(args.map(String).join(" ")));
    return lines;
};

describe("Hero slides", () => {
    before(async () => {
        await startTestEnv();
        cloudinary = await import("../src/services/cloudinary.service.js");
        hero = await import("../src/services/hero.service.js");
        ({ HeroSlide } = await import("../src/models/heroSlide.model.js"));
        ({ Settings } = await import("../src/models/settings.model.js"));
    });
    after(stopTestEnv);
    beforeEach(async () => {
        await resetState();
        fake = makeFake();
        cloudinary.setCloudinaryClient(fake);
    });
    afterEach(() => {
        mock.restoreAll();
        cloudinary.setCloudinaryClient(null);
    });

    // ── Cloudinary helpers ───────────────────────────────────────────────────
    describe("uploadImage", () => {
        it("uploads to the oceao/hero folder as an image and returns publicId, url, width, height", async () => {
            const bytes = Buffer.from("not really a jpeg");

            const result = await cloudinary.uploadImage(bytes);

            assert.deepEqual(result, {
                publicId: "oceao/hero/new123",
                url: "https://res.cloudinary.com/test-cloud/image/upload/v1/oceao/hero/new123.jpg",
                width: 4000,
                height: 2250,
            });
            assert.equal(fake.state.uploads.length, 1);
            assert.equal(fake.state.uploads[0].folder, "oceao/hero");
            assert.equal(fake.state.uploads[0].resource_type, "image");
            assert.deepEqual(fake.state.uploads[0].allowed_formats, ["jpg", "jpeg", "png", "webp"]);
            assert.equal(fake.state.lastBuffer, bytes);
        });

        it("rejects with a plain message when Cloudinary fails, and logs it without the account secrets", async () => {
            const lines = captureConsole();
            fake.state.failUpload = new Error(`Invalid credentials ${API_KEY} / ${SECRET}`);

            await assert.rejects(cloudinary.uploadImage(Buffer.from("x")), (error) => {
                assert.equal(error.message, "Image upload failed");
                assert.ok(!error.message.includes(SECRET) && !error.message.includes(API_KEY));
                return true;
            });

            assert.ok(lines.length >= 1, "the failure is logged");
            const text = lines.join("\n");
            assert.ok(!text.includes(SECRET), `the secret was logged:\n${text}`);
            assert.ok(!text.includes(API_KEY), `the key was logged:\n${text}`);
            assert.match(text, /\[redacted\]/);
        });

        it("rejects without calling Cloudinary when there is no image data", async () => {
            for (const bad of [undefined, null, "a string", Buffer.alloc(0), { length: 3 }]) {
                await assert.rejects(cloudinary.uploadImage(bad), /Image upload failed/, String(bad));
            }
            assert.equal(fake.state.uploads.length, 0);
        });

        it("rejects when the SDK throws while starting the upload", async () => {
            captureConsole();
            fake.uploader.upload_stream = () => { throw new Error("sdk exploded"); };

            await assert.rejects(cloudinary.uploadImage(Buffer.from("x")), /Image upload failed/);
        });

        it("rejects when Cloudinary answers without a picture", async () => {
            captureConsole();
            fake.uploader.upload_stream = (options, done) => ({ end: () => queueMicrotask(() => done(null, {})) });

            await assert.rejects(cloudinary.uploadImage(Buffer.from("x")), /Image upload failed/);
        });
    });

    describe("deleteImage", () => {
        it("asks Cloudinary to destroy that picture", async () => {
            await cloudinary.deleteImage("oceao/hero/abc");

            assert.deepEqual(fake.state.destroys, [{ publicId: "oceao/hero/abc", options: { resource_type: "image", invalidate: true } }]);
        });

        it("never throws when Cloudinary fails: it logs, with the id and without the secrets", async () => {
            const lines = captureConsole();
            fake.state.failDestroy = true;

            await assert.doesNotReject(cloudinary.deleteImage("oceao/hero/abc"));

            const text = lines.join("\n");
            assert.match(text, /oceao\/hero\/abc/);
            assert.ok(!text.includes(SECRET), `the secret was logged:\n${text}`);
        });

        it("logs (and does not throw) when Cloudinary says it did not delete", async () => {
            const lines = captureConsole();
            fake.state.destroyResult = { result: "error" };

            await assert.doesNotReject(cloudinary.deleteImage("oceao/hero/abc"));

            assert.match(lines.join("\n"), /did not delete/);
        });

        it("'not found' is fine: the picture is already gone", async () => {
            const lines = captureConsole();
            fake.state.destroyResult = { result: "not found" };

            await cloudinary.deleteImage("oceao/hero/abc");

            assert.equal(lines.length, 0);
        });

        it("refuses anything outside the hero folder, so another asset can never be deleted", async () => {
            captureConsole();
            for (const bad of ["other/folder/abc", "oceao/herox/abc", "../oceao/hero/abc", "abc", "", null, undefined, 5]) {
                await cloudinary.deleteImage(bad);
            }

            assert.equal(fake.state.destroys.length, 0);
        });
    });

    describe("buildDeliveryUrl", () => {
        it("is an https link with automatic format and quality, at most 1920 px wide", () => {
            assert.equal(
                cloudinary.buildDeliveryUrl("oceao/hero/abc123"),
                "https://res.cloudinary.com/test-cloud/image/upload/f_auto,q_auto,w_1920,c_limit/oceao/hero/abc123"
            );
        });

        it("encodes unusual characters in the id, one path piece at a time", () => {
            assert.equal(
                cloudinary.buildDeliveryUrl("oceao/hero/a b?c#d"),
                "https://res.cloudinary.com/test-cloud/image/upload/f_auto,q_auto,w_1920,c_limit/oceao/hero/a%20b%3Fc%23d"
            );
        });

        it("never contains the API key or secret", () => {
            const url = cloudinary.buildDeliveryUrl("oceao/hero/abc");

            assert.ok(!url.includes(SECRET) && !url.includes(API_KEY));
        });
    });

    describe("the Cloudinary variables", () => {
        const root = fileURLToPath(new URL("..", import.meta.url));
        const load = (omit) => {
            const env = {
                PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: "test", EMAIL_MODE: "test",
                MONGODB_URI: "mongodb://127.0.0.1:27017", CORS_ORIGINS: TEST_ORIGIN, MAIL_FROM: "a@b.c", COMPANY_MAIL: "d@e.f",
                OTP_SECRET: "o".repeat(40), BOOKING_TOKEN_SECRET: "b".repeat(40), TURNSTILE_SECRET_KEY: "t", DATA_GOV_API_KEY: "d",
                CLOUDINARY_CLOUD_NAME: CLOUD, CLOUDINARY_API_KEY: API_KEY, CLOUDINARY_API_SECRET: SECRET,
                ...TEST_ADMIN_ENV,
            };
            if (omit) delete env[omit];
            return spawnSync(process.execPath, ["--input-type=module", "-e", "await import('./src/config/env.js')"], { cwd: root, env, encoding: "utf8", timeout: 30000 });
        };

        it("the server starts with all three", () => {
            assert.equal(load().status, 0, load().stderr);
        });

        for (const name of ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) {
            it(`the server refuses to start without ${name}, naming it and printing no value`, () => {
                const result = load(name);

                assert.equal(result.status, 1);
                assert.match(result.stderr, new RegExp(`${name}: is missing`));
                assert.ok(!result.stderr.includes(SECRET) && !result.stderr.includes(API_KEY));
            });
        }
    });

    // ── The model ────────────────────────────────────────────────────────────
    describe("HeroSlide", () => {
        const refused = (overrides) => assert.rejects(HeroSlide.create(slide("live", 1, overrides)), (error) => error.name === "ValidationError", JSON.stringify(overrides));

        it("saves a complete slide, with timestamps", async () => {
            const saved = await HeroSlide.create(slide("live", 1));

            assert.equal(saved.set, "live");
            assert.ok(saved.createdAt instanceof Date && saved.updatedAt instanceof Date);
            assert.equal(HeroSlide.collection.name, "hero_slides");
        });

        it("set must be live or scheduled", async () => {
            await refused({ set: "draft" });
            await refused({ set: undefined });
        });

        it("order must be a whole number from 0", async () => {
            await refused({ order: 1.5 });
            await refused({ order: -1 });
            await refused({ order: undefined });
            await HeroSlide.create(slide("live", 0));
        });

        it("name and location: 2 to 80 characters (after trimming)", async () => {
            for (const field of ["name", "location"]) {
                await refused({ [field]: "A" });
                await refused({ [field]: " A " });
                await refused({ [field]: "x".repeat(81) });
                await refused({ [field]: "" });
            }
            await HeroSlide.create(slide("live", 1, { name: "AB", location: "x".repeat(80), publicId: "oceao/hero/limits" }));
        });

        it("description: required, at most 120", async () => {
            await refused({ description: "x".repeat(121) });
            await refused({ description: "" });
            await HeroSlide.create(slide("live", 1, { description: "x".repeat(120) }));
        });

        it("credit is optional, at most 80", async () => {
            await refused({ credit: "x".repeat(81) });
            const withNone = await HeroSlide.create(slide("live", 2, { credit: undefined }));
            assert.equal(withNone.credit, undefined);
        });

        it("a picture belongs to one slide (publicId is unique)", async () => {
            await HeroSlide.create(slide("live", 1));

            await assert.rejects(HeroSlide.create(slide("scheduled", 1, { publicId: "oceao/hero/live-1" })), (error) => error.code === 11000);
        });

        it("has the { set, order } index and the unique publicId index", async () => {
            await HeroSlide.init();
            const keys = (await HeroSlide.collection.indexes()).map((index) => JSON.stringify(index.key));

            assert.ok(keys.includes(JSON.stringify({ set: 1, order: 1 })));
            assert.ok(keys.includes(JSON.stringify({ publicId: 1 })));
        });
    });

    describe("Settings.heroSwitchDate", () => {
        const settingsWith = (heroSwitchDate) =>
            new Settings({ key: "main", callbackCapacity: { morning: 5, afternoon: 5, evening: 3 }, heroSwitchDate }).validate();

        it("is a valid YYYY-MM-DD date or null (the default)", async () => {
            await settingsWith("2026-10-25");
            await settingsWith(null);
            assert.equal(new Settings({ key: "main" }).heroSwitchDate, null);
        });

        it("refuses anything else", async () => {
            for (const bad of ["2026-13-45", "25-10-2026", "2026-02-30", "tomorrow", ""]) {
                await assert.rejects(settingsWith(bad), (error) => error.name === "ValidationError", bad);
            }
        });

        it("does not disturb the callback capacity that already worked without it", async () => {
            const { getCallbackCapacity } = await import("../src/services/settings.service.js");
            await planSwitch(SWITCH_DAY);

            assert.deepEqual(await getCallbackCapacity(), { morning: 5, afternoon: 5, evening: 3 });
        });
    });

    // ── The switch ───────────────────────────────────────────────────────────
    describe("promoteIfDue", () => {
        const setup = async () => {
            await seedSlides("live", 3);
            await seedSlides("scheduled", 2);
            await planSwitch(SWITCH_DAY);
        };

        it("switches at 00:00 IST on the day", async () => {
            await setup();

            const outcome = await hero.promoteIfDue({ now: MIDNIGHT_IST });

            assert.equal(outcome.promoted, true);
            assert.deepEqual(await sets(), { live: ["oceao/hero/scheduled-1", "oceao/hero/scheduled-2"], scheduled: [] });
            assert.equal(await switchDate(), null, "the date is cleared");
        });

        it("does not switch at 23:59:59.999 IST the day before", async () => {
            await setup();

            const outcome = await hero.promoteIfDue({ now: ONE_MS_BEFORE });

            assert.deepEqual(outcome, { promoted: false, reason: "not_due" });
            assert.deepEqual(await sets(), {
                live: ["oceao/hero/live-1", "oceao/hero/live-2", "oceao/hero/live-3"],
                scheduled: ["oceao/hero/scheduled-1", "oceao/hero/scheduled-2"],
            });
            assert.equal(await switchDate(), SWITCH_DAY, "the date stays");
            assert.equal(fake.state.destroys.length, 0);
        });

        it("switches on any later day too (the site was quiet on the day itself)", async () => {
            await setup();

            const outcome = await hero.promoteIfDue({ now: new Date("2026-11-30T10:00:00Z") });

            assert.equal(outcome.promoted, true);
        });

        it("does nothing without a switch date", async () => {
            await seedSlides("live", 2);
            await seedSlides("scheduled", 1);
            await Settings.create({ key: "main", callbackCapacity: { morning: 5, afternoon: 5, evening: 3 } });

            assert.deepEqual(await hero.promoteIfDue({ now: MIDNIGHT_IST }), { promoted: false, reason: "not_due" });
            assert.equal((await sets()).scheduled.length, 1);
        });

        it("does nothing without a settings document at all", async () => {
            await seedSlides("live", 2);

            assert.deepEqual(await hero.promoteIfDue({ now: MIDNIGHT_IST }), { promoted: false, reason: "not_due" });
            assert.equal((await sets()).live.length, 2);
        });

        it("the scheduled slides keep their order", async () => {
            await seedSlides("live", 2);
            await HeroSlide.insertMany([slide("scheduled", 3), slide("scheduled", 1), slide("scheduled", 2)]);
            await planSwitch(SWITCH_DAY);

            await hero.promoteIfDue({ now: MIDNIGHT_IST });

            const live = await HeroSlide.find({ set: "live" }).sort({ order: 1 }).lean();
            assert.deepEqual(live.map((s) => [s.order, s.publicId]), [[1, "oceao/hero/scheduled-1"], [2, "oceao/hero/scheduled-2"], [3, "oceao/hero/scheduled-3"]]);
        });

        it("the old pictures are deleted from Cloudinary, after the database has changed", async () => {
            await setup();

            await hero.promoteIfDue({ now: MIDNIGHT_IST });

            assert.deepEqual(fake.state.destroys.map((call) => call.publicId).sort(), ["oceao/hero/live-1", "oceao/hero/live-2", "oceao/hero/live-3"]);
            for (const database of fake.state.dbAtDestroy) {
                assert.deepEqual(database, ["live:oceao/hero/scheduled-1", "live:oceao/hero/scheduled-2"], "at deletion time the new set was already live");
            }
        });

        it("a slide added to the live set while the switch runs is not deleted", async () => {
            await setup();
            const deleteMany = HeroSlide.deleteMany.bind(HeroSlide);
            mock.method(HeroSlide, "deleteMany", async (...args) => {
                await HeroSlide.create(slide("live", 9, { publicId: "oceao/hero/late" }));   // an admin adds one at this very moment
                return deleteMany(...args);
            });

            await hero.promoteIfDue({ now: MIDNIGHT_IST });

            assert.ok((await sets()).live.includes("oceao/hero/late"));
            assert.ok(!fake.state.destroys.some((call) => call.publicId === "oceao/hero/late"));
        });

        it("the new pictures are never deleted", async () => {
            await setup();

            await hero.promoteIfDue({ now: MIDNIGHT_IST });

            assert.ok(!fake.state.destroys.some((call) => call.publicId.includes("scheduled")));
        });

        it("a Cloudinary failure does not undo or fail the switch", async () => {
            captureConsole();
            fake.state.failDestroy = true;
            await setup();

            const outcome = await hero.promoteIfDue({ now: MIDNIGHT_IST });

            assert.equal(outcome.promoted, true);
            assert.deepEqual((await sets()).live, ["oceao/hero/scheduled-1", "oceao/hero/scheduled-2"]);
        });

        it("two parallel calls (two servers) switch only once: one wins, the other loses the claim", async () => {
            await setup();

            const results = await Promise.all([hero.runPromotion({ now: MIDNIGHT_IST }), hero.runPromotion({ now: MIDNIGHT_IST })]);

            assert.deepEqual(results.map((r) => r.reason).sort(), ["lost_race", "promoted"]);
            assert.deepEqual(await sets(), { live: ["oceao/hero/scheduled-1", "oceao/hero/scheduled-2"], scheduled: [] });
            assert.equal(fake.state.destroys.length, 3, "each old picture is deleted once");
        });

        it("many parallel calls still switch only once", async () => {
            await setup();

            const results = await Promise.all(Array.from({ length: 8 }, () => hero.runPromotion({ now: MIDNIGHT_IST })));

            assert.equal(results.filter((r) => r.promoted).length, 1);
            assert.equal(fake.state.destroys.length, 3);
            assert.equal((await sets()).live.length, 2);
        });

        it("parallel requests of one server share the switch and all see the finished result", async () => {
            await setup();

            const [first, second] = await Promise.all([hero.promoteIfDue({ now: MIDNIGHT_IST }), hero.promoteIfDue({ now: MIDNIGHT_IST })]);

            assert.equal(first, second);
            assert.equal(first.promoted, true);
            assert.equal(fake.state.destroys.length, 3);
        });

        it("no scheduled slides: the date is cleared and the live slides and pictures stay", async () => {
            await seedSlides("live", 3);
            await planSwitch(SWITCH_DAY);

            const outcome = await hero.promoteIfDue({ now: MIDNIGHT_IST });

            assert.deepEqual(outcome, { promoted: false, reason: "no_scheduled_slides" });
            assert.equal((await sets()).live.length, 3);
            assert.equal(await switchDate(), null);
            assert.equal(fake.state.destroys.length, 0);
        });

        it("nothing live yet: the scheduled slides simply go live and nothing is deleted", async () => {
            await seedSlides("scheduled", 2);
            await planSwitch(SWITCH_DAY);

            const outcome = await hero.promoteIfDue({ now: MIDNIGHT_IST });

            assert.equal(outcome.promoted, true);
            assert.equal((await sets()).live.length, 2);
            assert.equal(fake.state.destroys.length, 0);
        });

        it("after the switch the next call does nothing", async () => {
            await setup();
            await hero.promoteIfDue({ now: MIDNIGHT_IST });
            const destroyed = fake.state.destroys.length;

            const again = await hero.promoteIfDue({ now: new Date("2026-10-26T10:00:00Z") });

            assert.equal(again.promoted, false);
            assert.equal(fake.state.destroys.length, destroyed);
        });

        it("a database failure puts the date back so the next request retries, and the retry completes", async () => {
            captureConsole();
            await setup();
            mock.method(HeroSlide, "updateMany", async () => { throw new Error("db hiccup"); });

            await assert.rejects(hero.promoteIfDue({ now: MIDNIGHT_IST }), /db hiccup/);
            assert.equal(await switchDate(), SWITCH_DAY, "the date is back");
            assert.equal(fake.state.destroys.length, 0, "no picture was deleted for a switch that did not finish");

            mock.restoreAll();
            const retry = await hero.promoteIfDue({ now: MIDNIGHT_IST });

            assert.equal(retry.promoted, true);
            assert.deepEqual((await sets()).live, ["oceao/hero/scheduled-1", "oceao/hero/scheduled-2"]);
            assert.equal(await switchDate(), null);
        });

        it("a failed switch does not overwrite a date the admin planned meanwhile", async () => {
            captureConsole();
            await setup();
            mock.method(HeroSlide, "updateMany", async () => {
                await planSwitch("2027-01-01");
                throw new Error("db hiccup");
            });

            await assert.rejects(hero.promoteIfDue({ now: MIDNIGHT_IST }), /db hiccup/);

            assert.equal(await switchDate(), "2027-01-01");
        });
    });

    // ── GET /hero ────────────────────────────────────────────────────────────
    describe("GET /api/v1/hero", () => {
        const get = (query = "") => request(getApp()).get(`/api/v1/hero${query}`);

        it("lists the live slides by order in the documented shape", async () => {
            await HeroSlide.insertMany([slide("live", 2), slide("live", 1), slide("live", 3)]);

            const res = await get();

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.deepEqual(Object.keys(res.body.data), ["slides"]);
            assert.deepEqual(res.body.data.slides.map((s) => s.name), ["live slide 1", "live slide 2", "live slide 3"]);
            const first = res.body.data.slides[0];
            assert.deepEqual(Object.keys(first), ["id", "imageUrl", "name", "location", "description", "credit"]);
            assert.match(first.id, /^[0-9a-f]{24}$/);
            assert.equal(first.imageUrl, "https://res.cloudinary.com/test-cloud/image/upload/f_auto,q_auto,w_1920,c_limit/oceao/hero/live-1");
            assert.equal(first.location, "Himachal Pradesh");
            assert.equal(first.description, "A short description.");
            assert.equal(first.credit, "Photo: A. Kumar");
        });

        it("leaves credit out when the slide has none (key absent, not null or empty)", async () => {
            await HeroSlide.insertMany([slide("live", 1, { credit: undefined }), slide("live", 2, { credit: "" })]);

            const res = await get();

            for (const entry of res.body.data.slides) {
                assert.ok(!("credit" in entry), JSON.stringify(entry));
                assert.deepEqual(Object.keys(entry), ["id", "imageUrl", "name", "location", "description"]);
            }
        });

        it("shows only live slides, never the scheduled ones, and nothing internal", async () => {
            await seedSlides("live", 1);
            await seedSlides("scheduled", 2);

            const res = await get();

            assert.equal(res.body.data.slides.length, 1);
            const text = JSON.stringify(res.body);
            for (const hidden of ["scheduled", "publicId", "width", "height", "createdAt", "oceao/hero/live-1.jpg", "url\""]) {
                assert.ok(!text.includes(hidden), `leaked ${hidden}`);
            }
        });

        it("is an empty array when there are no slides", async () => {
            const res = await get();

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { slides: [] });
        });

        it("is cacheable for 5 minutes", async () => {
            assert.equal((await get()).headers["cache-control"], "public, max-age=300");
        });

        it("takes no input: a query key is 400", async () => {
            const res = await get("?set=scheduled");

            assert.equal(res.status, 400);
            assert.equal(res.body.code, "VALIDATION_FAILED");
        });

        it("does the switch first when the date has come, and answers with the new set", async () => {
            await seedSlides("live", 2);
            await seedSlides("scheduled", 3);
            await planSwitch("2000-01-01");

            const res = await get();

            assert.deepEqual(res.body.data.slides.map((s) => s.name), ["scheduled slide 1", "scheduled slide 2", "scheduled slide 3"]);
            assert.equal(await switchDate(), null);
            assert.equal(fake.state.destroys.length, 2);
        });

        it("does not switch before the date", async () => {
            await seedSlides("live", 2);
            await seedSlides("scheduled", 3);
            await planSwitch("2999-01-01");

            const res = await get();

            assert.equal(res.body.data.slides.length, 2);
            assert.equal(await switchDate(), "2999-01-01");
        });

        it("many visitors at the moment of the switch all get a complete list, and it switches once", async () => {
            await seedSlides("live", 2);
            await seedSlides("scheduled", 3);
            await planSwitch("2000-01-01");

            const responses = await Promise.all(Array.from({ length: 6 }, () => get()));

            for (const res of responses) {
                assert.deepEqual(res.body.data.slides.map((s) => s.name), ["scheduled slide 1", "scheduled slide 2", "scheduled slide 3"]);
            }
            assert.equal(fake.state.destroys.length, 2);
        });

        it("a switch that fails is logged and the visitor still gets the slides that exist", async () => {
            const lines = captureConsole();
            await seedSlides("live", 2);
            await seedSlides("scheduled", 1);
            await planSwitch("2000-01-01");
            mock.method(HeroSlide, "updateMany", async () => { throw new Error("db hiccup"); });

            const res = await get();

            assert.equal(res.status, 200);
            assert.equal(res.body.data.slides.length, await HeroSlide.countDocuments({ set: "live" }), "whatever is live right now");
            assert.equal(res.headers["cache-control"], "no-store", "a possibly incomplete answer is not cached");
            assert.match(lines.join("\n"), /Hero switch failed/);
            assert.equal(await switchDate(), "2000-01-01", "the date is back for the next request");
        });
    });
});
