import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
    startTestEnv, stopTestEnv, resetState, getApp, emailOutbox,
    TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, TEST_ORIGIN,
} from "./helpers/setup.js";

const BASE = "/api/v1/admin";
const BLOCKS = `${BASE}/vm/blocks`;
const UNBLOCKS = `${BASE}/vm/blocks/remove`;
const cancelUrl = (bookingId) => `${BASE}/vm/bookings/${bookingId}/cancel`;
const retryUrl = (bookingId) => `${BASE}/vm/bookings/${bookingId}/retry-meet`;

// Wed 14 Oct 2026, 10:30 IST. Everything below happens on Thu 15 Oct 2026 unless stated.
const NOW = "2026-10-14T05:00:00Z";
const DATE = "2026-10-15";
const TODAY = "2026-10-14";
const YESTERDAY = "2026-10-13";
const SATURDAY = "2026-10-17";
const SUNDAY = "2026-10-18";
const SECOND_SATURDAY = "2026-11-14";
const HOLIDAY = "2026-10-16";
const LINK = "https://meet.google.com/abc-defg-hij";

const ADMIN = { performedBy: "Anita", reason: "Site visit" };

let VmBooking;
let VmSlot;
let Holiday;
let AuditLog;
let google;
let vmBookingService;
let cookie;

const freezeTime = (iso = NOW) => mock.timers.enable({ apis: ["Date"], now: new Date(iso) });

const fakeCalendar = ({ insert, remove } = {}) => {
    const calls = { insert: [], delete: [] };
    return {
        calls,
        events: {
            insert: async (params, options) => {
                calls.insert.push({ params, options });
                return insert ? insert(params, options) : { data: { id: "evt-123", hangoutLink: LINK } };
            },
            delete: async (params, options) => {
                calls.delete.push({ params, options });
                return remove ? remove(params, options) : {};
            },
        },
    };
};

const signIn = async () => {
    const res = await request(getApp())
        .post(`${BASE}/auth/login`)
        .set("Origin", TEST_ORIGIN)
        .send({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD });
    assert.equal(res.status, 200);
    cookie = res.headers["set-cookie"][0].split(";")[0];
};

const post = (url, body, { origin = TEST_ORIGIN, session = cookie } = {}) => {
    const req = request(getApp()).post(url).set("Content-Type", "application/json");
    if (origin) req.set("Origin", origin);
    if (session) req.set("Cookie", session);
    return req.send(body);
};

// A booking made the way the public does it (so the slot, Meet event and ID are real).
let emailCounter = 0;
const book = async (date = DATE, time = "10:00", overrides = {}) => {
    const email = overrides.email ?? `customer${++emailCounter}@example.com`;
    return vmBookingService.createVmBooking({
        name: "Rahul Kumar", mobileNumber: "+919876543210", organisation: "ABC Pvt Ltd",
        designation: "Plant Head", topic: "EIA for new unit", ...overrides, email, date, time,
    });
};

