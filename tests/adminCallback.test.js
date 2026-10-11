import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
    startTestEnv, stopTestEnv, resetState, getApp, emailOutbox,
    TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, TEST_ORIGIN, TEST_CAPTCHA_TOKEN, TEST_COMPANY_MAIL,
} from "./helpers/setup.js";

const BASE = "/api/v1/admin";
const BLOCKS = `${BASE}/callback/blocks`;
const UNBLOCKS = `${BASE}/callback/blocks/remove`;
const CANCEL = `${BASE}/callback/requests/cancel`;
const statusUrl = (requestId) => `${BASE}/callback/requests/${requestId}`;
const CAPACITY = `${BASE}/settings/callback-capacity`;
const HOLIDAYS = `${BASE}/holidays`;
const BULK = `${BASE}/holidays/bulk`;
const holidayUrl = (date) => `${BASE}/holidays/${date}`;

// Wed 14 Oct 2026, 10:30 IST. Requests below are for Thu 15 Oct 2026.
const NOW = "2026-10-14T05:00:00Z";
const DATE = "2026-10-15";
const OTHER_DATE = "2026-10-19";      // Monday
const YESTERDAY = "2026-10-13";
const HOLIDAY = "2026-10-16";         // Friday
const SATURDAY = "2026-10-17";        // third Saturday: callbacks run
const SUNDAY = "2026-10-18";
const SECOND_SATURDAY = "2026-11-14";
const ADMIN = { performedBy: "Anita", reason: "Office closed" };

let CallbackBucket;
let CallbackRequest;
let VmBooking;
let Holiday;
let AuditLog;
let Settings;
let callbackService;
let vmBookingService;
let cookie;

const freezeTime = () => mock.timers.enable({ apis: ["Date"], now: new Date(NOW) });

const signIn = async () => {
    const res = await request(getApp())
        .post(`${BASE}/auth/login`)
        .set("Origin", TEST_ORIGIN)
        .send({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD });
    assert.equal(res.status, 200);
    cookie = res.headers["set-cookie"][0].split(";")[0];
};

const send = (method, url, body, { origin = TEST_ORIGIN, session = cookie } = {}) => {
    const req = request(getApp())[method](url).set("Content-Type", "application/json");
    if (origin) req.set("Origin", origin);
    if (session) req.set("Cookie", session);
    return req.send(body);
};
const post = (url, body, options) => send("post", url, body, options);
const patch = (url, body, options) => send("patch", url, body, options);
const put = (url, body, options) => send("put", url, body, options);
const del = (url, body, options) => send("delete", url, body, options);

// A public request the way the website sends it.
let counter = 0;
const publicRequest = (overrides = {}) =>
    request(getApp())
        .post("/api/v1/callback/requests")
        .send({
            name: "John Doe",
            email: `caller${++counter}@example.com`,
            mobileNumber: "9876543210",
            date: DATE,
            period: "morning",
            reason: "Water testing quote",
            turnstileToken: TEST_CAPTCHA_TOKEN,
            ...overrides,
        });

// A request straight from the service (when the HTTP round trip is not the point).
const addRequest = (overrides = {}) =>
    callbackService.createCallbackRequest({
        name: "John Doe",
        email: `caller${++counter}@example.com`,
        mobileNumber: "+919876543210",
        date: DATE,
        period: "morning",
        reason: "Water testing quote",
        ...overrides,
    });

const bucketOf = (date, period) => CallbackBucket.findOne({ date, period }).lean();
const audit = (action) => AuditLog.find(action ? { action } : {}).sort({ createdAt: 1, _id: 1 }).lean();

