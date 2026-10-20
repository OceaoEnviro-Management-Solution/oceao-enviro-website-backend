// Admin hero endpoints: list, add (multipart), edit, delete, reorder, schedule. Cloudinary is a fake.

import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
import {
    startTestEnv, stopTestEnv, resetState, getApp, PNG_BUFFER, PDF_BUFFER,
    TEST_ORIGIN, TEST_ADMIN_PASSWORD_HASH, TEST_ADMIN_JWT_SECRET,
} from "./helpers/setup.js";

const BASE = "/api/v1/admin/hero";
const MB = 1024 * 1024;

let cloudinary;
let HeroSlide;
let Settings;
let AuditLog;
let fake;

// ── Fakes and fixtures ───────────────────────────────────────────────────────

// A stand-in for the Cloudinary SDK. Uploads get new ids; every call is recorded, and for each
// delete we note whether that picture's database row still existed at that moment.
const makeFake = () => {
    const state = { uploads: [], destroys: [], failUpload: false, failDestroy: false, rowStillThereAtDestroy: [], counter: 0 };
    return {
        state,
        uploader: {
            upload_stream(options, done) {
                state.uploads.push({ options });
                return {
                    end(buffer) {
                        const publicId = `oceao/hero/up${++state.counter}`;
                        state.uploads.at(-1).buffer = buffer;
                        state.uploads.at(-1).publicId = publicId;
                        queueMicrotask(() => {
                            if (state.failUpload) return done(new Error("cloudinary is down"));
                            done(null, { public_id: publicId, secure_url: `https://res.cloudinary.com/test-cloud/image/upload/v1/${publicId}.jpg`, width: 4000, height: 2250 });
                        });
                    },
                };
            },
            async destroy(publicId) {
                state.destroys.push(publicId);
                state.rowStillThereAtDestroy.push(Boolean(await HeroSlide.exists({ publicId })));
                if (state.failDestroy) throw new Error("cloudinary is down");
                return { result: "ok" };
            },
        },
    };
};

const JPEG_BUFFER = Buffer.concat([Buffer.from("ffd8ffe000104a4649460001010000010001", "hex"), Buffer.alloc(64)]);
const WEBP_BUFFER = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x30, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(40)]);
const GIF_BUFFER = Buffer.from("GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00;", "binary");
const TEXT_BUFFER = Buffer.from("this is only text pretending to be a picture");

const passwordVersion = crypto.createHash("sha256").update(TEST_ADMIN_PASSWORD_HASH).digest("hex").slice(0, 12);
const sessionCookie = () =>
    `oe_admin=${jwt.sign({ sub: "admin", pwv: passwordVersion }, TEST_ADMIN_JWT_SECRET, { algorithm: "HS256", expiresIn: 3600 })}`;

const FORM = { set: "live", name: "Rohtang Pass", location: "Himachal Pradesh", description: "Early snow on the pass.", performedBy: "Anita" };

// POST /hero/slides as the admin screen would send it
const upload = ({ file = PNG_BUFFER, filename = "photo.png", type = "image/png", fields = {}, origin = TEST_ORIGIN, cookie = true, fileField = "image" } = {}) => {
    const req = request(getApp()).post(`${BASE}/slides`);
    if (origin) req.set("Origin", origin);
    if (cookie) req.set("Cookie", sessionCookie());
    for (const [key, value] of Object.entries({ ...FORM, ...fields })) if (value !== undefined) req.field(key, value);
    if (file) req.attach(fileField, file, { filename, contentType: type });
    return req;
};

// The JSON writes
const send = (method, path, body = {}, { origin = TEST_ORIGIN, cookie = true } = {}) => {
    const req = request(getApp())[method](`${BASE}${path}`).set("Content-Type", "application/json");
    if (origin) req.set("Origin", origin);
    if (cookie) req.set("Cookie", sessionCookie());
    return req.send(body);
};
const get = (cookie = true) => {
    const req = request(getApp()).get(BASE);
    return cookie ? req.set("Cookie", sessionCookie()) : req;
};

const slide = (set, order, overrides = {}) => ({
    set, order,
    publicId: `oceao/hero/${set}-${order}`,
    url: `https://res.cloudinary.com/test-cloud/image/upload/v1/oceao/hero/${set}-${order}.jpg`,
    width: 3000, height: 2000,
    name: `${set} slide ${order}`, location: "Himachal Pradesh", description: "A short description.", credit: "Photo: A. Kumar",
    ...overrides,
});
const seed = async (set, count) => HeroSlide.insertMany(Array.from({ length: count }, (_, index) => slide(set, index)));
const rows = async (set) => (await HeroSlide.find({ set }).sort({ order: 1, _id: 1 }).lean());
const audits = (action) => AuditLog.find({ action }).lean();
const quiet = () => { for (const method of ["log", "warn", "error"]) mock.method(console, method, () => {}); };