// Fire-and-forget work (emails, Google delete) lands just after the response.
const eventually = async (predicate, { tries = 100, delay = 10 } = {}) => {
    for (let i = 0; i < tries; i++) {
        if (await predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return false;
};
const mailsTo = (email) => emailOutbox.all().filter((mail) => mail.to === email);

const slotAt = (date, time) => VmSlot.findOne({ date, time }).lean();
const audit = (action) => AuditLog.find(action ? { action } : {}).sort({ createdAt: 1 }).lean();

describe("Admin VM actions", () => {
    before(async () => {
        await startTestEnv();
        ({ VmBooking } = await import("../src/models/vmBooking.model.js"));
        ({ VmSlot } = await import("../src/models/vmSlot.model.js"));
        ({ Holiday } = await import("../src/models/holiday.model.js"));
        ({ AuditLog } = await import("../src/models/auditLog.model.js"));
        google = await import("../src/services/googleCalendar.service.js");
        vmBookingService = await import("../src/services/vmBooking.service.js");
    });
    after(stopTestEnv);
    beforeEach(async () => {
        await resetState();
        freezeTime();           // before sign-in, so the session cookie is valid at the frozen time
        await signIn();
        google.setCalendarClient(fakeCalendar());
    });
    afterEach(() => {
        mock.restoreAll();
        mock.timers.reset();
        google.setCalendarClient(null);
    });

    // ── authentication and request validation ─────────────────────────────────

    describe("access and validation", () => {
        const ENDPOINTS = [
            [BLOCKS, { date: DATE, time: "10:00", ...ADMIN }],
            [UNBLOCKS, { date: DATE, time: "10:00", ...ADMIN }],
            [cancelUrl("OE-VM-261015-K7Q2"), { ...ADMIN, alsoBlock: false }],
            [retryUrl("OE-VM-261015-K7Q2"), { performedBy: "Anita" }],
        ];

        it("every action is 401 without a session", async () => {
            for (const [url, body] of ENDPOINTS) {
                const res = await post(url, body, { session: null });

                assert.equal(res.status, 401, url);
                assert.equal(res.body.code, "ADMIN_UNAUTHORIZED", url);
            }
            assert.equal(await VmSlot.countDocuments(), 0);
            assert.equal(await AuditLog.countDocuments(), 0);
        });

        it("a request from a foreign Origin is 403 CSRF_REJECTED and does nothing", async () => {
            const res = await post(BLOCKS, { date: DATE, time: "10:00", ...ADMIN }, { origin: "http://evil.example" });

            assert.equal(res.status, 403);
            assert.equal(res.body.code, "CSRF_REJECTED");
            assert.equal(await VmSlot.countDocuments(), 0);
        });

        it("performedBy is 2 to 60 characters and reason is 3 to 300", async () => {
            const cases = [
                [{ performedBy: "A" }, "performedBy"],
                [{ performedBy: "x".repeat(61) }, "performedBy"],
                [{ performedBy: "   " }, "performedBy"],
                [{ reason: "ab" }, "reason"],
                [{ reason: "x".repeat(301) }, "reason"],
                [{ performedBy: undefined }, "performedBy"],
                [{ reason: undefined }, "reason"],
            ];

            for (const [patch, field] of cases) {
                for (const url of [BLOCKS, UNBLOCKS]) {
                    const res = await post(url, { date: DATE, time: "10:00", ...ADMIN, ...patch });

                    assert.equal(res.status, 400, `${url} ${JSON.stringify(patch)}`);
                    assert.equal(res.body.code, "VALIDATION_FAILED");
                    assert.ok(res.body.errors[field], `${url} ${field}`);
                }
                const cancel = await post(cancelUrl("OE-VM-261015-K7Q2"), { ...ADMIN, ...patch });
                assert.equal(cancel.status, 400, `cancel ${JSON.stringify(patch)}`);
                assert.ok(cancel.body.errors[field]);
            }

            const retry = await post(retryUrl("OE-VM-261015-K7Q2"), { performedBy: "A" });
            assert.equal(retry.status, 400);
            assert.ok(retry.body.errors.performedBy);

            assert.equal(await AuditLog.countDocuments(), 0);
        });

        it("accepts the boundary lengths", async () => {
            const res = await post(BLOCKS, {
                date: DATE, time: "10:00", performedBy: "Al", reason: "x".repeat(300),
            });

            assert.equal(res.status, 200);
        });

        it("exactly one of time and allDay: true is required", async () => {
            const bad = [
                { date: DATE, ...ADMIN },
                { date: DATE, time: "10:00", allDay: true, ...ADMIN },
                { date: DATE, allDay: false, ...ADMIN },
                { date: DATE, time: "11:00", ...ADMIN },
                { date: DATE, time: "10:00:00", ...ADMIN },
                { date: "2026-02-30", time: "10:00", ...ADMIN },
                { time: "10:00", ...ADMIN },
            ];

            for (const body of bad) {
                const res = await post(BLOCKS, body);

                assert.equal(res.status, 400, JSON.stringify(body));
                assert.equal(res.body.code, "VALIDATION_FAILED", JSON.stringify(body));
            }
            assert.equal(await VmSlot.countDocuments(), 0);
        });

        it(":bookingId must look like OE-VM-YYMMDD-XXXX (400 otherwise, before any lookup)", async () => {
            for (const id of ["abc", "OE-VM-261015-K7Q", "OE-VM-261015-K7Q20", "OE-CB-261015-K7Q2", "OE-VM-261015-K7O2", "oe-vm-261015-k7q2"]) {
                for (const url of [cancelUrl(id), retryUrl(id)]) {
                    const res = await post(url, { ...ADMIN, alsoBlock: false });

                    assert.equal(res.status, 400, url);
                    assert.equal(res.body.code, "VALIDATION_FAILED", url);
                    assert.ok(res.body.errors.bookingId, url);
                }
            }
        });

        it("alsoBlock must be a boolean when sent, and defaults to false", async () => {
            const { bookingId } = await book();

            const bad = await post(cancelUrl(bookingId), { ...ADMIN, alsoBlock: "yes" });
            assert.equal(bad.status, 400);
            assert.ok(bad.body.errors.alsoBlock);

            const ok = await post(cancelUrl(bookingId), ADMIN);   // alsoBlock left out
            assert.equal(ok.status, 200);
            assert.equal(ok.body.data.slot, "released");
        });
    });

    // ── C2: block ─────────────────────────────────────────────────────────────

    describe("POST /admin/vm/blocks", () => {
        it("blocks a free slot", async () => {
            const res = await post(BLOCKS, { date: DATE, time: "10:00", ...ADMIN });

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.deepEqual(res.body.data, { blocked: ["10:00"], skipped: [] });

            const slot = await slotAt(DATE, "10:00");
            assert.equal(slot.state, "blocked");
            assert.equal(slot.blockedBy, "Anita");
            assert.equal(slot.blockReason, "Site visit");
            assert.equal(slot.blockedAt.toISOString(), NOW.replace("Z", ".000Z"));
            assert.equal(slot.bookingId, undefined);
            assert.ok(slot.expireAt > new Date(NOW), "has a TTL date");
        });

        it("a blocked slot cannot be booked by the public", async () => {
            await post(BLOCKS, { date: DATE, time: "10:00", ...ADMIN });

            await assert.rejects(() => book(DATE, "10:00"), (error) => error.code === "SLOT_TAKEN");
        });

        it("a booked slot is skipped with reason booked, and the booking is untouched", async () => {
            const { bookingId } = await book(DATE, "10:00");

            const res = await post(BLOCKS, { date: DATE, time: "10:00", ...ADMIN });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { blocked: [], skipped: [{ time: "10:00", reason: "booked" }] });
            const slot = await slotAt(DATE, "10:00");
            assert.equal(slot.state, "booked");
            assert.equal(slot.bookingId, bookingId);
            assert.equal((await VmBooking.findOne({ bookingId })).status, "confirmed");
        });

        it("an already blocked slot is skipped with reason already_blocked and keeps its first block", async () => {
            await post(BLOCKS, { date: DATE, time: "12:00", performedBy: "Anita", reason: "Site visit" });

            const res = await post(BLOCKS, { date: DATE, time: "12:00", performedBy: "Rohan", reason: "Training" });

            assert.deepEqual(res.body.data, { blocked: [], skipped: [{ time: "12:00", reason: "already_blocked" }] });
            const slot = await slotAt(DATE, "12:00");
            assert.equal(slot.blockedBy, "Anita");
            assert.equal(slot.blockReason, "Site visit");
        });

        it("a whole day with one booking: 3 blocked, 1 skipped", async () => {
            await book(DATE, "12:00");

            const res = await post(BLOCKS, { date: DATE, allDay: true, ...ADMIN });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, {
                blocked: ["10:00", "14:00", "16:00"],
                skipped: [{ time: "12:00", reason: "booked" }],
            });
            const slots = await VmSlot.find({ date: DATE }).sort({ time: 1 }).lean();
            assert.deepEqual(slots.map((s) => [s.time, s.state]), [
                ["10:00", "blocked"], ["12:00", "booked"], ["14:00", "blocked"], ["16:00", "blocked"],
            ]);
        });

        it("a whole free day blocks all four slots", async () => {
            const res = await post(BLOCKS, { date: DATE, allDay: true, ...ADMIN });

            assert.deepEqual(res.body.data, { blocked: ["10:00", "12:00", "14:00", "16:00"], skipped: [] });
        });

        it("a day that is partly blocked already reports each slot correctly", async () => {
            await post(BLOCKS, { date: DATE, time: "10:00", ...ADMIN });

            const res = await post(BLOCKS, { date: DATE, allDay: true, ...ADMIN });

            assert.deepEqual(res.body.data, {
                blocked: ["12:00", "14:00", "16:00"],
                skipped: [{ time: "10:00", reason: "already_blocked" }],
            });
        });

        it("a past date is 422 DATE_NOT_BOOKABLE (reason past) and creates nothing", async () => {
            const res = await post(BLOCKS, { date: YESTERDAY, allDay: true, ...ADMIN });

            assert.equal(res.status, 422);
            assert.equal(res.body.code, "DATE_NOT_BOOKABLE");
            assert.deepEqual(res.body.errors, { reason: "past" });
            assert.equal(await VmSlot.countDocuments(), 0);
        });

        it("a non-working day (Sunday, 2nd Saturday) is 422 with reason non_working_day", async () => {
            for (const date of [SECOND_SATURDAY, SUNDAY]) {
                const res = await post(BLOCKS, { date, time: "10:00", ...ADMIN });

                assert.equal(res.status, 422, date);
                assert.deepEqual(res.body.errors, { reason: "non_working_day" }, date);
            }
            assert.equal(await VmSlot.countDocuments(), 0);
        });

        it("any other Saturday can be blocked (VM runs on it)", async () => {
            const res = await post(BLOCKS, { date: SATURDAY, time: "10:00", ...ADMIN });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data.blocked, ["10:00"]);
        });

        it("a holiday is 422 with reason holiday", async () => {
            await Holiday.create({ date: HOLIDAY, name: "Test holiday" });

            const res = await post(BLOCKS, { date: HOLIDAY, time: "10:00", ...ADMIN });

            assert.equal(res.status, 422);
            assert.deepEqual(res.body.errors, { reason: "holiday" });
        });

        it("today is allowed (only dates before today are past)", async () => {
            const res = await post(BLOCKS, { date: TODAY, time: "16:00", ...ADMIN });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data.blocked, ["16:00"]);
        });

        it("two admins blocking the same slot at once: one blocks, one is skipped", async () => {
            const body = { date: DATE, time: "14:00", ...ADMIN };

            const [a, b] = await Promise.all([post(BLOCKS, body), post(BLOCKS, body)]);

            const outcomes = [a, b].map((res) => res.body.data);
            assert.equal(outcomes.filter((o) => o.blocked.length === 1).length, 1);
            assert.equal(outcomes.filter((o) => o.skipped.length === 1 && o.skipped[0].reason === "already_blocked").length, 1);
            assert.equal(await VmSlot.countDocuments({ date: DATE, time: "14:00" }), 1);
        });
    });

    // ── C3: unblock ───────────────────────────────────────────────────────────

    describe("POST /admin/vm/blocks/remove", () => {
        it("removes a block and frees the slot", async () => {
            await post(BLOCKS, { date: DATE, time: "10:00", ...ADMIN });

            const res = await post(UNBLOCKS, { date: DATE, time: "10:00", ...ADMIN });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { unblocked: ["10:00"] });
            assert.equal(await slotAt(DATE, "10:00"), null);
            assert.ok(await book(DATE, "10:00"), "the slot can be booked again");
        });

        it("never removes a booked slot", async () => {
            const { bookingId } = await book(DATE, "10:00");

            const res = await post(UNBLOCKS, { date: DATE, time: "10:00", ...ADMIN });

            assert.deepEqual(res.body.data, { unblocked: [] });
            const slot = await slotAt(DATE, "10:00");
            assert.equal(slot.state, "booked");
            assert.equal(slot.bookingId, bookingId);
        });

        it("a free slot is simply not listed", async () => {
            const res = await post(UNBLOCKS, { date: DATE, time: "10:00", ...ADMIN });

            assert.deepEqual(res.body.data, { unblocked: [] });
        });

        it("a whole day removes the blocks and leaves the bookings", async () => {
            await post(BLOCKS, { date: DATE, time: "10:00", ...ADMIN });
            await post(BLOCKS, { date: DATE, time: "12:00", ...ADMIN });
            await book(DATE, "14:00");

            const res = await post(UNBLOCKS, { date: DATE, allDay: true, ...ADMIN });

            assert.deepEqual(res.body.data, { unblocked: ["10:00", "12:00"] });
            const slots = await VmSlot.find({ date: DATE }).lean();
            assert.deepEqual(slots.map((s) => [s.time, s.state]), [["14:00", "booked"]]);
        });

        it("works on a past date (an admin can clean up old blocks)", async () => {
            await VmSlot.create({
                date: YESTERDAY, time: "10:00", state: "blocked", blockedBy: "Anita", blockReason: "Old",
                blockedAt: new Date(), expireAt: new Date("2027-01-01T00:00:00Z"),
            });

            const res = await post(UNBLOCKS, { date: YESTERDAY, time: "10:00", ...ADMIN });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { unblocked: ["10:00"] });
        });
    });

    // ── C4, C5, C6: cancel ────────────────────────────────────────────────────

    describe("POST /admin/vm/bookings/:bookingId/cancel", () => {
        it("cancels the booking, frees the slot, and the customer can rebook it", async () => {
            const email = "rahul@example.com";
            const { bookingId } = await book(DATE, "10:00", { email });

            const res = await post(cancelUrl(bookingId), { ...ADMIN, alsoBlock: false });

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.deepEqual(res.body.data, { bookingId, status: "cancelled", slot: "released" });

            const stored = await VmBooking.findOne({ bookingId }).lean();
            assert.equal(stored.status, "cancelled");
            assert.equal(stored.cancelledBy, "Anita");
            assert.equal(stored.cancelReason, "Site visit");
            assert.equal(stored.cancelledAt.toISOString(), NOW.replace("Z", ".000Z"));
            assert.equal(await slotAt(DATE, "10:00"), null, "the slot document is deleted");

            // the same customer books the same slot again (no ACTIVE_BOOKING_EXISTS, no SLOT_TAKEN)
            const again = await book(DATE, "10:00", { email });
            assert.notEqual(again.bookingId, bookingId);
            assert.equal((await slotAt(DATE, "10:00")).bookingId, again.bookingId);
        });

        it("sends the customer a cancellation email (no internal reason) and deletes the Google event", async () => {
            const client = fakeCalendar();
            google.setCalendarClient(client);
            const { bookingId } = await book(DATE, "10:00", { email: "rahul@example.com" });
            await eventually(() => mailsTo("rahul@example.com").length >= 1);   // the confirmation
            emailOutbox.clear();

            const reason = "INTERNAL-ONLY-REASON-XYZ";
            const res = await post(cancelUrl(bookingId), { performedBy: "Anita", reason, alsoBlock: false });
            assert.equal(res.status, 200);

            assert.ok(await eventually(() => mailsTo("rahul@example.com").length === 1), "one email to the customer");
            const [mail] = mailsTo("rahul@example.com");
            assert.match(mail.subject, /Cancelled/);
            assert.ok(mail.text.includes(bookingId));
            assert.ok(!mail.text.includes(reason) && !mail.html.includes(reason), "the internal reason is not in the email");
            assert.ok(!mail.subject.includes(reason));
            assert.equal(mailsTo("company@oceao.test").length, 0, "no company email");

            assert.ok(await eventually(() => client.calls.delete.length === 1), "Google delete was called once");
            assert.equal(client.calls.delete[0].params.eventId, "evt-123");
            assert.equal(client.calls.delete[0].params.sendUpdates, "all");
        });

        it("alsoBlock: ONE updateOne turns the slot into a block and unsets bookingId (no delete)", async () => {
            const { bookingId } = await book(DATE, "10:00");
            const updateOne = mock.method(VmSlot, "updateOne");
            const deleteOne = mock.method(VmSlot, "deleteOne");

            const res = await post(cancelUrl(bookingId), { performedBy: "Anita", reason: "Client asked to hold", alsoBlock: true });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { bookingId, status: "cancelled", slot: "blocked" });

            assert.equal(updateOne.mock.callCount(), 1);
            assert.equal(deleteOne.mock.callCount(), 0);
            const [filter, update] = updateOne.mock.calls[0].arguments;
            assert.deepEqual(filter, { date: DATE, time: "10:00", bookingId });
            assert.equal(update.$set.state, "blocked");
            assert.equal(update.$set.blockedBy, "Anita");
            assert.equal(update.$set.blockReason, "Client asked to hold");
            assert.deepEqual(update.$unset, { bookingId: 1 });

            const slot = await slotAt(DATE, "10:00");
            assert.equal(slot.state, "blocked");
            assert.equal(slot.blockedBy, "Anita");
            assert.equal(slot.blockReason, "Client asked to hold");
            assert.ok(slot.blockedAt);
            assert.equal(slot.bookingId, undefined);
            assert.equal((await VmSlot.countDocuments({ date: DATE, time: "10:00" })), 1);

            await assert.rejects(() => book(DATE, "10:00"), (error) => error.code === "SLOT_TAKEN");
        });

        it("without alsoBlock: ONE deleteOne on { date, time, bookingId } and no update", async () => {
            const { bookingId } = await book(DATE, "10:00");
            const updateOne = mock.method(VmSlot, "updateOne");
            const deleteOne = mock.method(VmSlot, "deleteOne");

            await post(cancelUrl(bookingId), { ...ADMIN, alsoBlock: false });

            assert.equal(deleteOne.mock.callCount(), 1);
            assert.deepEqual(deleteOne.mock.calls[0].arguments[0], { date: DATE, time: "10:00", bookingId });
            assert.equal(updateOne.mock.callCount(), 0);
        });

        it("only touches its own slot (other bookings and blocks stay)", async () => {
            const target = await book(DATE, "10:00");
            const other = await book(DATE, "12:00");
            await post(BLOCKS, { date: DATE, time: "14:00", ...ADMIN });

            await post(cancelUrl(target.bookingId), { ...ADMIN, alsoBlock: false });

            const slots = await VmSlot.find({ date: DATE }).sort({ time: 1 }).lean();
            assert.deepEqual(slots.map((s) => [s.time, s.state]), [["12:00", "booked"], ["14:00", "blocked"]]);
            assert.equal((await VmBooking.findOne({ bookingId: other.bookingId })).status, "confirmed");
        });

        it("a booking that does not exist is 404 NOT_FOUND", async () => {
            const res = await post(cancelUrl("OE-VM-261015-ZZZZ"), { ...ADMIN, alsoBlock: false });

            assert.equal(res.status, 404);
            assert.equal(res.body.code, "NOT_FOUND");
            assert.equal(await AuditLog.countDocuments(), 0);
        });

        it("an already cancelled booking is 409 NOT_CANCELLABLE", async () => {
            const { bookingId } = await book(DATE, "10:00");
            await post(cancelUrl(bookingId), { ...ADMIN, alsoBlock: false });

            const res = await post(cancelUrl(bookingId), { ...ADMIN, alsoBlock: false });

            assert.equal(res.status, 409);
            assert.equal(res.body.code, "NOT_CANCELLABLE");
            assert.equal((await audit("vm.cancel")).length, 1, "only the first cancel is audited");
        });

        it("a past booking is 409 NOT_CANCELLABLE and nothing changes", async () => {
            const past = await VmBooking.create({
                bookingId: "OE-VM-261013-ABCD", date: YESTERDAY, time: "10:00", name: "Old Meeting",
                email: "old@example.com", mobileNumber: "+919876543210", status: "confirmed", meetStatus: "created",
                meetLink: LINK, googleEventId: "evt-old", expireAt: new Date("2027-01-01T00:00:00Z"),
            });
            await VmSlot.create({
                date: YESTERDAY, time: "10:00", state: "booked", bookingId: past.bookingId,
                expireAt: new Date("2027-01-01T00:00:00Z"),
            });
            const client = fakeCalendar();
            google.setCalendarClient(client);

            const res = await post(cancelUrl(past.bookingId), { ...ADMIN, alsoBlock: true });

            assert.equal(res.status, 409);
            assert.equal(res.body.code, "NOT_CANCELLABLE");
            assert.equal((await VmBooking.findOne({ bookingId: past.bookingId })).status, "confirmed");
            assert.equal((await slotAt(YESTERDAY, "10:00")).state, "booked");
            assert.equal(client.calls.delete.length, 0);
            assert.equal(emailOutbox.all().length, 0);
            assert.equal(await AuditLog.countDocuments(), 0);
        });

        it("a meeting that has already started today is 409; one still ahead today can be cancelled", async () => {
            const make = (time, bookingId) => VmBooking.create({
                bookingId, date: TODAY, time, name: "Today", email: `${bookingId}@example.com`,
                mobileNumber: "+919876543210", status: "confirmed", meetStatus: "created",
                expireAt: new Date("2027-01-01T00:00:00Z"),
            }).then((b) => VmSlot.create({
                date: TODAY, time, state: "booked", bookingId: b.bookingId, expireAt: new Date("2027-01-01T00:00:00Z"),
            }).then(() => b));
            const started = await make("10:00", "OE-VM-261014-AAAA");   // now is 10:30 IST
            const ahead = await make("12:00", "OE-VM-261014-BBBB");

            const late = await post(cancelUrl(started.bookingId), { ...ADMIN, alsoBlock: false });
            assert.equal(late.status, 409);
            assert.equal(late.body.code, "NOT_CANCELLABLE");

            const ok = await post(cancelUrl(ahead.bookingId), { ...ADMIN, alsoBlock: false });
            assert.equal(ok.status, 200);
        });

        it("two admins cancelling at once: one 200, one 409, one audit entry, one email", async () => {
            const { bookingId } = await book(DATE, "10:00", { email: "rahul@example.com" });
            await eventually(() => mailsTo("rahul@example.com").length >= 1);
            emailOutbox.clear();

            const results = await Promise.all([
                post(cancelUrl(bookingId), { ...ADMIN, alsoBlock: false }),
                post(cancelUrl(bookingId), { ...ADMIN, alsoBlock: false }),
            ]);

            assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
            assert.equal((await audit("vm.cancel")).length, 1);
            await eventually(() => mailsTo("rahul@example.com").length >= 1);
            assert.equal(mailsTo("rahul@example.com").length, 1);
        });

        it("a booking with no Google event cancels without calling Google", async () => {
            google.setCalendarClient(fakeCalendar({ insert: async () => { throw new Error("quota"); } }));
            const { bookingId, meetStatus } = await book(DATE, "10:00");
            assert.equal(meetStatus, "failed");
            const client = fakeCalendar();
            google.setCalendarClient(client);

            const res = await post(cancelUrl(bookingId), { ...ADMIN, alsoBlock: false });

            assert.equal(res.status, 200);
            await new Promise((resolve) => setTimeout(resolve, 50));
            assert.equal(client.calls.delete.length, 0);
        });

        it("a Google failure does not fail the cancellation (it is logged only)", async () => {
            const client = fakeCalendar({ remove: async () => { throw new Error("google down"); } });
            google.setCalendarClient(client);
            const { bookingId } = await book(DATE, "10:00");

            const res = await post(cancelUrl(bookingId), { ...ADMIN, alsoBlock: false });

            assert.equal(res.status, 200);
            assert.equal((await VmBooking.findOne({ bookingId })).status, "cancelled");
            assert.ok(await eventually(() => client.calls.delete.length === 1));
        });

        it("an email failure does not fail the cancellation", async () => {
            const { bookingId } = await book(DATE, "10:00", { email: "rahul@example.com" });
            await eventually(() => mailsTo("rahul@example.com").length >= 1);
            emailOutbox.clear();
            emailOutbox.failNext("customer");

            const res = await post(cancelUrl(bookingId), { ...ADMIN, alsoBlock: false });

            assert.equal(res.status, 200);
            assert.equal((await VmBooking.findOne({ bookingId })).status, "cancelled");
        });
    });

    // ── C7: retry Meet ────────────────────────────────────────────────────────

    describe("POST /admin/vm/bookings/:bookingId/retry-meet", () => {
        // A booking whose Meet link failed at booking time.
        const bookWithFailedMeet = async (email = "rahul@example.com") => {
            google.setCalendarClient(fakeCalendar({ insert: async () => { throw new Error("quota"); } }));
            const booked = await book(DATE, "10:00", { email });
            assert.equal(booked.meetStatus, "failed");
            return booked;
        };

        it("creates the link, saves it and emails the customer the link", async () => {
            const { bookingId } = await bookWithFailedMeet("rahul@example.com");
            await eventually(() => mailsTo("rahul@example.com").length >= 1);
            emailOutbox.clear();
            const client = fakeCalendar();
            google.setCalendarClient(client);

            const res = await post(retryUrl(bookingId), { performedBy: "Anita" });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { bookingId, meetLink: LINK, meetStatus: "created" });
            const stored = await VmBooking.findOne({ bookingId }).lean();
            assert.equal(stored.meetStatus, "created");
            assert.equal(stored.meetLink, LINK);
            assert.equal(stored.googleEventId, "evt-123");
            assert.equal(client.calls.insert.length, 1);

            assert.ok(await eventually(() => mailsTo("rahul@example.com").length === 1));
            assert.ok(mailsTo("rahul@example.com")[0].text.includes(LINK));
        });

        it("409 MEET_ALREADY_CREATED when the booking already has a link", async () => {
            const { bookingId } = await book(DATE, "10:00");
            const client = fakeCalendar();
            google.setCalendarClient(client);

            const res = await post(retryUrl(bookingId), { performedBy: "Anita" });

            assert.equal(res.status, 409);
            assert.equal(res.body.code, "MEET_ALREADY_CREATED");
            assert.equal(client.calls.insert.length, 0, "Google was not called");
            assert.equal(await AuditLog.countDocuments({ action: "vm.retry_meet" }), 0);
        });

        it("502 MEET_CREATE_FAILED when Google fails, and the booking stays retryable", async () => {
            const { bookingId } = await bookWithFailedMeet();
            google.setCalendarClient(fakeCalendar({ insert: async () => { throw Object.assign(new Error("boom"), { code: 500 }); } }));

            const res = await post(retryUrl(bookingId), { performedBy: "Anita" });

            assert.equal(res.status, 502);
            assert.equal(res.body.code, "MEET_CREATE_FAILED");
            const stored = await VmBooking.findOne({ bookingId }).lean();
            assert.equal(stored.meetStatus, "failed");
            assert.equal(stored.meetLink, null);
            assert.equal(await AuditLog.countDocuments({ action: "vm.retry_meet" }), 0);

            // and a second attempt, with Google back, works
            google.setCalendarClient(fakeCalendar());
            const again = await post(retryUrl(bookingId), { performedBy: "Anita" });
            assert.equal(again.status, 200);
        });

        it("404 for an unknown booking, 409 NOT_CANCELLABLE for a cancelled one", async () => {
            const missing = await post(retryUrl("OE-VM-261015-ZZZZ"), { performedBy: "Anita" });
            assert.equal(missing.status, 404);
            assert.equal(missing.body.code, "NOT_FOUND");

            const { bookingId } = await bookWithFailedMeet();
            await post(cancelUrl(bookingId), { ...ADMIN, alsoBlock: false });
            const cancelled = await post(retryUrl(bookingId), { performedBy: "Anita" });
            assert.equal(cancelled.status, 409);
            assert.equal(cancelled.body.code, "NOT_CANCELLABLE");
        });
    });

    // ── C1: audit log ─────────────────────────────────────────────────────────

    describe("audit log", () => {
        const THIRTY_SIX_HOURS = 36 * 60 * 60 * 1000;

        it("a block writes one entry with the action, target, date, detail, who and why", async () => {
            await post(BLOCKS, { date: DATE, time: "10:00", performedBy: "Anita", reason: "Site visit" });

            const entries = await audit();
            assert.equal(entries.length, 1);
            const entry = entries[0];
            assert.equal(entry.action, "vm.block");
            assert.equal(entry.targetType, "vm_slot");
            assert.equal(entry.targetId, `${DATE} 10:00`);
            assert.equal(entry.date, DATE);
            assert.deepEqual(entry.detail, { allDay: false, blocked: ["10:00"], skipped: [] });
            assert.equal(entry.performedBy, "Anita");
            assert.equal(entry.reason, "Site visit");
        });

        it("expireAt is 180 days after the write", async () => {
            await post(BLOCKS, { date: DATE, time: "10:00", ...ADMIN });

            const [entry] = await audit();
            const expected = new Date(NOW).getTime() + 180 * 24 * 60 * 60 * 1000;
            assert.equal(entry.expireAt.getTime(), expected);
        });

        it("the collection has a TTL index on expireAt", async () => {
            const indexes = await AuditLog.collection.indexes();
            const ttl = indexes.find((index) => index.key.expireAt === 1);

            assert.ok(ttl, "an index on expireAt exists");
            assert.equal(ttl.expireAfterSeconds, 0);
        });

        it("a whole-day block is ONE entry (not one per slot)", async () => {
            await book(DATE, "12:00");

            await post(BLOCKS, { date: DATE, allDay: true, ...ADMIN });

            const entries = await audit("vm.block");
            assert.equal(entries.length, 1);
            assert.equal(entries[0].targetId, DATE);
            assert.deepEqual(entries[0].detail, {
                allDay: true,
                blocked: ["10:00", "14:00", "16:00"],
                skipped: [{ time: "12:00", reason: "booked" }],
            });
        });

        it("a block where everything was skipped is still recorded (it was an admin action)", async () => {
            await book(DATE, "10:00");

            await post(BLOCKS, { date: DATE, time: "10:00", ...ADMIN });

            const [entry] = await audit("vm.block");
            assert.deepEqual(entry.detail.blocked, []);
            assert.deepEqual(entry.detail.skipped, [{ time: "10:00", reason: "booked" }]);
        });

        it("unblock, cancel and retry each write their own entry", async () => {
            await post(BLOCKS, { date: DATE, time: "12:00", ...ADMIN });
            await post(UNBLOCKS, { date: DATE, time: "12:00", performedBy: "Rohan", reason: "Plans changed" });

            const { bookingId } = await book(DATE, "10:00");
            await post(cancelUrl(bookingId), { performedBy: "Priya", reason: "Client asked", alsoBlock: true });

            google.setCalendarClient(fakeCalendar({ insert: async () => { throw new Error("quota"); } }));
            const failed = await book(DATE, "14:00");
            google.setCalendarClient(fakeCalendar());
            await post(retryUrl(failed.bookingId), { performedBy: "Meera" });

            const unblock = (await audit("vm.unblock"))[0];
            assert.equal(unblock.targetType, "vm_slot");
            assert.equal(unblock.targetId, `${DATE} 12:00`);
            assert.deepEqual(unblock.detail, { allDay: false, unblocked: ["12:00"] });
            assert.equal(unblock.performedBy, "Rohan");
            assert.equal(unblock.reason, "Plans changed");

            const cancel = (await audit("vm.cancel"))[0];
            assert.equal(cancel.targetType, "vm_booking");
            assert.equal(cancel.targetId, bookingId);
            assert.equal(cancel.date, DATE);
            assert.deepEqual(cancel.detail, { time: "10:00", alsoBlock: true, slot: "blocked" });
            assert.equal(cancel.performedBy, "Priya");
            assert.equal(cancel.reason, "Client asked");

            const retry = (await audit("vm.retry_meet"))[0];
            assert.equal(retry.targetType, "vm_booking");
            assert.equal(retry.targetId, failed.bookingId);
            assert.equal(retry.performedBy, "Meera");
            assert.deepEqual(retry.detail, { time: "14:00", meetStatus: "created" });

            assert.equal(await AuditLog.countDocuments(), 4);
        });

        it("rejected requests write nothing", async () => {
            await post(BLOCKS, { date: YESTERDAY, time: "10:00", ...ADMIN });     // 422
            await post(BLOCKS, { date: DATE, time: "10:00", performedBy: "A", reason: "xx" });   // 400
            await post(cancelUrl("OE-VM-261015-ZZZZ"), { ...ADMIN });             // 404
            await post(BLOCKS, { date: DATE, time: "10:00", ...ADMIN }, { session: null });      // 401

            assert.equal(await AuditLog.countDocuments(), 0);
        });

        it("entries never hold the customer's email or phone number", async () => {
            const { bookingId } = await book(DATE, "10:00", { email: "private.person@example.com", mobileNumber: "+919123456789" });
            await post(cancelUrl(bookingId), { ...ADMIN, alsoBlock: true });
            await post(BLOCKS, { date: DATE, allDay: true, ...ADMIN });

            const text = JSON.stringify(await audit());
            assert.ok(!text.includes("private.person@example.com"));
            assert.ok(!text.includes("919123456789"));
        });

        it("a failed audit write does not undo or fail the action (it is logged)", async () => {
            mock.method(AuditLog, "create", async () => { throw new Error("audit store down"); });

            const res = await post(BLOCKS, { date: DATE, time: "10:00", ...ADMIN });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { blocked: ["10:00"], skipped: [] });
            assert.equal((await slotAt(DATE, "10:00")).state, "blocked");
        });

        it("the model enforces performedBy and reason lengths", async () => {
            const base = {
                action: "vm.block", targetType: "vm_slot", targetId: "x", performedBy: "Anita",
                reason: "Site visit", expireAt: new Date(Date.now() + THIRTY_SIX_HOURS),
            };

            await assert.rejects(() => AuditLog.create({ ...base, performedBy: "A" }), /performedBy/);
            await assert.rejects(() => AuditLog.create({ ...base, performedBy: "x".repeat(61) }), /performedBy/);
            await assert.rejects(() => AuditLog.create({ ...base, reason: "ab" }), /reason/);
            await assert.rejects(() => AuditLog.create({ ...base, reason: "x".repeat(301) }), /reason/);
            await assert.rejects(() => AuditLog.create({ ...base, targetType: "nope" }), /targetType/);
            await assert.rejects(() => AuditLog.create({ ...base, expireAt: undefined }), /expireAt/);
            assert.ok(await AuditLog.create(base));
        });
    });
});
