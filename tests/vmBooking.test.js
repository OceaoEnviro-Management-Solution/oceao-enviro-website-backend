import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
import {
    startTestEnv,
    stopTestEnv,
    resetState,
    getApp,
    emailOutbox,
    TEST_COMPANY_MAIL,
    TEST_BOOKING_TOKEN_SECRET,
} from "./helpers/setup.js";
import { expireAtFor } from "../src/utils/time.js";
import { BOOKING_ID_PATTERN } from "../src/utils/ids.js";

const URL = "/api/v1/vm/bookings";

// Wed 14 Oct 2026, 10:30 IST. Bookings below are for Thu 15 Oct 2026.
const NOW = "2026-10-14T05:00:00Z";
const DATE = "2026-10-15";

let VmSlot;
let VmBooking;
let Holiday;

const freezeTime = (iso = NOW) => mock.timers.enable({ apis: ["Date"], now: new Date(iso) });

const tokenFor = (email, claims = {}, options = {}) =>
    jwt.sign({ sub: email, purpose: "vm-booking", ...claims }, TEST_BOOKING_TOKEN_SECRET, {
        algorithm: "HS256",
        expiresIn: 1800,
        ...options,
    });

const validBody = (overrides = {}) => ({
    name: "Rahul Kumar",
    mobileNumber: "9876543210",
    organisation: "ABC Pvt Ltd",
    designation: "Plant Head",
    topic: "EIA for new unit",
    date: DATE,
    time: "10:00",
    ...overrides,
});

const book = (email, body = validBody()) =>
    request(getApp()).post(URL).set("Authorization", `Bearer ${tokenFor(email)}`).send(body);

const slotsCount = () => VmSlot.countDocuments();
const bookingsCount = () => VmBooking.countDocuments();