describe("Admin hero", () => {
    before(async () => {
        await startTestEnv();
        cloudinary = await import("../src/services/cloudinary.service.js");
        ({ HeroSlide } = await import("../src/models/heroSlide.model.js"));
        ({ Settings } = await import("../src/models/settings.model.js"));
        ({ AuditLog } = await import("../src/models/auditLog.model.js"));
    });
    after(stopTestEnv);
    beforeEach(async () => {
        await resetState();
        fake = makeFake();
        cloudinary.setCloudinaryClient(fake);
    });
    afterEach(() => {
        mock.restoreAll();
        mock.timers.reset();
        cloudinary.setCloudinaryClient(null);
    });

    // ── Access ───────────────────────────────────────────────────────────────
    describe("access", () => {
        const ID = "0123456789abcdef01234567";
        const WRITES = [
            ["post", "/slides"], ["patch", `/slides/${ID}`], ["delete", `/slides/${ID}`],
            ["put", "/order"], ["put", "/schedule"], ["delete", "/schedule"],
        ];

        it("GET /admin/hero needs an admin session", async () => {
            const res = await get(false);

            assert.equal(res.status, 401);
            assert.equal(res.body.code, "ADMIN_UNAUTHORIZED");
        });

        for (const [method, path] of WRITES) {
            it(`${method.toUpperCase()} ${path.replace(ID, ":id")}: no session is 401 and nothing happens`, async () => {
                const res = method === "post"
                    ? await upload({ cookie: false })
                    : await send(method, path, { performedBy: "Anita" }, { cookie: false });

                assert.equal(res.status, 401);
                assert.equal(await HeroSlide.countDocuments(), 0);
                assert.equal(fake.state.uploads.length + fake.state.destroys.length, 0);
                assert.equal(await AuditLog.countDocuments(), 0);
            });

            it(`${method.toUpperCase()} ${path.replace(ID, ":id")}: a foreign Origin is 403 CSRF_REJECTED`, async () => {
                const res = method === "post"
                    ? await upload({ origin: "https://evil.example" })
                    : await send(method, path, { performedBy: "Anita" }, { origin: "https://evil.example" });

                assert.equal(res.status, 403);
                assert.equal(res.body.code, "CSRF_REJECTED");
                assert.equal(await HeroSlide.countDocuments(), 0);
            });

            it(`${method.toUpperCase()} ${path.replace(ID, ":id")}: no Origin is 403 CSRF_REJECTED`, async () => {
                const res = method === "post"
                    ? await upload({ origin: null })
                    : await send(method, path, { performedBy: "Anita" }, { origin: null });

                assert.equal(res.status, 403);
            });
        }

        it("only the upload route takes multipart/form-data; JSON there is rejected", async () => {
            const res = await send("post", "/slides", { ...FORM });

            assert.equal(res.status, 403);
            assert.equal(res.body.code, "CSRF_REJECTED");
        });

        it("no other route accepts multipart/form-data (the Origin check is not enough)", async () => {
            const [patchRes, orderRes] = await Promise.all([
                request(getApp()).patch(`${BASE}/slides/0123456789abcdef01234567`).set("Cookie", sessionCookie()).set("Origin", TEST_ORIGIN).field("name", "Changed"),
                request(getApp()).put(`${BASE}/order`).set("Cookie", sessionCookie()).set("Origin", TEST_ORIGIN).field("set", "live"),
            ]);

            assert.equal(patchRes.status, 403);
            assert.equal(orderRes.status, 403);
        });
    });

    // ── GET ──────────────────────────────────────────────────────────────────
    describe("GET /admin/hero", () => {
        it("is empty before anything is added", async () => {
            const res = await get();

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { live: [], scheduled: { switchDate: null, slides: [] } });
        });

        it("lists both sets by order with every field, including publicId and the delivery link", async () => {
            await HeroSlide.insertMany([slide("live", 1), slide("live", 0), slide("scheduled", 0, { credit: undefined })]);
            await Settings.create({ key: "main", callbackCapacity: { morning: 5, afternoon: 5, evening: 3 }, heroSwitchDate: "2999-01-01" });

            const res = await get();

            assert.deepEqual(res.body.data.live.map((s) => s.order), [0, 1]);
            assert.equal(res.body.data.scheduled.switchDate, "2999-01-01");
            const first = res.body.data.live[0];
            assert.deepEqual(Object.keys(first).sort(), [
                "createdAt", "credit", "description", "height", "id", "imageUrl", "location", "name", "order", "publicId", "set", "updatedAt", "url", "width",
            ]);
            assert.equal(first.publicId, "oceao/hero/live-0");
            assert.equal(first.imageUrl, "https://res.cloudinary.com/test-cloud/image/upload/f_auto,q_auto,w_1920,c_limit/oceao/hero/live-0");
            assert.match(first.id, /^[0-9a-f]{24}$/);
            assert.equal(res.body.data.scheduled.slides[0].credit, null, "no credit is null for the admin");
        });

        it("does the planned switch first when its day has come", async () => {
            await seed("live", 2);
            await seed("scheduled", 3);
            await Settings.create({ key: "main", callbackCapacity: { morning: 5, afternoon: 5, evening: 3 }, heroSwitchDate: "2000-01-01" });

            const res = await get();

            assert.equal(res.body.data.live.length, 3);
            assert.deepEqual(res.body.data.scheduled, { switchDate: null, slides: [] });
            assert.equal(fake.state.destroys.length, 2);
        });

        it("takes no input: a query key is 400", async () => {
            const res = await request(getApp()).get(`${BASE}?set=live`).set("Cookie", sessionCookie());

            assert.equal(res.status, 400);
        });
    });

    // ── Add ──────────────────────────────────────────────────────────────────
    describe("POST /admin/hero/slides", () => {
        it("uploads the picture and saves the slide", async () => {
            const res = await upload({ fields: { credit: "Photo: A. Kumar" } });

            assert.equal(res.status, 201);
            const created = res.body.data.slide;
            assert.equal(created.set, "live");
            assert.equal(created.order, 0);
            assert.equal(created.name, "Rohtang Pass");
            assert.equal(created.location, "Himachal Pradesh");
            assert.equal(created.description, "Early snow on the pass.");
            assert.equal(created.credit, "Photo: A. Kumar");
            assert.equal(created.publicId, "oceao/hero/up1");
            assert.equal(created.width, 4000);
            assert.equal(created.imageUrl, "https://res.cloudinary.com/test-cloud/image/upload/f_auto,q_auto,w_1920,c_limit/oceao/hero/up1");
            assert.equal(fake.state.uploads.length, 1);
            assert.equal(fake.state.uploads[0].options.folder, "oceao/hero");
            assert.ok(fake.state.uploads[0].buffer.equals(PNG_BUFFER), "the uploaded bytes are the file's");
            assert.equal(await HeroSlide.countDocuments(), 1);
        });

        it("credit is optional: left out or blank, the slide has none", async () => {
            const a = await upload();
            const b = await upload({ fields: { credit: "   " } });

            assert.equal(a.status, 201);
            assert.equal(b.status, 201);
            assert.equal(a.body.data.slide.credit, null);
            assert.equal(b.body.data.slide.credit, null);
            assert.equal((await HeroSlide.findOne({ publicId: "oceao/hero/up2" }).lean()).credit, undefined);
        });

        it("each new slide goes last: order is the highest + 1, per set", async () => {
            await upload();
            await upload();
            await upload({ fields: { set: "scheduled" } });
            await HeroSlide.updateOne({ publicId: "oceao/hero/up2" }, { $set: { order: 7 } });   // a gap: still "last + 1"

            const res = await upload();

            assert.equal(res.body.data.slide.order, 8);
            assert.deepEqual((await rows("scheduled")).map((s) => s.order), [0]);
        });

        it("records an audit entry with who did it and which slide", async () => {
            const res = await upload();

            const [entry] = await audits("hero.slide.add");
            assert.equal(await AuditLog.countDocuments(), 1);
            assert.equal(entry.performedBy, "Anita");
            assert.equal(entry.targetType, "hero_slide");
            assert.equal(entry.targetId, res.body.data.slide.id);
            assert.deepEqual(entry.detail, { set: "live", order: 0 });
        });

        it("accepts a real JPG, PNG and WebP", async () => {
            const jpg = await upload({ file: JPEG_BUFFER, filename: "a.jpg", type: "image/jpeg" });
            const png = await upload({ file: PNG_BUFFER, filename: "a.png", type: "image/png" });
            const webp = await upload({ file: WEBP_BUFFER, filename: "a.webp", type: "image/webp" });

            assert.deepEqual([jpg.status, png.status, webp.status], [201, 201, 201]);
        });

        it("the real type decides: a PNG sent as image/jpeg is still a picture", async () => {
            const res = await upload({ file: PNG_BUFFER, filename: "photo.jpg", type: "image/jpeg" });

            assert.equal(res.status, 201);
        });

        describe("a 6th slide", () => {
            it("is 409 SET_FULL and nothing is uploaded", async () => {
                await seed("live", 5);

                const res = await upload();

                assert.equal(res.status, 409);
                assert.equal(res.body.code, "SET_FULL");
                assert.equal(fake.state.uploads.length, 0, "refused before uploading");
                assert.equal(await HeroSlide.countDocuments({ set: "live" }), 5);
                assert.equal(await AuditLog.countDocuments(), 0);
            });

            it("the other set still takes slides", async () => {
                await seed("live", 5);

                const res = await upload({ fields: { set: "scheduled" } });

                assert.equal(res.status, 201);
            });

            it("a 5th slide is fine", async () => {
                await seed("live", 4);

                const res = await upload();

                assert.equal(res.status, 201);
                assert.equal(res.body.data.slide.order, 4);
            });

            it("several uploads at the same moment never leave more than 5, and no picture is left behind", async () => {
                quiet();
                await seed("live", 4);

                const responses = await Promise.all([upload(), upload(), upload()]);

                assert.ok(responses.every((res) => [201, 409].includes(res.status)), responses.map((r) => r.status).join());
                assert.ok((await HeroSlide.countDocuments({ set: "live" })) <= 5);
                for (const { publicId } of fake.state.uploads) {
                    const kept = Boolean(await HeroSlide.exists({ publicId }));
                    assert.equal(fake.state.destroys.includes(publicId), !kept, `${publicId}: kept in the database XOR deleted from Cloudinary`);
                }
            });
        });

        describe("the file", () => {
            it("a file that is not a picture, called image/jpeg, is 400 INVALID_FILE_TYPE and not uploaded", async () => {
                const res = await upload({ file: TEXT_BUFFER, filename: "photo.jpg", type: "image/jpeg" });

                assert.equal(res.status, 400);
                assert.equal(res.body.code, "INVALID_FILE_TYPE");
                assert.equal(fake.state.uploads.length, 0);
                assert.equal(await HeroSlide.countDocuments(), 0);
            });

            it("a PDF called image/png is rejected", async () => {
                const res = await upload({ file: PDF_BUFFER, filename: "photo.png", type: "image/png" });

                assert.equal(res.status, 400);
                assert.equal(res.body.code, "INVALID_FILE_TYPE");
                assert.equal(fake.state.uploads.length, 0);
            });

            it("a GIF called image/jpeg is rejected (only jpg, png and webp)", async () => {
                const res = await upload({ file: GIF_BUFFER, filename: "photo.jpg", type: "image/jpeg" });

                assert.equal(res.status, 400);
                assert.equal(res.body.code, "INVALID_FILE_TYPE");
            });

            it("a file that says it is a PDF, GIF or SVG is rejected by its declared type too", async () => {
                for (const [file, type, filename] of [[PDF_BUFFER, "application/pdf", "a.pdf"], [GIF_BUFFER, "image/gif", "a.gif"], [Buffer.from("<svg/>"), "image/svg+xml", "a.svg"]]) {
                    const res = await upload({ file, type, filename });

                    assert.equal(res.status, 400, type);
                    assert.equal(res.body.code, "INVALID_FILE_TYPE", type);
                }
                assert.equal(fake.state.uploads.length, 0);
            });

            it("a file of more than 10 MB is 413 FILE_TOO_LARGE and not uploaded", async () => {
                const big = Buffer.concat([PNG_BUFFER, Buffer.alloc(10 * MB)]);

                const res = await upload({ file: big });

                assert.equal(res.status, 413);
                assert.equal(res.body.code, "FILE_TOO_LARGE");
                assert.match(res.body.message, /10 MB/);
                assert.equal(fake.state.uploads.length, 0);
                assert.equal(await HeroSlide.countDocuments(), 0);
            });

            it("a file of exactly 10 MB is accepted", async () => {
                const exact = Buffer.concat([PNG_BUFFER, Buffer.alloc(10 * MB - PNG_BUFFER.length)]);

                const res = await upload({ file: exact });

                assert.equal(res.status, 201);
            });

            it("no image is 400 VALIDATION_FAILED", async () => {
                const res = await upload({ file: null });

                assert.equal(res.status, 400);
                assert.equal(res.body.code, "VALIDATION_FAILED");
                assert.ok(res.body.errors.image);
            });

            it("a file under another field name, or two files, is 400 UPLOAD_ERROR", async () => {
                const wrongName = await upload({ fileField: "photo" });
                const two = await upload().attach("image", PNG_BUFFER, { filename: "b.png", contentType: "image/png" });

                assert.equal(wrongName.status, 400);
                assert.equal(wrongName.body.code, "UPLOAD_ERROR");
                assert.equal(two.status, 400);
                assert.equal(fake.state.uploads.length, 0);
            });
        });

        describe("the text fields", () => {
            const refused = async (fields, field) => {
                const res = await upload({ fields });

                assert.equal(res.status, 400, JSON.stringify(fields));
                assert.equal(res.body.code, "VALIDATION_FAILED");
                assert.ok(res.body.errors[field], `${field}: ${JSON.stringify(res.body.errors)}`);
                assert.equal(fake.state.uploads.length, 0, "nothing is uploaded for a bad form");
            };

            it("set must be live or scheduled", async () => {
                await refused({ set: "draft" }, "set");
                await refused({ set: undefined }, "set");
            });

            it("name and location: 2 to 80 characters", async () => {
                await refused({ name: "A" }, "name");
                await refused({ name: "x".repeat(81) }, "name");
                await refused({ name: undefined }, "name");
                await refused({ location: " " }, "location");
                await refused({ location: "x".repeat(81) }, "location");
            });

            it("description: required, at most 120", async () => {
                await refused({ description: "" }, "description");
                await refused({ description: undefined }, "description");
                await refused({ description: "x".repeat(121) }, "description");
                assert.equal((await upload({ fields: { description: "x".repeat(120) } })).status, 201);
            });

            it("credit: at most 80", async () => {
                await refused({ credit: "x".repeat(81) }, "credit");
            });

            it("performedBy is required (2 to 60 characters)", async () => {
                await refused({ performedBy: undefined }, "performedBy");
                await refused({ performedBy: "A" }, "performedBy");
            });

            it("an unknown field is 400 (a client cannot set order, publicId or url)", async () => {
                await refused({ order: "0" }, "order");
                await refused({ publicId: "oceao/hero/x" }, "publicId");
                await refused({ url: "https://evil.example/x.jpg" }, "url");
            });
        });

        it("if Cloudinary fails: 502 IMAGE_UPLOAD_FAILED and nothing is saved", async () => {
            quiet();
            fake.state.failUpload = true;

            const res = await upload();

            assert.equal(res.status, 502);
            assert.equal(res.body.code, "IMAGE_UPLOAD_FAILED");
            assert.equal(await HeroSlide.countDocuments(), 0);
            assert.equal(await AuditLog.countDocuments(), 0);
        });

        it("if saving to the database fails after the upload, the uploaded picture is deleted", async () => {
            quiet();
            mock.method(HeroSlide, "create", async () => { throw new Error("db hiccup"); });

            const res = await upload();

            assert.equal(res.status, 500);
            assert.equal(fake.state.uploads.length, 1);
            assert.deepEqual(fake.state.destroys, ["oceao/hero/up1"], "that very picture is deleted");
            assert.equal(await HeroSlide.countDocuments(), 0);
            assert.equal(await AuditLog.countDocuments(), 0);
        });
    });

    // ── Edit ─────────────────────────────────────────────────────────────────
    describe("PATCH /admin/hero/slides/:id", () => {
        const patch = (id, body) => send("patch", `/slides/${id}`, { performedBy: "Anita", ...body });
        const idOf = async (set = "live", order = 0) => String((await HeroSlide.findOne({ set, order }).lean())._id);

        beforeEach(async () => { await seed("live", 2); });

        it("edits the texts and nothing else", async () => {
            const id = await idOf();
            const before = await HeroSlide.findById(id).lean();

            const res = await patch(id, { name: "New name", location: "Spiti", description: "New description", credit: "Photo: B. Singh" });

            assert.equal(res.status, 200);
            const slideNow = res.body.data.slide;
            assert.deepEqual([slideNow.name, slideNow.location, slideNow.description, slideNow.credit], ["New name", "Spiti", "New description", "Photo: B. Singh"]);
            const after = await HeroSlide.findById(id).lean();
            for (const key of ["publicId", "url", "width", "height", "set", "order"]) assert.equal(after[key], before[key], key);
            assert.equal(fake.state.uploads.length + fake.state.destroys.length, 0, "Cloudinary is not touched");
        });

        it("edits one field and leaves the others", async () => {
            const id = await idOf();

            const res = await patch(id, { name: "Only the name" });

            assert.equal(res.body.data.slide.name, "Only the name");
            assert.equal(res.body.data.slide.location, "Himachal Pradesh");
        });

        it("credit '' or null removes the credit", async () => {
            const first = await idOf("live", 0);
            const second = await idOf("live", 1);

            const a = await patch(first, { credit: "" });
            const b = await patch(second, { credit: null });

            assert.equal(a.body.data.slide.credit, null);
            assert.equal(b.body.data.slide.credit, null);
            assert.equal((await HeroSlide.findById(first).lean()).credit, undefined);
        });

        it("records an audit entry naming the fields changed", async () => {
            const id = await idOf();

            await patch(id, { name: "New name", credit: null });

            const [entry] = await audits("hero.slide.edit");
            assert.equal(entry.targetId, id);
            assert.equal(entry.performedBy, "Anita");
            assert.deepEqual(entry.detail.fields.sort(), ["credit", "name"]);
        });

        it("the picture cannot be changed: any image or storage field is 400 and nothing changes", async () => {
            const id = await idOf();
            const before = await HeroSlide.findById(id).lean();

            for (const body of [
                { name: "x1", image: "data:image/png;base64,AAAA" },
                { name: "x2", publicId: "oceao/hero/other" },
                { name: "x3", url: "https://evil.example/x.jpg" },
                { name: "x4", width: 1 },
                { name: "x5", set: "scheduled" },
                { name: "x6", order: 3 },
                { image: "x" },
            ]) {
                const res = await patch(id, body);

                assert.equal(res.status, 400, JSON.stringify(body));
                assert.equal(res.body.code, "VALIDATION_FAILED");
            }
            assert.deepEqual(await HeroSlide.findById(id).lean(), before);
            assert.equal(await AuditLog.countDocuments(), 0);
        });

        it("a file sent to PATCH is rejected (multipart is not accepted here)", async () => {
            const id = await idOf();

            const res = await request(getApp()).patch(`${BASE}/slides/${id}`).set("Cookie", sessionCookie()).set("Origin", TEST_ORIGIN)
                .field("performedBy", "Anita").attach("image", PNG_BUFFER, { filename: "a.png", contentType: "image/png" });

            assert.equal(res.status, 403);
            assert.equal(fake.state.uploads.length, 0);
        });

        it("needs at least one text field, and the limits apply", async () => {
            const id = await idOf();

            for (const body of [{}, { name: "A" }, { name: "x".repeat(81) }, { location: "" }, { description: "x".repeat(121) }, { credit: "x".repeat(81) }, { credit: 5 }]) {
                const res = await patch(id, body);

                assert.equal(res.status, 400, JSON.stringify(body));
            }
        });

        it("performedBy is required", async () => {
            const id = await idOf();

            const res = await send("patch", `/slides/${id}`, { name: "New name" });

            assert.equal(res.status, 400);
            assert.ok(res.body.errors.performedBy);
        });

        it("an unknown slide is 404 and a malformed id is 400", async () => {
            const missing = await patch("0123456789abcdef01234567", { name: "New name" });
            const malformed = await patch("not-an-id", { name: "New name" });

            assert.equal(missing.status, 404);
            assert.equal(malformed.status, 400);
        });
    });

    // ── Delete ───────────────────────────────────────────────────────────────
    describe("DELETE /admin/hero/slides/:id", () => {
        const remove = (id, body = { performedBy: "Anita" }) => send("delete", `/slides/${id}`, body);
        const idOf = async (set, order) => String((await HeroSlide.findOne({ set, order }).lean())._id);

        it("deletes the row, then the picture from Cloudinary", async () => {
            await seed("live", 3);
            const id = await idOf("live", 1);

            const res = await remove(id);

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { id, set: "live", remaining: 2 });
            assert.equal(await HeroSlide.findById(id), null);
            assert.deepEqual(fake.state.destroys, ["oceao/hero/live-1"]);
            assert.deepEqual(fake.state.rowStillThereAtDestroy, [false], "the database row was already gone when the picture was deleted");
        });

        it("renumbers the rest of that set 0..n-1, keeping their order", async () => {
            await seed("live", 4);
            await seed("scheduled", 3);

            await remove(await idOf("live", 1));

            assert.deepEqual((await rows("live")).map((s) => [s.order, s.publicId]), [[0, "oceao/hero/live-0"], [1, "oceao/hero/live-2"], [2, "oceao/hero/live-3"]]);
            assert.deepEqual((await rows("scheduled")).map((s) => s.order), [0, 1, 2], "the other set is untouched");
        });

        it("renumbers a set that had gaps", async () => {
            await HeroSlide.insertMany([slide("live", 2), slide("live", 5), slide("live", 9)]);

            await remove(await idOf("live", 5));

            assert.deepEqual((await rows("live")).map((s) => [s.order, s.publicId]), [[0, "oceao/hero/live-2"], [1, "oceao/hero/live-9"]]);
        });

        it("deleting the last slide of a set leaves it empty", async () => {
            await seed("scheduled", 1);

            const res = await remove(await idOf("scheduled", 0));

            assert.equal(res.body.data.remaining, 0);
            assert.equal(await HeroSlide.countDocuments(), 0);
        });

        it("a Cloudinary failure does not fail the delete: the slide is gone and it is logged", async () => {
            quiet();
            await seed("live", 2);
            fake.state.failDestroy = true;

            const res = await remove(await idOf("live", 0));

            assert.equal(res.status, 200);
            assert.equal(await HeroSlide.countDocuments(), 1);
            assert.deepEqual((await rows("live")).map((s) => s.order), [0]);
        });

        it("records an audit entry", async () => {
            await seed("live", 2);
            const id = await idOf("live", 0);

            await remove(id);

            const [entry] = await audits("hero.slide.delete");
            assert.equal(entry.targetId, id);
            assert.equal(entry.performedBy, "Anita");
            assert.deepEqual(entry.detail, { set: "live", remaining: 1 });
        });

        it("an unknown slide is 404 (and no picture is deleted); performedBy is required", async () => {
            await seed("live", 1);

            const missing = await remove("0123456789abcdef01234567");
            const noName = await remove(await idOf("live", 0), {});
            const extra = await remove(await idOf("live", 0), { performedBy: "Anita", force: true });

            assert.equal(missing.status, 404);
            assert.equal(noName.status, 400);
            assert.equal(extra.status, 400);
            assert.equal(await HeroSlide.countDocuments(), 1);
            assert.equal(fake.state.destroys.length, 0);
        });

        it("deleting twice: the second is 404 and does not delete the picture again", async () => {
            await seed("live", 1);
            const id = await idOf("live", 0);

            await remove(id);
            const again = await remove(id);

            assert.equal(again.status, 404);
            assert.equal(fake.state.destroys.length, 1);
        });
    });

    // ── Reorder ──────────────────────────────────────────────────────────────
    describe("PUT /admin/hero/order", () => {
        const put = (body) => send("put", "/order", { performedBy: "Anita", ...body });
        const ids = async (set) => (await rows(set)).map((s) => String(s._id));

        it("sets the new order, with one bulkWrite", async () => {
            await seed("live", 4);
            const [a, b, c, d] = await ids("live");
            const bulk = mock.method(HeroSlide, "bulkWrite");
            const single = mock.method(HeroSlide, "updateOne");

            const res = await put({ set: "live", ids: [d, b, a, c] });

            assert.equal(res.status, 200);
            assert.equal(bulk.mock.callCount(), 1, "one bulkWrite");
            assert.equal(single.mock.callCount(), 0, "and no write per slide");
            assert.deepEqual(res.body.data.slides.map((s) => [s.id, s.order]), [[d, 0], [b, 1], [a, 2], [c, 3]]);
            assert.deepEqual(await ids("live"), [d, b, a, c]);
        });

        it("accepts ids in capital letters", async () => {
            await seed("live", 2);
            const [a, b] = await ids("live");

            const res = await put({ set: "live", ids: [b.toUpperCase(), a.toUpperCase()] });

            assert.equal(res.status, 200);
            assert.deepEqual(await ids("live"), [b, a]);
        });

        it("only touches the named set", async () => {
            await seed("live", 2);
            await seed("scheduled", 2);
            const [a, b] = await ids("scheduled");

            await put({ set: "scheduled", ids: [b, a] });

            assert.deepEqual((await rows("live")).map((s) => s.order), [0, 1]);
        });

        it("records an audit entry for the set", async () => {
            await seed("live", 2);
            const [a, b] = await ids("live");

            await put({ set: "live", ids: [b, a] });

            const [entry] = await audits("hero.order");
            assert.equal(entry.targetType, "hero_set");
            assert.equal(entry.targetId, "live");
            assert.equal(entry.performedBy, "Anita");
            assert.deepEqual(entry.detail.ids, [b, a]);
        });

        describe("ids that are not exactly the set's slides are 400 and nothing changes", () => {
            const BAD = {
                "one missing": (x) => [x[0], x[1]],
                "one extra (unknown)": (x) => [...x, "0123456789abcdef01234567"],
                "a duplicate": (x) => [x[0], x[0], x[1]],
                "an unknown id instead of one": (x) => [x[0], x[1], "0123456789abcdef01234567"],
                "no ids": () => [],
                "an id that is not an id": (x) => [x[0], x[1], "nope"],
            };

            for (const [name, make] of Object.entries(BAD)) {
                it(name, async () => {
                    await seed("live", 3);
                    const current = await ids("live");
                    const bulk = mock.method(HeroSlide, "bulkWrite");

                    const res = await put({ set: "live", ids: make(current) });

                    assert.equal(res.status, 400);
                    assert.equal(res.body.code, "VALIDATION_FAILED");
                    assert.ok(res.body.errors.ids);
                    assert.deepEqual(await ids("live"), current);
                    assert.equal(bulk.mock.callCount(), 0);
                    assert.equal(await AuditLog.countDocuments(), 0);
                });
            }

            it("ids of the other set", async () => {
                await seed("live", 2);
                await seed("scheduled", 2);

                const res = await put({ set: "live", ids: await ids("scheduled") });

                assert.equal(res.status, 400);
            });

            it("ids that are not a list, an unknown set, a missing performedBy, an extra field", async () => {
                await seed("live", 2);
                const current = await ids("live");

                for (const body of [{ set: "live", ids: current[0] }, { set: "draft", ids: current }, { set: "live", ids: current, extra: 1 }]) {
                    assert.equal((await put(body)).status, 400, JSON.stringify(body));
                }
                assert.equal((await send("put", "/order", { set: "live", ids: current })).status, 400);
            });

            it("more than 5 ids", async () => {
                await seed("live", 5);

                const res = await put({ set: "live", ids: [...(await ids("live")), "0123456789abcdef01234567"] });

                assert.equal(res.status, 400);
            });
        });
    });

    // ── Schedule ─────────────────────────────────────────────────────────────
    describe("PUT and DELETE /admin/hero/schedule", () => {
        const put = (switchDate, extra = {}) => send("put", "/schedule", { switchDate, performedBy: "Anita", ...extra });
        const storedDate = async () => (await Settings.findOne({ key: "main" }).lean())?.heroSwitchDate ?? null;
        const dayFromNow = (days) => new Date(Date.now() + days * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);   // an IST date

        it("plans a switch for a day after today", async () => {
            const res = await put("2999-01-01");

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { switchDate: "2999-01-01", scheduledSlides: 0 });
            assert.equal(await storedDate(), "2999-01-01");
        });

        it("tomorrow is allowed; today and the past are 422 INVALID_SWITCH_DATE", async () => {
            assert.equal((await put(dayFromNow(1))).status, 200);

            for (const date of [dayFromNow(0), dayFromNow(-1), "2000-01-01"]) {
                const res = await put(date);

                assert.equal(res.status, 422, date);
                assert.equal(res.body.code, "INVALID_SWITCH_DATE", date);
                assert.ok(res.body.errors.switchDate);
            }
            assert.equal(await storedDate(), dayFromNow(1), "the earlier valid date is unchanged by the refused ones");
        });

        it("'today' is the Indian day: at 23:59 IST tomorrow is allowed, at 00:00 IST it is today and refused", async () => {
            mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-24T18:29:59.000Z") });   // 23:59:59 IST on 24 Oct
            const before = await put("2026-10-25");
            mock.timers.reset();

            mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-24T18:30:00.000Z") });   // 00:00:00 IST on 25 Oct
            const after = await put("2026-10-25");
            const onTheDayAfter = await put("2026-10-26");

            assert.equal(before.status, 200);
            assert.equal(after.status, 422);
            assert.equal(onTheDayAfter.status, 200);
        });

        it("a date that is not a date is 400", async () => {
            for (const bad of ["2026-13-45", "25-12-2999", "tomorrow", "", null, 20261225, "2999-02-30"]) {
                const res = await put(bad);

                assert.equal(res.status, 400, String(bad));
                assert.equal(res.body.code, "VALIDATION_FAILED");
            }
            assert.equal(await storedDate(), null);
        });

        it("replaces an earlier date and says how many slides are waiting", async () => {
            await seed("scheduled", 3);
            await put("2999-01-01");

            const res = await put("2999-02-02");

            assert.deepEqual(res.body.data, { switchDate: "2999-02-02", scheduledSlides: 3 });
            assert.equal(await storedDate(), "2999-02-02");
        });

        it("does not disturb the callback capacity setting", async () => {
            await Settings.create({ key: "main", callbackCapacity: { morning: 9, afternoon: 8, evening: 7 } });

            await put("2999-01-01");

            const settings = await Settings.findOne({ key: "main" }).lean();
            assert.deepEqual(settings.callbackCapacity, { morning: 9, afternoon: 8, evening: 7 });
        });

        it("records audit entries for setting and clearing, with the date and who", async () => {
            await put("2999-01-01");
            await put("2999-02-02");
            await send("delete", "/schedule", { performedBy: "Rohan" });

            const set = await audits("hero.schedule.set");
            const clear = await audits("hero.schedule.clear");
            assert.equal(set.length, 2);
            assert.equal(set[0].performedBy, "Anita");
            assert.equal(set.find((entry) => entry.date === "2999-02-02").detail.previous, "2999-01-01");
            assert.equal(clear.length, 1);
            assert.equal(clear[0].performedBy, "Rohan");
            assert.equal(clear[0].detail.previous, "2999-02-02");
        });

        it("needs performedBy and takes no other field", async () => {
            assert.equal((await send("put", "/schedule", { switchDate: "2999-01-01" })).status, 400);
            assert.equal((await put("2999-01-01", { extra: true })).status, 400);
            assert.equal((await send("delete", "/schedule", {})).status, 400);
            assert.equal((await send("delete", "/schedule", { performedBy: "Anita", extra: 1 })).status, 400);
            assert.equal(await storedDate(), null);
        });

        describe("DELETE", () => {
            it("clears the date and the scheduled slides stay as a draft", async () => {
                await seed("scheduled", 2);
                await seed("live", 1);
                await put("2999-01-01");

                const res = await send("delete", "/schedule", { performedBy: "Anita" });

                assert.equal(res.status, 200);
                assert.deepEqual(res.body.data, { switchDate: null, scheduledSlides: 2 });
                assert.equal(await storedDate(), null);
                assert.equal(await HeroSlide.countDocuments({ set: "scheduled" }), 2);
                assert.equal(fake.state.destroys.length, 0, "no picture is deleted");
            });

            it("is fine when nothing was planned (and still audited)", async () => {
                const res = await send("delete", "/schedule", { performedBy: "Anita" });

                assert.equal(res.status, 200);
                assert.equal(res.body.data.switchDate, null);
                assert.equal((await audits("hero.schedule.clear")).length, 1);
            });

            it("after clearing, the switch no longer happens on that day", async () => {
                await seed("live", 1);
                await seed("scheduled", 1);
                await Settings.create({ key: "main", callbackCapacity: { morning: 5, afternoon: 5, evening: 3 }, heroSwitchDate: "2000-01-01" });
                await send("delete", "/schedule", { performedBy: "Anita" });

                const res = await get();

                assert.equal(res.body.data.live[0].publicId, "oceao/hero/live-0", "the live set is still the old one");
                assert.equal(res.body.data.scheduled.slides.length, 1);
            });
        });
    });
});