const eventually = async (predicate, { tries = 100, delay = 10 } = {}) => {
    for (let i = 0; i < tries; i++) {
        if (await predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return false;
};
const mailsTo = (email) => emailOutbox.all().filter((mail) => mail.to === email);

const publicCalendarDay = async (kind, date) => {
    const res = await request(getApp()).get(`/api/v1/${kind}/calendar?from=${date}&to=${date}`);
    assert.equal(res.status, 200);
    return res.body.data.days[0];
};

describe("Admin callback and settings actions", () => {
    before(async () => {
        await startTestEnv();
        ({ CallbackBucket } = await import("../src/models/callbackBucket.model.js"));
        ({ CallbackRequest } = await import("../src/models/callbackRequest.model.js"));
        ({ VmBooking } = await import("../src/models/vmBooking.model.js"));
        ({ Holiday } = await import("../src/models/holiday.model.js"));
        ({ AuditLog } = await import("../src/models/auditLog.model.js"));
        ({ Settings } = await import("../src/models/settings.model.js"));
        callbackService = await import("../src/services/callbackRequest.service.js");
        vmBookingService = await import("../src/services/vmBooking.service.js");
    });
    after(stopTestEnv);
    beforeEach(async () => {
        await resetState();
        freezeTime();           // before sign-in, so the session cookie is valid at the frozen time
        await signIn();
    });
    afterEach(() => {
        mock.restoreAll();
        mock.timers.reset();
    });

    // ── access and validation ─────────────────────────────────────────────────

    describe("access and validation", () => {
        const WRITES = [
            ["post", BLOCKS, { date: DATE, period: "morning", ...ADMIN }],
            ["post", UNBLOCKS, { date: DATE, period: "morning", ...ADMIN }],
            ["post", CANCEL, { requestIds: ["OE-CB-261015-M3XZ"], ...ADMIN }],
            ["patch", statusUrl("OE-CB-261015-M3XZ"), { status: "completed", performedBy: "Anita" }],
            ["put", CAPACITY, { morning: 5, afternoon: 5, evening: 3, ...ADMIN }],
            ["post", HOLIDAYS, { date: HOLIDAY, name: "Test holiday", ...ADMIN }],
            ["post", BULK, { holidays: [{ date: HOLIDAY, name: "Test holiday" }], ...ADMIN }],
            ["patch", holidayUrl(HOLIDAY), { name: "New name", ...ADMIN }],
            ["delete", holidayUrl(HOLIDAY), ADMIN],
        ];

        it("every write is 401 without a session and changes nothing", async () => {
            for (const [method, url, body] of WRITES) {
                const res = await send(method, url, body, { session: null });

                assert.equal(res.status, 401, `${method} ${url}`);
                assert.equal(res.body.code, "ADMIN_UNAUTHORIZED", `${method} ${url}`);
            }
            assert.equal(await Holiday.countDocuments(), 0);
            assert.equal(await CallbackBucket.countDocuments(), 0);
            assert.equal(await AuditLog.countDocuments(), 0);
        });

        it("every write from a foreign Origin is 403 CSRF_REJECTED", async () => {
            for (const [method, url, body] of WRITES) {
                const res = await send(method, url, body, { origin: "http://evil.example" });

                assert.equal(res.status, 403, `${method} ${url}`);
                assert.equal(res.body.code, "CSRF_REJECTED", `${method} ${url}`);
            }
            assert.equal(await Holiday.countDocuments(), 0);
            assert.equal(await AuditLog.countDocuments(), 0);
        });

        it("performedBy (2-60) and reason (3-300) are required where the contract has them", async () => {
            const withReason = WRITES.filter(([, url]) => !url.includes("/callback/requests/OE-"));
            const cases = [
                [{ performedBy: "A" }, "performedBy"],
                [{ performedBy: "x".repeat(61) }, "performedBy"],
                [{ performedBy: undefined }, "performedBy"],
                [{ reason: "ab" }, "reason"],
                [{ reason: "x".repeat(301) }, "reason"],
                [{ reason: undefined }, "reason"],
            ];

            for (const [method, url, body] of withReason) {
                for (const [patchBody, field] of cases) {
                    const res = await send(method, url, { ...body, ...patchBody });

                    assert.equal(res.status, 400, `${method} ${url} ${JSON.stringify(patchBody)}`);
                    assert.equal(res.body.code, "VALIDATION_FAILED");
                    assert.ok(res.body.errors[field], `${method} ${url} ${field}`);
                }
            }

            const status = await patch(statusUrl("OE-CB-261015-M3XZ"), { status: "completed", performedBy: "A" });
            assert.equal(status.status, 400);
            assert.ok(status.body.errors.performedBy);
            assert.equal(await AuditLog.countDocuments(), 0);
        });

        it("blocks need exactly one of period and allDay: true", async () => {
            const bad = [
                { date: DATE, ...ADMIN },
                { date: DATE, period: "morning", allDay: true, ...ADMIN },
                { date: DATE, allDay: false, ...ADMIN },
                { date: DATE, period: "night", ...ADMIN },
                { date: "2026-02-30", period: "morning", ...ADMIN },
            ];

            for (const url of [BLOCKS, UNBLOCKS]) {
                for (const body of bad) {
                    const res = await post(url, body);

                    assert.equal(res.status, 400, `${url} ${JSON.stringify(body)}`);
                    assert.equal(res.body.code, "VALIDATION_FAILED");
                }
            }
            assert.equal(await CallbackBucket.countDocuments(), 0);
        });

        it("requestIds: 1 to 50 well-formed IDs", async () => {
            // IDs use an alphabet without 0, 1, I, L, O and U
            const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
            const id = (n) => `OE-CB-261015-${ALPHABET[Math.floor(n / ALPHABET.length)]}${ALPHABET[n % ALPHABET.length]}22`;
            const bad = [
                [[], "requestIds"],
                [Array.from({ length: 51 }, (_, i) => id(i)), "requestIds"],
                [["abc"], "requestIds"],
                [["OE-VM-261015-K7Q2"], "requestIds"],
                ["OE-CB-261015-M3XZ", "requestIds"],
            ];

            for (const [requestIds, field] of bad) {
                const res = await post(CANCEL, { requestIds, ...ADMIN });

                assert.equal(res.status, 400, JSON.stringify(requestIds).slice(0, 60));
                assert.ok(res.body.errors[field]);
            }

            const fifty = await post(CANCEL, { requestIds: Array.from({ length: 50 }, (_, i) => id(i)), ...ADMIN });
            assert.equal(fifty.status, 200, "50 IDs are accepted");
            assert.equal(fifty.body.data.skipped.length, 50);
        });

        it("status must be pending, completed or no_answer; the path ID must look like OE-CB-YYMMDD-XXXX", async () => {
            for (const status of ["cancelled", "done", "", undefined]) {
                const res = await patch(statusUrl("OE-CB-261015-M3XZ"), { status, performedBy: "Anita" });

                assert.equal(res.status, 400, String(status));
                assert.ok(res.body.errors.status, String(status));
            }
            for (const id of ["abc", "OE-CB-261015-M3X", "OE-VM-261015-M3XZ", "oe-cb-261015-m3xz"]) {
                const res = await patch(statusUrl(id), { status: "completed", performedBy: "Anita" });

                assert.equal(res.status, 400, id);
                assert.ok(res.body.errors.requestId, id);
            }
        });

        it("capacity: whole numbers 0 to 50 for all three periods", async () => {
            const base = { morning: 5, afternoon: 5, evening: 3, ...ADMIN };
            const bad = [
                [{ morning: -1 }, "morning"],
                [{ afternoon: 51 }, "afternoon"],
                [{ evening: 1.5 }, "evening"],
                [{ morning: "5" }, "morning"],
                [{ evening: null }, "evening"],
                [{ afternoon: undefined }, "afternoon"],
            ];

            for (const [patchBody, field] of bad) {
                const res = await put(CAPACITY, { ...base, ...patchBody });

                assert.equal(res.status, 400, JSON.stringify(patchBody));
                assert.equal(res.body.code, "VALIDATION_FAILED");
                assert.ok(res.body.errors[field], field);
            }
            assert.equal(await Settings.countDocuments(), 0);

            const edges = await put(CAPACITY, { ...base, morning: 0, afternoon: 50 });
            assert.equal(edges.status, 200);
        });

        it("holidays: valid date, name 2-100, 1-60 in bulk, :date in the path", async () => {
            const badAdd = [
                { date: "2026-02-30", name: "Test", ...ADMIN },
                { date: HOLIDAY, name: "A", ...ADMIN },
                { date: HOLIDAY, name: "x".repeat(101), ...ADMIN },
                { name: "Test", ...ADMIN },
            ];
            for (const body of badAdd) {
                assert.equal((await post(HOLIDAYS, body)).status, 400, JSON.stringify(body).slice(0, 60));
            }

            const holiday = (n) => ({ date: addDay(n), name: `Holiday ${n}` });
            const addDay = (n) => new Date(Date.UTC(2027, 0, 1 + n)).toISOString().slice(0, 10);
            assert.equal((await post(BULK, { holidays: [], ...ADMIN })).status, 400);
            assert.equal((await post(BULK, { holidays: Array.from({ length: 61 }, (_, i) => holiday(i)), ...ADMIN })).status, 400);
            assert.equal((await post(BULK, { holidays: [{ date: HOLIDAY }], ...ADMIN })).status, 400);
            assert.equal((await post(BULK, { holidays: "x", ...ADMIN })).status, 400);

            assert.equal((await patch(holidayUrl("not-a-date"), { name: "Name", ...ADMIN })).status, 400);
            assert.equal((await del(holidayUrl("2026-02-30"), ADMIN)).status, 400);
            assert.equal(await Holiday.countDocuments(), 0);
        });
    });

    // ── C1: block and unblock ─────────────────────────────────────────────────

    describe("callback blocks", () => {
        it("blocks a period: creates the bucket with the block details", async () => {
            const res = await post(BLOCKS, { date: DATE, period: "morning", performedBy: "Anita", reason: "Team offsite" });

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.deepEqual(res.body.data, { blocked: ["morning"] });

            const bucket = await bucketOf(DATE, "morning");
            assert.equal(bucket.blocked, true);
            assert.equal(bucket.booked, 0);
            assert.equal(bucket.blockedBy, "Anita");
            assert.equal(bucket.blockReason, "Team offsite");
            assert.equal(bucket.blockedAt.toISOString(), "2026-10-14T05:00:00.000Z");
            assert.ok(bucket.expireAt > new Date(NOW), "has a TTL date");
        });

        it("the whole day blocks all three periods", async () => {
            const res = await post(BLOCKS, { date: DATE, allDay: true, ...ADMIN });

            assert.deepEqual(res.body.data, { blocked: ["morning", "afternoon", "evening"] });
            assert.equal(await CallbackBucket.countDocuments({ date: DATE, blocked: true }), 3);
        });

        it("existing requests remain: pending, counted, and not moved", async () => {
            await addRequest({ period: "morning" });
            await addRequest({ period: "morning" });
            const before = await CallbackRequest.find({ date: DATE }).lean();

            const res = await post(BLOCKS, { date: DATE, period: "morning", ...ADMIN });

            assert.deepEqual(res.body.data, { blocked: ["morning"] });
            const bucket = await bucketOf(DATE, "morning");
            assert.equal(bucket.blocked, true);
            assert.equal(bucket.booked, 2, "the booked count is unchanged");
            const after = await CallbackRequest.find({ date: DATE }).lean();
            assert.equal(after.length, 2);
            assert.deepEqual(after.map((r) => r.status), ["pending", "pending"]);
            assert.deepEqual(after.map((r) => r.requestId).sort(), before.map((r) => r.requestId).sort());
        });

        it("the public cannot book a blocked period (409 PERIOD_BLOCKED) and sees it as unavailable", async () => {
            await post(BLOCKS, { date: DATE, period: "afternoon", ...ADMIN });

            const res = await publicRequest({ period: "afternoon" });
            assert.equal(res.status, 409);
            assert.equal(res.body.code, "PERIOD_BLOCKED");

            const availability = await request(getApp()).get(`/api/v1/callback/availability?date=${DATE}`);
            const afternoon = availability.body.data.periods.find((p) => p.key === "afternoon");
            assert.equal(afternoon.available, false);
            assert.equal(availability.body.data.periods.find((p) => p.key === "morning").available, true);
        });

        it("blocking a period that is already blocked keeps the first block's details", async () => {
            await post(BLOCKS, { date: DATE, period: "morning", performedBy: "Anita", reason: "First reason" });

            const res = await post(BLOCKS, { date: DATE, period: "morning", performedBy: "Rohan", reason: "Second reason" });

            assert.deepEqual(res.body.data, { blocked: [] });
            const bucket = await bucketOf(DATE, "morning");
            assert.equal(bucket.blockedBy, "Anita");
            assert.equal(bucket.blockReason, "First reason");
        });

        it("a whole day on a partly blocked day lists only what it just blocked", async () => {
            await post(BLOCKS, { date: DATE, period: "evening", ...ADMIN });

            const res = await post(BLOCKS, { date: DATE, allDay: true, ...ADMIN });

            assert.deepEqual(res.body.data, { blocked: ["morning", "afternoon"] });
        });

        it("two admins blocking the same period at once: one blocks it, one reports nothing", async () => {
            const body = { date: DATE, period: "morning", ...ADMIN };

            const [a, b] = await Promise.all([post(BLOCKS, body), post(BLOCKS, body)]);

            const lengths = [a, b].map((r) => r.body.data.blocked.length).sort();
            assert.deepEqual(lengths, [0, 1]);
            assert.equal(await CallbackBucket.countDocuments({ date: DATE, period: "morning" }), 1);
        });

        it("a past date, a closed day and a holiday are 422 DATE_NOT_BOOKABLE", async () => {
            await Holiday.create({ date: HOLIDAY, name: "Test holiday" });

            const cases = [[YESTERDAY, "past"], [SUNDAY, "non_working_day"], [SECOND_SATURDAY, "non_working_day"], [HOLIDAY, "holiday"]];
            for (const [date, reason] of cases) {
                const res = await post(BLOCKS, { date, period: "morning", ...ADMIN });

                assert.equal(res.status, 422, date);
                assert.equal(res.body.code, "DATE_NOT_BOOKABLE", date);
                assert.deepEqual(res.body.errors, { reason }, date);
            }
            assert.equal(await CallbackBucket.countDocuments(), 0);
        });

        it("a Saturday that is not the second one can be blocked (callbacks run on Saturdays)", async () => {
            const res = await post(BLOCKS, { date: SATURDAY, period: "morning", ...ADMIN });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { blocked: ["morning"] });
        });

        it("unblock reverses a block: flag and details gone, the booked count kept, the public can book again", async () => {
            await addRequest({ period: "morning" });
            await post(BLOCKS, { date: DATE, period: "morning", ...ADMIN });

            const res = await post(UNBLOCKS, { date: DATE, period: "morning", performedBy: "Anita", reason: "Plans changed" });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { unblocked: ["morning"] });
            const bucket = await bucketOf(DATE, "morning");
            assert.equal(bucket.blocked, false);
            assert.equal(bucket.booked, 1);
            assert.equal(bucket.blockedBy, undefined);
            assert.equal(bucket.blockReason, undefined);
            assert.equal(bucket.blockedAt, undefined);

            assert.equal((await publicRequest({ period: "morning" })).status, 201);
            assert.equal((await bucketOf(DATE, "morning")).booked, 2);
        });

        it("unblock a whole day, a period that was not blocked, and a past date", async () => {
            await post(BLOCKS, { date: DATE, period: "morning", ...ADMIN });
            await post(BLOCKS, { date: DATE, period: "evening", ...ADMIN });

            const day = await post(UNBLOCKS, { date: DATE, allDay: true, ...ADMIN });
            assert.deepEqual(day.body.data, { unblocked: ["morning", "evening"] });

            const none = await post(UNBLOCKS, { date: DATE, period: "afternoon", ...ADMIN });
            assert.deepEqual(none.body.data, { unblocked: [] });

            await CallbackBucket.create({
                date: YESTERDAY, period: "morning", booked: 0, blocked: true, blockedBy: "Anita",
                blockReason: "Old", blockedAt: new Date(), expireAt: new Date("2027-01-01T00:00:00Z"),
            });
            const past = await post(UNBLOCKS, { date: YESTERDAY, period: "morning", ...ADMIN });
            assert.equal(past.status, 200);
            assert.deepEqual(past.body.data, { unblocked: ["morning"] });
        });
    });

    // ── C2: cancel requests ───────────────────────────────────────────────────

    describe("POST /admin/callback/requests/cancel", () => {
        it("cancels a pending request, frees the capacity and emails the customer", async () => {
            const { requestId } = await addRequest({ email: "john@example.com", period: "evening" });
            await eventually(() => mailsTo("john@example.com").length >= 1);
            emailOutbox.clear();
            assert.equal((await bucketOf(DATE, "evening")).booked, 1);

            const reason = "INTERNAL-ONLY-REASON-XYZ";
            const res = await post(CANCEL, { requestIds: [requestId], performedBy: "Anita", reason });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { cancelled: [requestId], skipped: [] });

            const stored = await CallbackRequest.findOne({ requestId }).lean();
            assert.equal(stored.status, "cancelled");
            assert.equal(stored.cancelledBy, "Anita");
            assert.equal(stored.cancelReason, reason);
            assert.equal(stored.cancelledAt.toISOString(), "2026-10-14T05:00:00.000Z");
            assert.equal((await bucketOf(DATE, "evening")).booked, 0);

            assert.ok(await eventually(() => mailsTo("john@example.com").length === 1), "one email to the customer");
            const [mail] = mailsTo("john@example.com");
            assert.match(mail.subject, /Cancel/i);
            assert.ok(mail.text.includes(requestId));
            assert.ok(!mail.text.includes(reason) && !mail.html.includes(reason) && !mail.subject.includes(reason));
            assert.equal(mailsTo(TEST_COMPANY_MAIL).length, 0, "no company email");
        });

        it("freed capacity lets a new public request succeed where it was full", async () => {
            const ids = [];
            for (let i = 0; i < 3; i++) {
                const res = await publicRequest({ period: "evening" });
                assert.equal(res.status, 201);
                ids.push(res.body.data.requestId);
            }
            const full = await publicRequest({ period: "evening" });
            assert.equal(full.status, 409);
            assert.equal(full.body.code, "PERIOD_FULL");

            const cancelled = await post(CANCEL, { requestIds: [ids[0]], ...ADMIN });
            assert.deepEqual(cancelled.body.data.cancelled, [ids[0]]);

            const again = await publicRequest({ period: "evening" });
            assert.equal(again.status, 201);
            assert.equal((await bucketOf(DATE, "evening")).booked, 3);
        });

        it("a batch: pending ones are cancelled, the rest are skipped with a reason", async () => {
            const pending = await addRequest({ period: "morning" });
            const done = await addRequest({ period: "morning" });
            const noAnswer = await addRequest({ period: "afternoon" });
            const alreadyCancelled = await addRequest({ period: "afternoon" });
            await patch(statusUrl(done.requestId), { status: "completed", performedBy: "Anita" });
            await patch(statusUrl(noAnswer.requestId), { status: "no_answer", performedBy: "Anita" });
            await post(CANCEL, { requestIds: [alreadyCancelled.requestId], ...ADMIN });

            const res = await post(CANCEL, {
                requestIds: [pending.requestId, done.requestId, noAnswer.requestId, alreadyCancelled.requestId, "OE-CB-261015-ZZZZ"],
                ...ADMIN,
            });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data.cancelled, [pending.requestId]);
            assert.deepEqual(res.body.data.skipped, [
                { id: done.requestId, reason: "not_pending" },
                { id: noAnswer.requestId, reason: "not_pending" },
                { id: alreadyCancelled.requestId, reason: "already_cancelled" },
                { id: "OE-CB-261015-ZZZZ", reason: "not_found" },
            ]);
            assert.equal((await CallbackRequest.findOne({ requestId: done.requestId })).status, "completed");
            assert.equal((await bucketOf(DATE, "morning")).booked, 1, "only the cancelled pending request freed a unit");
        });

        it("repeated IDs are handled once", async () => {
            const { requestId } = await addRequest({ period: "morning" });
            await addRequest({ period: "morning" });

            const res = await post(CANCEL, { requestIds: [requestId, requestId, requestId], ...ADMIN });

            assert.deepEqual(res.body.data, { cancelled: [requestId], skipped: [] });
            assert.equal((await bucketOf(DATE, "morning")).booked, 1);
        });

        it("the booked count never goes below zero", async () => {
            const { requestId } = await addRequest({ period: "morning" });
            await CallbackBucket.updateOne({ date: DATE, period: "morning" }, { $set: { booked: 0 } });

            const res = await post(CANCEL, { requestIds: [requestId], ...ADMIN });

            assert.deepEqual(res.body.data.cancelled, [requestId]);
            assert.equal((await bucketOf(DATE, "morning")).booked, 0);
        });

        it("two admins cancelling the same request at once: it is cancelled and freed once", async () => {
            const { requestId } = await addRequest({ period: "morning" });
            await addRequest({ period: "morning" });

            const results = await Promise.all([
                post(CANCEL, { requestIds: [requestId], ...ADMIN }),
                post(CANCEL, { requestIds: [requestId], ...ADMIN }),
            ]);

            const cancelled = results.flatMap((r) => r.body.data.cancelled);
            const skipped = results.flatMap((r) => r.body.data.skipped);
            assert.deepEqual(cancelled, [requestId]);
            assert.deepEqual(skipped, [{ id: requestId, reason: "already_cancelled" }]);
            assert.equal((await bucketOf(DATE, "morning")).booked, 1);
            assert.equal((await audit("callback.cancel")).length, 1);
        });

        it("cancelling in a lowered-capacity period frees a unit but the period can stay full", async () => {
            const ids = [];
            for (let i = 0; i < 3; i++) ids.push((await addRequest({ period: "evening" })).requestId);
            await put(CAPACITY, { morning: 5, afternoon: 5, evening: 1, ...ADMIN });

            await post(CANCEL, { requestIds: [ids[0]], ...ADMIN });

            assert.equal((await bucketOf(DATE, "evening")).booked, 2);
            assert.equal((await publicRequest({ period: "evening" })).status, 409, "2 booked is still over a capacity of 1");
        });

        it("a failed email does not fail the cancellation", async () => {
            const { requestId } = await addRequest({ email: "john@example.com" });
            await eventually(() => mailsTo("john@example.com").length >= 1);
            emailOutbox.clear();
            emailOutbox.failNext("customer");

            const res = await post(CANCEL, { requestIds: [requestId], ...ADMIN });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data.cancelled, [requestId]);
        });
    });

    // ── C3: request status ────────────────────────────────────────────────────

    describe("PATCH /admin/callback/requests/:requestId", () => {
        it("moves a request between pending, completed and no_answer", async () => {
            const { requestId } = await addRequest();

            for (const status of ["completed", "no_answer", "pending", "completed"]) {
                const res = await patch(statusUrl(requestId), { status, performedBy: "Priya" });

                assert.equal(res.status, 200, status);
                assert.deepEqual(res.body.data, { requestId, status });
                const stored = await CallbackRequest.findOne({ requestId }).lean();
                assert.equal(stored.status, status);
                assert.equal(stored.statusUpdatedBy, "Priya");
            }
        });

        it("does not change the capacity count or the other requests", async () => {
            const a = await addRequest({ period: "morning" });
            await addRequest({ period: "morning" });

            await patch(statusUrl(a.requestId), { status: "completed", performedBy: "Priya" });

            assert.equal((await bucketOf(DATE, "morning")).booked, 2);
            assert.equal(await CallbackRequest.countDocuments({ status: "pending" }), 1);
        });

        it("a cancelled request cannot be changed (409) and stays cancelled", async () => {
            const { requestId } = await addRequest();
            await post(CANCEL, { requestIds: [requestId], ...ADMIN });

            const res = await patch(statusUrl(requestId), { status: "completed", performedBy: "Priya" });

            assert.equal(res.status, 409);
            assert.equal(res.body.code, "CONFLICT");
            assert.equal((await CallbackRequest.findOne({ requestId })).status, "cancelled");
            assert.equal((await audit("callback.status")).length, 0);
        });

        it("an unknown request is 404 NOT_FOUND", async () => {
            const res = await patch(statusUrl("OE-CB-261015-ZZZZ"), { status: "completed", performedBy: "Priya" });

            assert.equal(res.status, 404);
            assert.equal(res.body.code, "NOT_FOUND");
        });

        it("setting the status it already has answers 200 and writes nothing", async () => {
            const { requestId } = await addRequest();
            await patch(statusUrl(requestId), { status: "completed", performedBy: "Priya" });

            const res = await patch(statusUrl(requestId), { status: "completed", performedBy: "Rohan" });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { requestId, status: "completed" });
            assert.equal((await CallbackRequest.findOne({ requestId })).statusUpdatedBy, "Priya");
            assert.equal((await audit("callback.status")).length, 1);
        });
    });

    // ── C4: capacity ──────────────────────────────────────────────────────────

    describe("PUT /admin/settings/callback-capacity", () => {
        it("saves the capacity and returns it", async () => {
            const res = await put(CAPACITY, { morning: 8, afternoon: 4, evening: 0, performedBy: "Anita", reason: "Fewer staff" });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { callbackCapacity: { morning: 8, afternoon: 4, evening: 0 } });

            const settings = await request(getApp()).get(`${BASE}/settings`).set("Cookie", cookie);
            assert.deepEqual(settings.body.data, { callbackCapacity: { morning: 8, afternoon: 4, evening: 0 } });
        });

        it("applies immediately: the very next public request sees the new capacity", async () => {
            await put(CAPACITY, { morning: 5, afternoon: 5, evening: 1, ...ADMIN });
            assert.equal((await publicRequest({ period: "evening" })).status, 201);
            const full = await publicRequest({ period: "evening" });
            assert.equal(full.status, 409);
            assert.equal(full.body.code, "PERIOD_FULL");

            await put(CAPACITY, { morning: 5, afternoon: 5, evening: 2, ...ADMIN });
            assert.equal((await publicRequest({ period: "evening" })).status, 201);
            assert.equal((await publicRequest({ period: "evening" })).status, 409);
        });

        it("capacity 0 closes a period to new requests", async () => {
            await put(CAPACITY, { morning: 0, afternoon: 5, evening: 3, ...ADMIN });

            const res = await publicRequest({ period: "morning" });

            assert.equal(res.status, 409);
            assert.equal(res.body.code, "PERIOD_FULL");
            const availability = await request(getApp()).get(`/api/v1/callback/availability?date=${DATE}`);
            assert.equal(availability.body.data.periods.find((p) => p.key === "morning").available, false);
        });

        it("lowering capacity below what is booked never cancels or changes anyone", async () => {
            const ids = [];
            for (let i = 0; i < 3; i++) ids.push((await addRequest({ period: "evening" })).requestId);

            const res = await put(CAPACITY, { morning: 5, afternoon: 5, evening: 1, ...ADMIN });

            assert.equal(res.status, 200);
            const requests = await CallbackRequest.find({ requestId: { $in: ids } }).lean();
            assert.deepEqual(requests.map((r) => r.status), ["pending", "pending", "pending"]);
            assert.equal((await bucketOf(DATE, "evening")).booked, 3);
            assert.equal((await publicRequest({ period: "evening" })).status, 409);
            assert.equal(emailOutbox.all().filter((m) => /cancel/i.test(m.subject)).length, 0);
        });
    });

    // ── C5: holidays ──────────────────────────────────────────────────────────

    describe("holidays", () => {
        const seedBusyHoliday = async () => {
            await vmBookingService.createVmBooking({
                name: "Rahul Kumar", email: "rahul@example.com", mobileNumber: "+919876543210",
                date: HOLIDAY, time: "10:00",
            });
            await vmBookingService.createVmBooking({
                name: "Priya Sharma", email: "priya@example.com", mobileNumber: "+919876543211",
                date: HOLIDAY, time: "14:00",
            });
            // a third meeting that staff then cancel: it must not be counted as affected
            const cancelledMeeting = await vmBookingService.createVmBooking({
                name: "Cancelled Person", email: "cancelled@example.com", mobileNumber: "+919876543212",
                date: HOLIDAY, time: "12:00",
            });
            const cancel = await post(`${BASE}/vm/bookings/${cancelledMeeting.bookingId}/cancel`, { ...ADMIN, alsoBlock: false });
            assert.equal(cancel.status, 200);

            await addRequest({ date: HOLIDAY, period: "morning" });
            const cancelledOne = await addRequest({ date: HOLIDAY, period: "afternoon" });
            await post(CANCEL, { requestIds: [cancelledOne.requestId], ...ADMIN });
        };

        describe("POST /admin/holidays", () => {
            it("adds a holiday and closes the date for VM and callbacks in the public calendars", async () => {
                assert.equal((await publicCalendarDay("callback", HOLIDAY)).bookable, true);
                assert.equal((await publicCalendarDay("vm", HOLIDAY)).bookable, true);

                const res = await post(HOLIDAYS, { date: HOLIDAY, name: "Diwali", performedBy: "Anita", reason: "Festival" });

                assert.equal(res.status, 200);
                assert.equal(res.body.success, true);
                assert.deepEqual(res.body.data, {
                    holiday: { date: HOLIDAY, name: "Diwali" },
                    affected: { vmBookings: 0, callbackRequests: 0 },
                });
                assert.equal((await Holiday.findOne({ date: HOLIDAY })).name, "Diwali");

                const callback = await publicCalendarDay("callback", HOLIDAY);
                const vm = await publicCalendarDay("vm", HOLIDAY);
                assert.deepEqual([callback.bookable, callback.reason], [false, "holiday"]);
                assert.deepEqual([vm.bookable, vm.reason], [false, "holiday"]);
            });

            it("succeeds when bookings exist, reports how many, and cancels nothing", async () => {
                await seedBusyHoliday();

                const res = await post(HOLIDAYS, { date: HOLIDAY, name: "Diwali", ...ADMIN });

                assert.equal(res.status, 200);
                assert.deepEqual(res.body.data.affected, { vmBookings: 2, callbackRequests: 1 });
                assert.equal(await VmBooking.countDocuments({ date: HOLIDAY, status: "confirmed" }), 2);
                assert.equal(await CallbackRequest.countDocuments({ date: HOLIDAY, status: "pending" }), 1);
                assert.equal((await bucketOf(HOLIDAY, "morning")).booked, 1);
            });

            it("a Sunday or a second Saturday is 422 ALREADY_CLOSED and nothing is stored", async () => {
                for (const date of [SUNDAY, SECOND_SATURDAY]) {
                    const res = await post(HOLIDAYS, { date, name: "Closed anyway", ...ADMIN });

                    assert.equal(res.status, 422, date);
                    assert.equal(res.body.code, "ALREADY_CLOSED", date);
                }
                assert.equal(await Holiday.countDocuments(), 0);
                assert.equal(await AuditLog.countDocuments(), 0);
            });

            it("a Saturday that is not the second one is allowed", async () => {
                const res = await post(HOLIDAYS, { date: SATURDAY, name: "Company day", ...ADMIN });

                assert.equal(res.status, 200);
            });

            it("a date that is already a holiday is 409 CONFLICT", async () => {
                await post(HOLIDAYS, { date: HOLIDAY, name: "Diwali", ...ADMIN });

                const res = await post(HOLIDAYS, { date: HOLIDAY, name: "Again", ...ADMIN });

                assert.equal(res.status, 409);
                assert.equal(res.body.code, "CONFLICT");
                assert.equal((await Holiday.findOne({ date: HOLIDAY })).name, "Diwali");
                assert.equal((await audit("holiday.add")).length, 1);
            });
        });

        describe("POST /admin/holidays/bulk", () => {
            it("adds many at once and reports added, skipped and affected", async () => {
                await seedBusyHoliday();
                await Holiday.create({ date: "2026-12-25", name: "Christmas" });

                const res = await post(BULK, {
                    holidays: [
                        { date: HOLIDAY, name: "Diwali" },
                        { date: "2026-11-02", name: "Govardhan Puja" },
                        { date: SUNDAY, name: "A Sunday" },
                        { date: SECOND_SATURDAY, name: "Second Saturday" },
                        { date: "2026-12-25", name: "Christmas again" },
                        { date: "2026-11-02", name: "Repeated in the list" },
                    ],
                    performedBy: "Anita",
                    reason: "Start of year setup",
                });

                assert.equal(res.status, 200);
                assert.deepEqual(res.body.data.added, [HOLIDAY, "2026-11-02"]);
                assert.deepEqual(res.body.data.skipped, [
                    { date: SUNDAY, reason: "closed_by_rule" },
                    { date: SECOND_SATURDAY, reason: "closed_by_rule" },
                    { date: "2026-12-25", reason: "exists" },
                    { date: "2026-11-02", reason: "exists" },
                ]);
                assert.deepEqual(res.body.data.affected, { vmBookings: 2, callbackRequests: 1 });
                assert.equal((await Holiday.findOne({ date: "2026-11-02" })).name, "Govardhan Puja", "the first one in the list wins");
                assert.equal((await Holiday.findOne({ date: "2026-12-25" })).name, "Christmas", "an existing name is not overwritten");
                assert.equal(await Holiday.countDocuments(), 3);
            });

            it("accepts 60 holidays in one request", async () => {
                const holidays = [];
                for (let i = 0; i < 60; i++) {
                    const date = new Date(Date.UTC(2027, 0, 4 + i * 7)).toISOString().slice(0, 10);   // 60 Mondays
                    holidays.push({ date, name: `Holiday ${i + 1}` });
                }

                const res = await post(BULK, { holidays, ...ADMIN });

                assert.equal(res.status, 200);
                assert.equal(res.body.data.added.length, 60);
                assert.deepEqual(res.body.data.skipped, []);
                assert.equal(await Holiday.countDocuments(), 60);
            });

            it("closes the added dates in the public calendar and cancels nothing", async () => {
                await seedBusyHoliday();

                await post(BULK, { holidays: [{ date: HOLIDAY, name: "Diwali" }], ...ADMIN });

                assert.equal((await publicCalendarDay("callback", HOLIDAY)).reason, "holiday");
                assert.equal(await CallbackRequest.countDocuments({ date: HOLIDAY, status: "pending" }), 1);
                assert.equal(await VmBooking.countDocuments({ date: HOLIDAY, status: "confirmed" }), 2);
            });
        });

        describe("PATCH /admin/holidays/:date", () => {
            it("renames a holiday", async () => {
                await post(HOLIDAYS, { date: HOLIDAY, name: "Diwali", ...ADMIN });

                const res = await patch(holidayUrl(HOLIDAY), { name: "Deepavali", performedBy: "Anita", reason: "Better name" });

                assert.equal(res.status, 200);
                assert.deepEqual(res.body.data, { holiday: { date: HOLIDAY, name: "Deepavali" } });
                assert.equal((await Holiday.findOne({ date: HOLIDAY })).name, "Deepavali");
                assert.equal((await publicCalendarDay("vm", HOLIDAY)).reason, "holiday", "still a holiday");
            });

            it("an unknown date is 404 NOT_FOUND", async () => {
                const res = await patch(holidayUrl("2027-05-05"), { name: "Nothing", ...ADMIN });

                assert.equal(res.status, 404);
                assert.equal(res.body.code, "NOT_FOUND");
            });
        });

        describe("DELETE /admin/holidays/:date", () => {
            it("removes the holiday (reason in the body) and reopens the date", async () => {
                await post(HOLIDAYS, { date: HOLIDAY, name: "Diwali", ...ADMIN });
                assert.equal((await publicCalendarDay("callback", HOLIDAY)).bookable, false);

                const res = await del(holidayUrl(HOLIDAY), { performedBy: "Anita", reason: "Added by mistake" });

                assert.equal(res.status, 200);
                assert.deepEqual(res.body.data, { date: HOLIDAY });
                assert.equal(await Holiday.countDocuments({ date: HOLIDAY }), 0);

                const callback = await publicCalendarDay("callback", HOLIDAY);
                const vm = await publicCalendarDay("vm", HOLIDAY);
                assert.deepEqual([callback.bookable, callback.reason], [true, null]);
                assert.deepEqual([vm.bookable, vm.reason], [true, null]);
                assert.equal((await publicRequest({ date: HOLIDAY })).status, 201, "the date takes requests again");
            });

            it("an unknown date is 404 NOT_FOUND", async () => {
                const res = await del(holidayUrl("2027-05-05"), ADMIN);

                assert.equal(res.status, 404);
                assert.equal(res.body.code, "NOT_FOUND");
            });
        });
    });

    // ── C6: audit log ─────────────────────────────────────────────────────────

    describe("audit log", () => {
        it("blocks and unblocks write one entry per request", async () => {
            await post(BLOCKS, { date: DATE, period: "morning", performedBy: "Anita", reason: "Team offsite" });
            await post(BLOCKS, { date: OTHER_DATE, allDay: true, ...ADMIN });
            await post(UNBLOCKS, { date: DATE, period: "morning", performedBy: "Rohan", reason: "Plans changed" });

            const blocks = await audit("callback.block");
            assert.equal(blocks.length, 2);
            assert.equal(blocks[0].targetType, "callback_bucket");
            assert.equal(blocks[0].targetId, `${DATE} morning`);
            assert.equal(blocks[0].date, DATE);
            assert.deepEqual(blocks[0].detail, { allDay: false, blocked: ["morning"], alreadyBlocked: [] });
            assert.equal(blocks[0].performedBy, "Anita");
            assert.equal(blocks[0].reason, "Team offsite");
            assert.equal(blocks[1].targetId, OTHER_DATE);
            assert.deepEqual(blocks[1].detail.blocked, ["morning", "afternoon", "evening"]);

            const unblocks = await audit("callback.unblock");
            assert.equal(unblocks.length, 1);
            assert.deepEqual(unblocks[0].detail, { allDay: false, unblocked: ["morning"] });
            assert.equal(unblocks[0].performedBy, "Rohan");
        });

        it("each cancelled request has its own entry; skipped ones have none", async () => {
            const a = await addRequest({ period: "morning" });
            const b = await addRequest({ period: "evening" });
            const done = await addRequest({ period: "morning" });
            await patch(statusUrl(done.requestId), { status: "completed", performedBy: "Anita" });

            await post(CANCEL, {
                requestIds: [a.requestId, b.requestId, done.requestId, "OE-CB-261015-ZZZZ"],
                performedBy: "Priya",
                reason: "Customer asked",
            });

            const entries = await audit("callback.cancel");
            assert.deepEqual(entries.map((e) => e.targetId), [a.requestId, b.requestId]);
            assert.ok(entries.every((e) => e.targetType === "callback_request" && e.date === DATE));
            assert.deepEqual(entries.map((e) => e.detail.period), ["morning", "evening"]);
            assert.ok(entries.every((e) => e.performedBy === "Priya" && e.reason === "Customer asked"));
        });

        it("a status change records from and to, and who", async () => {
            const { requestId } = await addRequest({ period: "afternoon" });

            await patch(statusUrl(requestId), { status: "no_answer", performedBy: "Priya" });

            const [entry] = await audit("callback.status");
            assert.equal(entry.targetType, "callback_request");
            assert.equal(entry.targetId, requestId);
            assert.equal(entry.date, DATE);
            assert.deepEqual(entry.detail, { period: "afternoon", from: "pending", to: "no_answer" });
            assert.equal(entry.performedBy, "Priya");
            assert.equal(entry.reason, undefined);
        });

        it("a capacity change records the old and new values", async () => {
            await put(CAPACITY, { morning: 8, afternoon: 5, evening: 1, performedBy: "Anita", reason: "Fewer staff" });

            const [entry] = await audit("settings.capacity");
            assert.equal(entry.targetType, "settings");
            assert.equal(entry.targetId, "main");
            assert.deepEqual(entry.detail, {
                from: { morning: 5, afternoon: 5, evening: 3 },
                to: { morning: 8, afternoon: 5, evening: 1 },
            });
            assert.equal(entry.reason, "Fewer staff");
        });

        it("holiday add, rename and delete are recorded; a bulk add has one entry per holiday added", async () => {
            await post(HOLIDAYS, { date: HOLIDAY, name: "Diwali", performedBy: "Anita", reason: "Festival" });
            await patch(holidayUrl(HOLIDAY), { name: "Deepavali", performedBy: "Rohan", reason: "Better name" });
            await del(holidayUrl(HOLIDAY), { performedBy: "Priya", reason: "Added by mistake" });
            await post(BULK, {
                holidays: [{ date: "2026-11-02", name: "A" + "b" }, { date: "2026-11-03", name: "Cd" }, { date: SUNDAY, name: "Closed" }],
                ...ADMIN,
            });

            const added = await audit("holiday.add");
            assert.equal(added.length, 3, "1 single + 2 added in bulk (the Sunday is skipped)");
            assert.deepEqual(added[0].detail, { name: "Diwali", affected: { vmBookings: 0, callbackRequests: 0 } });
            assert.deepEqual(added.slice(1).map((e) => [e.targetId, e.detail.bulk]), [["2026-11-02", true], ["2026-11-03", true]]);

            const [renamed] = await audit("holiday.rename");
            assert.deepEqual(renamed.detail, { from: "Diwali", to: "Deepavali" });
            assert.equal(renamed.performedBy, "Rohan");

            const [removed] = await audit("holiday.delete");
            assert.deepEqual(removed.detail, { name: "Deepavali" });
            assert.equal(removed.reason, "Added by mistake");
            assert.ok(added.every((e) => e.targetType === "holiday"));
        });

        it("rejected requests write nothing", async () => {
            await post(BLOCKS, { date: YESTERDAY, period: "morning", ...ADMIN });               // 422
            await post(HOLIDAYS, { date: SUNDAY, name: "Closed", ...ADMIN });                   // 422
            await put(CAPACITY, { morning: 99, afternoon: 5, evening: 3, ...ADMIN });           // 400
            await patch(statusUrl("OE-CB-261015-ZZZZ"), { status: "completed", performedBy: "Anita" });   // 404
            await del(holidayUrl("2027-05-05"), ADMIN);                                         // 404
            await post(BLOCKS, { date: DATE, period: "morning", ...ADMIN }, { session: null }); // 401

            assert.equal(await AuditLog.countDocuments(), 0);
        });

        it("entries never hold a customer's email or phone number", async () => {
            const { requestId } = await addRequest({ email: "private.person@example.com", mobileNumber: "+919123456789" });
            await patch(statusUrl(requestId), { status: "completed", performedBy: "Anita" });
            const other = await addRequest({ email: "second.person@example.com", mobileNumber: "+919123456788" });
            await post(CANCEL, { requestIds: [other.requestId], ...ADMIN });

            const text = JSON.stringify(await audit());
            assert.ok(!text.includes("private.person@example.com"));
            assert.ok(!text.includes("second.person@example.com"));
            assert.ok(!text.includes("919123456789") && !text.includes("919123456788"));
        });

        it("a failed audit write does not undo or fail the action", async () => {
            mock.method(AuditLog, "create", async () => { throw new Error("audit store down"); });

            const res = await post(HOLIDAYS, { date: HOLIDAY, name: "Diwali", ...ADMIN });

            assert.equal(res.status, 200);
            assert.equal(await Holiday.countDocuments({ date: HOLIDAY }), 1);
        });
    });
});