// Emails are sent after the response without being awaited: give them a moment to land.
const waitForEmails = async (count) => {
    for (let i = 0; i < 50 && emailOutbox.all().length < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return emailOutbox.all();
};

describe("POST /api/v1/vm/bookings", () => {
    before(async () => {
        await startTestEnv();
        ({ VmSlot } = await import("../src/models/vmSlot.model.js"));
        ({ VmBooking } = await import("../src/models/vmBooking.model.js"));
        ({ Holiday } = await import("../src/models/holiday.model.js"));
    });
    after(stopTestEnv);
    beforeEach(resetState);
    afterEach(() => mock.timers.reset());

    describe("happy path", () => {
        it("books the slot: 201, a slot document, a booking document and two emails", async () => {
            freezeTime();

            const res = await book("rahul@example.com");

            assert.equal(res.status, 201);
            assert.equal(res.body.success, true);
            const { data } = res.body;
            assert.deepEqual(Object.keys(data).sort(),
                ["bookingId", "date", "durationMinutes", "meetLink", "meetStatus", "time"]);
            assert.match(data.bookingId, BOOKING_ID_PATTERN);
            assert.match(data.bookingId, /^OE-VM-261015-/);
            assert.equal(data.date, DATE);
            assert.equal(data.time, "10:00");
            assert.equal(data.durationMinutes, 60);
            assert.equal(data.meetLink, null);
            assert.equal(data.meetStatus, "failed");

            const slot = await VmSlot.findOne({ date: DATE, time: "10:00" }).lean();
            assert.equal(slot.state, "booked");
            assert.equal(slot.bookingId, data.bookingId);
            assert.equal(slot.expireAt.getTime(), expireAtFor(DATE).getTime());

            const booking = await VmBooking.findOne({ bookingId: data.bookingId }).lean();
            assert.equal(booking.status, "confirmed");
            assert.equal(booking.meetStatus, "failed");
            assert.equal(booking.meetLink, null);
            assert.equal(booking.email, "rahul@example.com");
            assert.equal(booking.mobileNumber, "+919876543210");
            assert.equal(booking.name, "Rahul Kumar");
            assert.equal(booking.organisation, "ABC Pvt Ltd");
            assert.equal(booking.designation, "Plant Head");
            assert.equal(booking.topic, "EIA for new unit");
            assert.equal(booking.expireAt.getTime(), expireAtFor(DATE).getTime());

            const mails = await waitForEmails(2);
            assert.equal(mails.length, 2);
            const company = mails.find((m) => m.to === TEST_COMPANY_MAIL);
            const customer = mails.find((m) => m.to === "rahul@example.com");
            assert.ok(company && customer);
            assert.equal(company.replyTo, "rahul@example.com");
            assert.ok(company.text.includes("EIA for new unit"));
            assert.equal(customer.text.includes("EIA for new unit"), false);
            assert.match(customer.text, /Your Google Meet link will follow in a separate email\./);
        });

        it("accepts a minimal body (optional fields left out)", async () => {
            freezeTime();

            const res = await book("rahul@example.com", { name: "Rahul Kumar", mobileNumber: "9876543210", date: DATE, time: "14:00" });

            assert.equal(res.status, 201);
            const booking = await VmBooking.findOne({ bookingId: res.body.data.bookingId }).lean();
            assert.equal(booking.organisation, undefined);
            assert.equal(booking.topic, undefined);
        });

        it("normalizes the mobile number and treats blank optional fields as absent", async () => {
            freezeTime();

            const res = await book("rahul@example.com", validBody({ mobileNumber: "+91 98765-43210", organisation: "   ", topic: "" }));

            assert.equal(res.status, 201);
            const booking = await VmBooking.findOne({ bookingId: res.body.data.bookingId }).lean();
            assert.equal(booking.mobileNumber, "+919876543210");
            assert.equal(booking.organisation, undefined);
            assert.equal(booking.topic, undefined);
        });

        it("uses a different slot on the same day or a different day without conflict", async () => {
            freezeTime();

            assert.equal((await book("a@example.com", validBody({ time: "10:00" }))).status, 201);
            assert.equal((await book("b@example.com", validBody({ time: "12:00" }))).status, 201);
            assert.equal((await book("c@example.com", validBody({ date: "2026-10-16", time: "10:00" }))).status, 201);
            assert.equal(await slotsCount(), 3);
        });
    });

    describe("slot conflicts", () => {
        it("a slot that is already booked gives 409 SLOT_TAKEN", async () => {
            freezeTime();
            assert.equal((await book("first@example.com")).status, 201);

            const res = await book("second@example.com");

            assert.equal(res.status, 409);
            assert.equal(res.body.success, false);
            assert.equal(res.body.code, "SLOT_TAKEN");
            assert.equal(await slotsCount(), 1);
            assert.equal(await bookingsCount(), 1);
            assert.equal(await VmBooking.countDocuments({ email: "second@example.com" }), 0);
        });

        it("a blocked slot gives 409 SLOT_TAKEN", async () => {
            freezeTime();
            await VmSlot.create({
                date: DATE, time: "10:00", state: "blocked", blockedBy: "Anita",
                blockReason: "Site visit", blockedAt: new Date(), expireAt: expireAtFor(DATE),
            });

            const res = await book("rahul@example.com");

            assert.equal(res.status, 409);
            assert.equal(res.body.code, "SLOT_TAKEN");
            assert.equal(await bookingsCount(), 0);
            assert.equal((await VmSlot.findOne({ date: DATE, time: "10:00" })).state, "blocked", "the block is untouched");
        });
    });

    describe("one active booking per email", () => {
        const seed = (overrides = {}) =>
            VmBooking.create({
                bookingId: "OE-VM-261020-K7Q2", date: "2026-10-20", time: "10:00", name: "Rahul Kumar",
                email: "rahul@example.com", mobileNumber: "+919876543210", status: "confirmed",
                meetStatus: "failed", expireAt: expireAtFor("2026-10-20"), ...overrides,
            });

        it("a confirmed booking dated today or later gives 409 ACTIVE_BOOKING_EXISTS and claims nothing", async () => {
            freezeTime();
            await seed();

            const res = await book("rahul@example.com");

            assert.equal(res.status, 409);
            assert.equal(res.body.code, "ACTIVE_BOOKING_EXISTS");
            assert.equal(await slotsCount(), 0);
        });

        it("a booking dated today still counts", async () => {
            freezeTime();
            await seed({ bookingId: "OE-VM-261014-K7Q2", date: "2026-10-14" });

            const res = await book("rahul@example.com");

            assert.equal(res.body.code, "ACTIVE_BOOKING_EXISTS");
        });

        it("a past booking or a cancelled booking does not count", async () => {
            freezeTime();
            await seed({ bookingId: "OE-VM-261013-AAAA", date: "2026-10-13" });
            await seed({ bookingId: "OE-VM-261022-BBBB", date: "2026-10-22", status: "cancelled" });

            const res = await book("rahul@example.com");

            assert.equal(res.status, 201);
        });

        it("another email is not affected", async () => {
            freezeTime();
            await seed();

            const res = await book("someone.else@example.com");

            assert.equal(res.status, 201);
        });

        it("checks the active booking before claiming a slot, even when the slot is also taken", async () => {
            freezeTime();
            await seed();
            assert.equal((await book("other@example.com")).status, 201);

            const res = await book("rahul@example.com");   // active booking AND slot taken

            assert.equal(res.body.code, "ACTIVE_BOOKING_EXISTS");
        });
    });

    describe("day and time rules", () => {
        const expectNotBookable = (res, reason) => {
            assert.equal(res.status, 422);
            assert.equal(res.body.success, false);
            assert.equal(res.body.code, "DATE_NOT_BOOKABLE");
            assert.equal(res.body.errors.reason, reason);
        };

        it("a Sunday gives 422 DATE_NOT_BOOKABLE (non_working_day)", async () => {
            freezeTime();

            expectNotBookable(await book("rahul@example.com", validBody({ date: "2026-10-18" })), "non_working_day");
            assert.equal(await slotsCount(), 0);
        });

        it("the 2nd Saturday of the month gives 422 non_working_day", async () => {
            freezeTime("2026-11-04T05:00:00Z");

            expectNotBookable(await book("rahul@example.com", validBody({ date: "2026-11-14" })), "non_working_day");
            assert.equal(await slotsCount(), 0);
        });

        it("any other Saturday can be booked (3rd Saturday, 17 Oct 2026)", async () => {
            freezeTime();

            const res = await book("rahul@example.com", validBody({ date: "2026-10-17", time: "14:00" }));

            assert.equal(res.status, 201);
            assert.equal(res.body.data.date, "2026-10-17");
            assert.equal(res.body.data.time, "14:00");
            assert.equal(await slotsCount(), 1);
        });

        it("a holiday gives 422 with reason holiday", async () => {
            freezeTime();
            await Holiday.create({ date: "2026-10-20", name: "Test holiday" });

            expectNotBookable(await book("rahul@example.com", validBody({ date: "2026-10-20" })), "holiday");
        });

        it("a past date and a date beyond the horizon give 422", async () => {
            freezeTime();

            expectNotBookable(await book("rahul@example.com", validBody({ date: "2026-10-13" })), "past");
            expectNotBookable(await book("rahul@example.com", validBody({ date: "2026-11-16" })), "beyond_horizon");
        });

        it("today+30 is accepted", async () => {
            freezeTime("2026-10-12T05:00:00Z");   // Mon 12 Oct; +30 = Wed 11 Nov

            const res = await book("rahul@example.com", validBody({ date: "2026-11-11" }));

            assert.equal(res.status, 201);
        });

        it("a slot inside the 2 hour lead time gives 422 with reason closed", async () => {
            freezeTime();   // 10:30 IST: the 12:00 slot is only 90 minutes away

            expectNotBookable(await book("rahul@example.com", validBody({ date: "2026-10-14", time: "12:00" })), "closed");
            expectNotBookable(await book("rahul@example.com", validBody({ date: "2026-10-14", time: "10:00" })), "closed");
            assert.equal(await slotsCount(), 0);
        });

        it("a slot exactly 120 minutes away is accepted", async () => {
            freezeTime("2026-10-14T04:30:00Z");   // 10:00:00 IST, the 12:00 slot is 120 minutes away

            const res = await book("rahul@example.com", validBody({ date: "2026-10-14", time: "12:00" }));

            assert.equal(res.status, 201);
        });
    });

    describe("authentication", () => {
        const send = (authorization, body = validBody()) => {
            const req = request(getApp()).post(URL);
            if (authorization !== undefined) req.set("Authorization", authorization);
            return req.send(body);
        };
        const expectRejected = (res) => {
            assert.equal(res.status, 401);
            assert.equal(res.body.success, false);
            assert.equal(res.body.code, "BOOKING_TOKEN_INVALID");
        };

        it("rejects a missing token, an invalid token and a wrong-purpose token", async () => {
            freezeTime();

            expectRejected(await send(undefined));
            expectRejected(await send("Bearer not-a-token"));
            expectRejected(await send(`Bearer ${tokenFor("rahul@example.com", { purpose: "admin" })}`));
            expectRejected(await send(`Bearer ${jwt.sign({ sub: "x@example.com", purpose: "vm-booking" }, "y".repeat(40))}`));
        });

        it("rejects an expired token", async () => {
            freezeTime();

            expectRejected(await send(`Bearer ${tokenFor("rahul@example.com", {}, { expiresIn: -10 })}`));
            assert.equal(await slotsCount(), 0);
        });

        it("checks the token before the body", async () => {
            const res = await send(undefined, { nonsense: true });

            expectRejected(res);
        });
    });

    describe("the email always comes from the token", () => {
        it("ignores an email in the body", async () => {
            freezeTime();

            const res = await book("verified@example.com", { ...validBody(), email: "attacker@example.com" });

            assert.equal(res.status, 201);
            const booking = await VmBooking.findOne({ bookingId: res.body.data.bookingId }).lean();
            assert.equal(booking.email, "verified@example.com");
            assert.equal(await VmBooking.countDocuments({ email: "attacker@example.com" }), 0);
            const mails = await waitForEmails(2);
            assert.ok(mails.some((m) => m.to === "verified@example.com"));
            assert.equal(mails.some((m) => m.to === "attacker@example.com"), false);
        });

        it("the active-booking check uses the token email, not a body email", async () => {
            freezeTime();
            assert.equal((await book("verified@example.com", validBody({ time: "10:00" }))).status, 201);

            const res = await book("verified@example.com", { ...validBody({ time: "12:00" }), email: "fresh@example.com" });

            assert.equal(res.body.code, "ACTIVE_BOOKING_EXISTS");
        });
    });

    describe("validation", () => {
        it("rejects invalid fields with 400 VALIDATION_FAILED and per-field errors", async () => {
            freezeTime();
            const cases = [
                [{ name: "R" }, "name"],
                [{ name: "N".repeat(101) }, "name"],
                [{ name: undefined }, "name"],
                [{ mobileNumber: "5876543210" }, "mobileNumber"],
                [{ mobileNumber: undefined }, "mobileNumber"],
                [{ organisation: "O".repeat(151) }, "organisation"],
                [{ designation: "D".repeat(101) }, "designation"],
                [{ topic: "T".repeat(501) }, "topic"],
                [{ date: "2026-02-30" }, "date"],
                [{ date: "15-10-2026" }, "date"],
                [{ date: undefined }, "date"],
                [{ time: "11:00" }, "time"],
                [{ time: "10:00:00" }, "time"],
                [{ time: undefined }, "time"],
            ];

            for (const [override, field] of cases) {
                const res = await book("rahul@example.com", validBody(override));

                assert.equal(res.status, 400, `${field} <- ${JSON.stringify(override).slice(0, 40)}`);
                assert.equal(res.body.code, "VALIDATION_FAILED");
                assert.ok(Array.isArray(res.body.errors[field]), `errors.${field}`);
            }
            assert.equal(await slotsCount(), 0);
            assert.equal(await bookingsCount(), 0);
        });

        it("accepts maximum-length optional fields", async () => {
            freezeTime();

            const res = await book("rahul@example.com", validBody({
                name: "N".repeat(100), organisation: "O".repeat(150), designation: "D".repeat(100), topic: "T".repeat(500),
            }));

            assert.equal(res.status, 201);
        });
    });

    describe("concurrency", () => {
        it("10 parallel requests with 10 different tokens for one slot: exactly one 201 and nine 409", async () => {
            freezeTime();
            const emails = Array.from({ length: 10 }, (_, i) => `user${i}@example.com`);

            const results = await Promise.all(emails.map((email) => book(email)));

            const created = results.filter((r) => r.status === 201);
            const taken = results.filter((r) => r.status === 409 && r.body.code === "SLOT_TAKEN");
            assert.equal(created.length, 1, `statuses: ${results.map((r) => r.status).join(",")}`);
            assert.equal(taken.length, 9);

            assert.equal(await slotsCount(), 1, "exactly one VmSlot");
            assert.equal(await bookingsCount(), 1, "exactly one VmBooking");

            const slot = await VmSlot.findOne({ date: DATE, time: "10:00" }).lean();
            const booking = await VmBooking.findOne().lean();
            assert.equal(slot.bookingId, booking.bookingId);
            assert.equal(slot.bookingId, created[0].body.data.bookingId);

            const mails = await waitForEmails(2);
            assert.equal(mails.length, 2, "only the winner is emailed");
        });

        it("parallel requests for different slots all succeed", async () => {
            freezeTime();
            const times = ["10:00", "12:00", "14:00", "16:00"];

            const results = await Promise.all(
                times.map((time, i) => book(`user${i}@example.com`, validBody({ time })))
            );

            assert.deepEqual(results.map((r) => r.status), [201, 201, 201, 201]);
            assert.equal(await slotsCount(), 4);
            assert.equal(await bookingsCount(), 4);
        });

        it("a burst of 20 requests across 2 slots books each slot exactly once", async () => {
            freezeTime();

            const results = await Promise.all(
                Array.from({ length: 20 }, (_, i) =>
                    book(`burst${i}@example.com`, validBody({ time: i % 2 === 0 ? "10:00" : "12:00" })))
            );

            assert.equal(results.filter((r) => r.status === 201).length, 2);
            assert.equal(results.filter((r) => r.status === 409).length, 18);
            assert.equal(await slotsCount(), 2);
            assert.equal(await bookingsCount(), 2);
        });
    });

    describe("failure handling", () => {
        it("releases the claimed slot when saving the booking fails, and the slot can be booked afterwards", async () => {
            freezeTime();
            const create = mock.method(VmBooking, "create", async () => {
                throw new Error("database exploded");
            });

            const failed = await book("rahul@example.com");
            create.mock.restore();

            assert.equal(failed.status, 500);
            assert.equal(failed.body.success, false);
            assert.equal(await slotsCount(), 0, "the claimed slot was deleted");
            assert.equal(await bookingsCount(), 0);

            const retry = await book("rahul@example.com");
            assert.equal(retry.status, 201);
        });

        it("a failing confirmation email does not fail the booking", async () => {
            freezeTime();
            emailOutbox.failNext("company");
            emailOutbox.failNext("customer");

            const res = await book("rahul@example.com");

            assert.equal(res.status, 201);
            assert.equal(await bookingsCount(), 1);
        });

        it("retries with a new bookingId when the generated one already exists", async () => {
            freezeTime();
            await VmBooking.create({
                bookingId: "OE-VM-261015-2222", date: "2026-10-30", time: "16:00", name: "Existing Customer",
                email: "existing@example.com", mobileNumber: "+919876543210", status: "cancelled",
                meetStatus: "failed", expireAt: expireAtFor("2026-10-30"),
            });
            // The first generated ID is the existing one (every character draws index 0 -> "2");
            // afterwards randomInt is real again.
            let calls = 0;
            const original = crypto.randomInt.bind(crypto);
            const randomInt = mock.method(crypto, "randomInt", (...args) => (calls++ < 4 ? 0 : original(...args)));

            const res = await book("rahul@example.com");
            randomInt.mock.restore();

            assert.equal(res.status, 201);
            assert.notEqual(res.body.data.bookingId, "OE-VM-261015-2222");
            const slot = await VmSlot.findOne({ date: DATE, time: "10:00" }).lean();
            const booking = await VmBooking.findOne({ email: "rahul@example.com" }).lean();
            assert.equal(slot.bookingId, booking.bookingId, "the slot carries the final bookingId");
            assert.equal(booking.bookingId, res.body.data.bookingId);
        });

        it("gives up after 3 duplicate bookingIds, releases the slot and does not book", async () => {
            freezeTime();
            await VmBooking.create({
                bookingId: "OE-VM-261015-2222", date: "2026-10-30", time: "16:00", name: "Existing Customer",
                email: "existing@example.com", mobileNumber: "+919876543210", status: "cancelled",
                meetStatus: "failed", expireAt: expireAtFor("2026-10-30"),
            });
            const randomInt = mock.method(crypto, "randomInt", () => 0);   // always "2222"

            const res = await book("rahul@example.com");
            const attempts = randomInt.mock.callCount() / 4;
            randomInt.mock.restore();

            assert.equal(res.status, 409);
            assert.equal(res.body.code, "CONFLICT");
            assert.equal(attempts, 3, "three IDs were generated");
            assert.equal(await slotsCount(), 0, "the claimed slot was released");
            assert.equal(await VmBooking.countDocuments({ email: "rahul@example.com" }), 0);
        });
    });
});
