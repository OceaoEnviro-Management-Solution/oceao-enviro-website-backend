import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import request from "supertest";
import {
    startTestEnv, stopTestEnv, resetState, getApp,
    TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, TEST_ADMIN_ENV, TEST_ORIGIN,
    TEST_OTP_SECRET, TEST_BOOKING_TOKEN_SECRET,
} from "./helpers/setup.js";
import { addDays, expireAtFor, nowIST } from "../src/utils/time.js";
import { generateBookingId, generateRequestId } from "../src/utils/ids.js";
import { DB_NAME } from "../src/constant.js";

const BASE = "/api/v1/admin";

// Fixed dates (the admin views accept any date, so nothing here depends on today).
const TUESDAY = "2030-03-12";        // a normal working day
const MONDAY = "2030-03-11";
const WEDNESDAY = "2030-03-13";
const HOLIDAY = "2030-03-20";        // a Wednesday, stored as a holiday
const SUNDAY = "2030-03-17";
const SECOND_SATURDAY = "2030-03-09";
const FIRST_SATURDAY = "2030-03-02";

let VmBooking;
let VmSlot;
let CallbackBucket;
let CallbackRequest;
let Holiday;
let Settings;
let cookie;

const get = (path) => request(getApp()).get(`${BASE}${path}`).set("Cookie", cookie);
const getWithoutSession = (path) => request(getApp()).get(`${BASE}${path}`);

const keysOf = (object) => Object.keys(object).sort();

// ── data builders (models directly; these tests are about reading) ───────────

let counter = 0;
const nextEmail = (prefix) => `${prefix}${++counter}@example.com`;

const addBooking = async (date, time, over = {}) => {
    const booking = await VmBooking.create({
        bookingId: generateBookingId(date),
        date,
        time,
        name: "Rahul Kumar",
        email: nextEmail("vm"),
        mobileNumber: "+919876543210",
        organisation: "ABC Pvt Ltd",
        designation: "Plant Head",
        topic: "EIA for new unit",
        status: "confirmed",
        meetStatus: "created",
        meetLink: "https://meet.google.com/abc-defg-hij",
        googleEventId: "google-event-secret-id",
        expireAt: expireAtFor(date),
        ...over,
    });
    if (booking.status === "confirmed") {
        await VmSlot.create({ date, time, state: "booked", bookingId: booking.bookingId, expireAt: expireAtFor(date) });
    }
    return booking;
};

const addBlock = (date, time, blockedBy = "Anita", blockReason = "Site visit") =>
    VmSlot.create({
        date, time, state: "blocked", blockedBy, blockReason, blockedAt: new Date("2030-03-01T08:00:00Z"),
        expireAt: expireAtFor(date),
    });

const addRequest = (date, period, over = {}) =>
    CallbackRequest.create({
        requestId: generateRequestId(date),
        date,
        period,
        name: "John Doe",
        email: nextEmail("cb"),
        mobileNumber: "+917654321098",
        reason: "Water testing quote",
        status: "pending",
        expireAt: expireAtFor(date),
        ...over,
    });

// A full day: 2 meetings, 1 block, 1 cancelled booking (no slot), 4 live + 1 cancelled callback.
const seedBusyDay = async () => {
    const meetingAt10 = await addBooking(TUESDAY, "10:00", { name: "Rahul Kumar" });
    await addBlock(TUESDAY, "12:00", "Anita", "Site visit");
    const meetingAt14 = await addBooking(TUESDAY, "14:00", {
        name: "Priya Sharma", organisation: undefined, topic: undefined, meetStatus: "failed", meetLink: null,
    });
    await addBooking(TUESDAY, "16:00", { status: "cancelled", cancelledBy: "Anita", cancelReason: "Client asked" });

    const r1 = await addRequest(TUESDAY, "morning", { name: "John Doe" });
    const r2 = await addRequest(TUESDAY, "morning", { name: "Asha Verma", status: "completed", reason: undefined });
    const r3 = await addRequest(TUESDAY, "afternoon", { name: "Meera Nair" });
    await addRequest(TUESDAY, "evening", { name: "Cancelled Person", status: "cancelled" });
    const r5 = await addRequest(TUESDAY, "evening", { name: "Ravi Menon", status: "no_answer" });

    return { meetingAt10, meetingAt14, r1, r2, r3, r5 };
};

describe("Admin read endpoints", () => {
    before(async () => {
        await startTestEnv();
        ({ VmBooking } = await import("../src/models/vmBooking.model.js"));
        ({ VmSlot } = await import("../src/models/vmSlot.model.js"));
        ({ CallbackBucket } = await import("../src/models/callbackBucket.model.js"));
        ({ CallbackRequest } = await import("../src/models/callbackRequest.model.js"));
        ({ Holiday } = await import("../src/models/holiday.model.js"));
        ({ Settings } = await import("../src/models/settings.model.js"));

        const login = await request(getApp())
            .post(`${BASE}/auth/login`)
            .set("Origin", TEST_ORIGIN)
            .send({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD });
        assert.equal(login.status, 200);
        cookie = login.headers["set-cookie"][0].split(";")[0];
    });
    after(stopTestEnv);
    beforeEach(resetState);

    // ── C8: authentication ────────────────────────────────────────────────────

    describe("authentication", () => {
        const ENDPOINTS = [
            `/dashboard?date=${TUESDAY}`,
            "/dashboard",
            `/bookings?from=${MONDAY}&to=${WEDNESDAY}`,
            "/vm/calendar?month=2030-03",
            `/vm/availability?date=${TUESDAY}`,
            `/callback/availability?date=${TUESDAY}`,
            `/callback/requests?date=${TUESDAY}`,
            "/settings",
            "/holidays?year=2030",
        ];

        it("every endpoint is 401 ADMIN_UNAUTHORIZED without a session", async () => {
            for (const path of ENDPOINTS) {
                const res = await getWithoutSession(path);

                assert.equal(res.status, 401, path);
                assert.equal(res.body.success, false, path);
                assert.equal(res.body.code, "ADMIN_UNAUTHORIZED", path);
            }
        });

        it("every endpoint is 401 with an invalid session cookie", async () => {
            for (const path of ENDPOINTS) {
                const res = await request(getApp()).get(`${BASE}${path}`).set("Cookie", "oe_admin=not.a.token");

                assert.equal(res.status, 401, path);
                assert.equal(res.body.code, "ADMIN_UNAUTHORIZED", path);
            }
        });

        it("authentication is checked before the query, so a bad query without a session is still 401", async () => {
            const res = await getWithoutSession("/bookings?from=nope");

            assert.equal(res.status, 401);
        });

        it("every endpoint works with a session", async () => {
            for (const path of ENDPOINTS) {
                const res = await get(path);

                assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)}`);
                assert.equal(res.body.success, true, path);
            }
        });
    });

    // ── C1: dashboard ─────────────────────────────────────────────────────────

    describe("GET /admin/dashboard", () => {
        it("counts and timeline order for a seeded day", async () => {
            const { meetingAt10, meetingAt14, r1, r2, r3, r5 } = await seedBusyDay();

            const res = await get(`/dashboard?date=${TUESDAY}`);

            assert.equal(res.status, 200);
            const { date, counts, timeline } = res.body.data;
            assert.equal(date, TUESDAY);
            assert.deepEqual(counts, { meetings: 2, callbacks: 4, openVmSlots: 1, blockedVmSlots: 1 });

            // Sorted by time; at 12:00 the VM entry comes before the callback; callbacks of one
            // period keep arrival order.
            assert.deepEqual(
                timeline.map((entry) => [entry.time, entry.kind, entry.bookingId ?? entry.requestId ?? null]),
                [
                    ["09:00", "callback", r1.requestId],
                    ["09:00", "callback", r2.requestId],
                    ["10:00", "meeting", meetingAt10.bookingId],
                    ["12:00", "blocked", null],
                    ["12:00", "callback", r3.requestId],
                    ["14:00", "meeting", meetingAt14.bookingId],
                    ["15:00", "callback", r5.requestId],
                    ["16:00", "available", null],
                ]
            );
        });

        it("entries carry exactly the contract fields", async () => {
            await seedBusyDay();

            const { timeline } = (await get(`/dashboard?date=${TUESDAY}`)).body.data;
            const byKind = (kind) => timeline.filter((entry) => entry.kind === kind);

            assert.deepEqual(keysOf(byKind("meeting")[0]), [
                "bookingId", "email", "kind", "meetLink", "meetStatus", "mobileNumber",
                "name", "organisation", "time", "topic",
            ]);
            assert.deepEqual(keysOf(byKind("callback")[0]), [
                "email", "kind", "mobileNumber", "name", "period", "reason", "requestId", "status", "time",
            ]);
            assert.deepEqual(byKind("available")[0], { kind: "available", time: "16:00" });
            assert.deepEqual(byKind("blocked")[0], {
                kind: "blocked", time: "12:00", blockedBy: "Anita", blockReason: "Site visit",
            });

            const first = byKind("meeting")[0];
            assert.equal(first.name, "Rahul Kumar");
            assert.equal(first.organisation, "ABC Pvt Ltd");
            assert.equal(first.mobileNumber, "+919876543210");
            assert.equal(first.topic, "EIA for new unit");
            assert.equal(first.meetLink, "https://meet.google.com/abc-defg-hij");
            assert.equal(first.meetStatus, "created");

            const failed = byKind("meeting")[1];
            assert.equal(failed.meetStatus, "failed");
            assert.equal(failed.meetLink, null);
            assert.equal(failed.organisation, null, "a missing optional field is null, not absent");

            const callback = byKind("callback");
            assert.equal(callback[0].period, "morning");
            assert.equal(callback[0].reason, "Water testing quote");
            assert.equal(callback[0].status, "pending");
            assert.equal(callback[1].status, "completed");
            assert.equal(callback[1].reason, null);
            assert.equal(callback[3].status, "no_answer");
        });

        it("cancelled bookings and requests are left out", async () => {
            await seedBusyDay();

            const { timeline } = (await get(`/dashboard?date=${TUESDAY}`)).body.data;
            const text = JSON.stringify(timeline);

            assert.ok(!text.includes("Cancelled Person"));
            assert.ok(!text.includes("cancelled"));
            assert.equal(timeline.filter((entry) => entry.kind === "meeting").length, 2);
            // the cancelled 16:00 booking has no slot, so 16:00 reads as open
            assert.deepEqual(timeline.at(-1), { kind: "available", time: "16:00" });
        });

        it("an empty working day: four open slots, nothing else", async () => {
            const res = await get(`/dashboard?date=${WEDNESDAY}`);

            assert.deepEqual(res.body.data.counts, { meetings: 0, callbacks: 0, openVmSlots: 4, blockedVmSlots: 0 });
            assert.deepEqual(
                res.body.data.timeline,
                ["10:00", "12:00", "14:00", "16:00"].map((time) => ({ kind: "available", time }))
            );
        });

        it("a day VM does not run (Sunday, holiday) lists no open slots but still shows what exists", async () => {
            const sunday = await get(`/dashboard?date=${SUNDAY}`);
            assert.deepEqual(sunday.body.data.counts, { meetings: 0, callbacks: 0, openVmSlots: 0, blockedVmSlots: 0 });
            assert.deepEqual(sunday.body.data.timeline, []);

            await Holiday.create({ date: HOLIDAY, name: "Holi" });
            await addBooking(HOLIDAY, "10:00");
            await addRequest(HOLIDAY, "afternoon");
            const holiday = await get(`/dashboard?date=${HOLIDAY}`);
            assert.deepEqual(holiday.body.data.counts, { meetings: 1, callbacks: 1, openVmSlots: 0, blockedVmSlots: 0 });
            assert.deepEqual(holiday.body.data.timeline.map((e) => e.kind), ["meeting", "callback"]);
        });

        it("the date defaults to today in IST", async () => {
            const res = await get("/dashboard");

            assert.equal(res.body.data.date, nowIST().dateKey);
        });

        it("a malformed or impossible date is 400 VALIDATION_FAILED", async () => {
            for (const date of ["2030-02-30", "12-03-2030", "tomorrow", ""]) {
                const res = await get(`/dashboard?date=${date}`);

                assert.equal(res.status, 400, date);
                assert.equal(res.body.code, "VALIDATION_FAILED", date);
                assert.ok(res.body.errors.date, date);
            }
        });
    });

    // ── C2: bookings ──────────────────────────────────────────────────────────

    describe("GET /admin/bookings", () => {
        const seed = async () => {
            const vmEarly = await addBooking(MONDAY, "10:00", { name: "Early Meeting" });
            const vmLate = await addBooking(TUESDAY, "14:00", { name: "Late Meeting" });
            const vmMid = await addBooking(TUESDAY, "10:00", { name: "Mid Meeting" });
            const vmCancelled = await addBooking(WEDNESDAY, "12:00", { name: "Cancelled Meeting", status: "cancelled" });

            const cbEvening = await addRequest(TUESDAY, "evening", { name: "Evening Caller" });
            const cbMorning = await addRequest(TUESDAY, "morning", { name: "Morning Caller" });
            const cbAfternoon = await addRequest(TUESDAY, "afternoon", { name: "Afternoon Caller" });
            const cbMonday = await addRequest(MONDAY, "evening", { name: "Monday Caller" });
            const cbCancelled = await addRequest(TUESDAY, "morning", { name: "Cancelled Caller", status: "cancelled" });

            return { vmEarly, vmLate, vmMid, vmCancelled, cbEvening, cbMorning, cbAfternoon, cbMonday, cbCancelled };
        };
        const query = (extra = "") => get(`/bookings?from=${MONDAY}&to=${WEDNESDAY}${extra}`);

        it("returns both lists sorted by date then time / period (not alphabetically)", async () => {
            const s = await seed();

            const res = await query();

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data.vmBookings.map((b) => b.bookingId), [
                s.vmEarly.bookingId, s.vmMid.bookingId, s.vmLate.bookingId,
            ]);
            // Monday's evening call first (date), then Tuesday morning, afternoon, evening (period order).
            assert.deepEqual(res.body.data.callbackRequests.map((r) => r.requestId), [
                s.cbMonday.requestId, s.cbMorning.requestId, s.cbAfternoon.requestId, s.cbEvening.requestId,
            ]);
        });

        it("leaves out cancelled items unless includeCancelled=true", async () => {
            const s = await seed();

            const without = (await query("&includeCancelled=false")).body.data;
            assert.equal(without.vmBookings.length, 3);
            assert.equal(without.callbackRequests.length, 4);

            const withCancelled = (await query("&includeCancelled=true")).body.data;
            assert.deepEqual(withCancelled.vmBookings.map((b) => b.bookingId), [
                s.vmEarly.bookingId, s.vmMid.bookingId, s.vmLate.bookingId, s.vmCancelled.bookingId,
            ]);
            assert.equal(withCancelled.callbackRequests.length, 5);
            assert.ok(withCancelled.callbackRequests.some((r) => r.status === "cancelled"));
        });

        it("type=vm and type=callback return only that list (the other is empty)", async () => {
            await seed();

            const vm = (await query("&type=vm")).body.data;
            assert.equal(vm.vmBookings.length, 3);
            assert.deepEqual(vm.callbackRequests, []);

            const callback = (await query("&type=callback")).body.data;
            assert.deepEqual(callback.vmBookings, []);
            assert.equal(callback.callbackRequests.length, 4);

            const all = (await query("&type=all")).body.data;
            assert.equal(all.vmBookings.length, 3);
            assert.equal(all.callbackRequests.length, 4);
        });

        it("only dates inside from..to (inclusive)", async () => {
            await seed();

            const oneDay = (await get(`/bookings?from=${TUESDAY}&to=${TUESDAY}`)).body.data;
            assert.equal(oneDay.vmBookings.length, 2);
            assert.ok(oneDay.vmBookings.every((b) => b.date === TUESDAY));
            assert.ok(oneDay.callbackRequests.every((r) => r.date === TUESDAY));
        });

        it("returns every stored field except expireAt and googleEventId", async () => {
            await seed();

            const { vmBookings, callbackRequests } = (await query()).body.data;
            const booking = vmBookings[0];

            assert.ok(!("expireAt" in booking));
            assert.ok(!("googleEventId" in booking));
            assert.ok(!("_id" in booking) && !("__v" in booking));
            for (const key of [
                "bookingId", "date", "time", "name", "email", "mobileNumber", "organisation", "designation",
                "topic", "status", "meetStatus", "meetLink", "createdAt", "updatedAt",
            ]) {
                assert.ok(key in booking, `vm booking has ${key}`);
            }
            assert.ok(!JSON.stringify(vmBookings).includes("google-event-secret-id"));

            const callback = callbackRequests[0];
            assert.ok(!("expireAt" in callback));
            for (const key of ["requestId", "date", "period", "name", "email", "mobileNumber", "reason", "status", "createdAt"]) {
                assert.ok(key in callback, `callback request has ${key}`);
            }
        });

        it("cancel details are included for cancelled bookings", async () => {
            await addBooking(TUESDAY, "10:00", { status: "cancelled", cancelledBy: "Anita", cancelReason: "Client asked" });

            const { vmBookings } = (await query("&includeCancelled=true")).body.data;

            assert.equal(vmBookings[0].cancelledBy, "Anita");
            assert.equal(vmBookings[0].cancelReason, "Client asked");
        });

        it("range limit: 62 dates are allowed, 63 are 400", async () => {
            const from = "2030-01-01";

            const exactly62 = await get(`/bookings?from=${from}&to=${addDays(from, 61)}`);
            assert.equal(exactly62.status, 200);

            const tooMany = await get(`/bookings?from=${from}&to=${addDays(from, 62)}`);
            assert.equal(tooMany.status, 400);
            assert.equal(tooMany.body.code, "VALIDATION_FAILED");
            assert.match(tooMany.body.errors.to[0], /62/);
        });

        it("rejects to before from, a missing or malformed date, an unknown type and a bad flag", async () => {
            const cases = [
                [`/bookings?from=${TUESDAY}&to=${MONDAY}`, "to"],
                [`/bookings?to=${TUESDAY}`, "from"],
                [`/bookings?from=${TUESDAY}`, "to"],
                ["/bookings?from=2030-02-30&to=2030-03-01", "from"],
                [`/bookings?from=${MONDAY}&to=${TUESDAY}&type=everything`, "type"],
                [`/bookings?from=${MONDAY}&to=${TUESDAY}&includeCancelled=yes`, "includeCancelled"],
            ];

            for (const [path, field] of cases) {
                const res = await get(path);

                assert.equal(res.status, 400, path);
                assert.equal(res.body.code, "VALIDATION_FAILED", path);
                assert.ok(res.body.errors[field], `${path} -> ${field}`);
            }
        });

        it("an empty range is two empty lists", async () => {
            const res = await get("/bookings?from=2031-06-01&to=2031-06-07");

            assert.deepEqual(res.body.data, { vmBookings: [], callbackRequests: [] });
        });
    });

    // ── C3: VM calendar ───────────────────────────────────────────────────────

    describe("GET /admin/vm/calendar", () => {
        it("one entry per day of the month with working, holidayName and the slot counts", async () => {
            await addBooking(TUESDAY, "10:00");
            await addBooking(TUESDAY, "14:00");
            await addBlock(TUESDAY, "12:00");
            await addBlock(WEDNESDAY, "16:00");
            await Holiday.create({ date: HOLIDAY, name: "Holi" });
            await addBooking(HOLIDAY, "10:00");   // booked before it became a holiday

            const res = await get("/vm/calendar?month=2030-03");

            assert.equal(res.status, 200);
            assert.equal(res.body.data.month, "2030-03");
            const { days } = res.body.data;
            assert.equal(days.length, 31);
            assert.equal(days[0].date, "2030-03-01");
            assert.equal(days[30].date, "2030-03-31");
            assert.deepEqual(keysOf(days[0]), ["available", "blocked", "booked", "date", "holidayName", "working"]);

            const day = (date) => days.find((d) => d.date === date);
            assert.deepEqual(day(TUESDAY), {
                date: TUESDAY, working: true, holidayName: null, booked: 2, blocked: 1, available: 1,
            });
            assert.deepEqual(day(WEDNESDAY), {
                date: WEDNESDAY, working: true, holidayName: null, booked: 0, blocked: 1, available: 3,
            });
            assert.deepEqual(day(MONDAY), {
                date: MONDAY, working: true, holidayName: null, booked: 0, blocked: 0, available: 4,
            });
            assert.deepEqual(day(HOLIDAY), {
                date: HOLIDAY, working: false, holidayName: "Holi", booked: 1, blocked: 0, available: 0,
            });
        });

        it("Sunday and the 2nd Saturday do not run VM; the other Saturdays do", async () => {
            const { days } = (await get("/vm/calendar?month=2030-03")).body.data;

            for (const date of [SUNDAY, SECOND_SATURDAY]) {
                const entry = days.find((d) => d.date === date);
                assert.equal(entry.working, false, date);
                assert.equal(entry.available, 0, date);
            }

            const first = days.find((d) => d.date === FIRST_SATURDAY);
            assert.equal(first.working, true);
            assert.equal(first.available, 4);
        });

        it("covers past and far future months and month lengths", async () => {
            assert.equal((await get("/vm/calendar?month=2030-02")).body.data.days.length, 28);
            assert.equal((await get("/vm/calendar?month=2028-02")).body.data.days.length, 29);
            assert.equal((await get("/vm/calendar?month=2020-04")).body.data.days.length, 30);
        });

        it("a malformed month is 400", async () => {
            for (const month of ["2030-13", "2030-00", "2030-3", "2030", "March", "", "2030-03-01"]) {
                const res = await get(`/vm/calendar?month=${month}`);

                assert.equal(res.status, 400, month);
                assert.ok(res.body.errors.month, month);
            }
            assert.equal((await get("/vm/calendar")).status, 400);
        });
    });

    // ── C4: VM availability ───────────────────────────────────────────────────

    describe("GET /admin/vm/availability", () => {
        it("every slot with its status, the full booking when booked and the block details when blocked", async () => {
            const booking = await addBooking(TUESDAY, "10:00", { name: "Rahul Kumar" });
            await addBlock(TUESDAY, "12:00", "Anita", "Site visit");
            await addBooking(TUESDAY, "14:00", { status: "cancelled" });   // cancelled: slot is free

            const res = await get(`/vm/availability?date=${TUESDAY}`);

            assert.equal(res.status, 200);
            const { date, working, holidayName, slots } = res.body.data;
            assert.equal(date, TUESDAY);
            assert.equal(working, true);
            assert.equal(holidayName, null);
            assert.deepEqual(slots.map((s) => [s.time, s.status]), [
                ["10:00", "booked"], ["12:00", "blocked"], ["14:00", "available"], ["16:00", "available"],
            ]);
            slots.forEach((slot) => assert.deepEqual(keysOf(slot), ["block", "booking", "status", "time"]));

            const booked = slots[0];
            assert.equal(booked.block, null);
            assert.equal(booked.booking.bookingId, booking.bookingId);
            assert.equal(booked.booking.name, "Rahul Kumar");
            assert.equal(booked.booking.email, booking.email);
            assert.equal(booked.booking.mobileNumber, "+919876543210");
            assert.equal(booked.booking.organisation, "ABC Pvt Ltd");
            assert.equal(booked.booking.designation, "Plant Head");
            assert.equal(booked.booking.topic, "EIA for new unit");
            assert.equal(booked.booking.meetLink, "https://meet.google.com/abc-defg-hij");
            assert.equal(booked.booking.status, "confirmed");
            assert.ok(!("expireAt" in booked.booking) && !("googleEventId" in booked.booking));

            const blocked = slots[1];
            assert.equal(blocked.booking, null);
            assert.deepEqual(blocked.block, {
                blockedBy: "Anita", blockReason: "Site visit", blockedAt: "2030-03-01T08:00:00.000Z",
            });

            assert.deepEqual(slots[2], { time: "14:00", status: "available", booking: null, block: null });
        });

        it("a holiday is working: false with its name; Sundays are working: false", async () => {
            await Holiday.create({ date: HOLIDAY, name: "Holi" });

            const holiday = (await get(`/vm/availability?date=${HOLIDAY}`)).body.data;
            assert.equal(holiday.working, false);
            assert.equal(holiday.holidayName, "Holi");
            assert.equal(holiday.slots.length, 4);

            const sunday = (await get(`/vm/availability?date=${SUNDAY}`)).body.data;
            assert.equal(sunday.working, false);
            assert.equal(sunday.holidayName, null);
        });

        it("shows past dates (admins look back at what happened)", async () => {
            await addBooking("2020-01-07", "10:00");

            const res = await get("/vm/availability?date=2020-01-07");

            assert.equal(res.status, 200);
            assert.equal(res.body.data.slots[0].status, "booked");
        });

        it("a slot document with no booking behind it is reported as blocked (it cannot be booked)", async () => {
            await VmSlot.create({
                date: TUESDAY, time: "10:00", state: "booked", bookingId: "OE-VM-300312-ZZZZ", expireAt: expireAtFor(TUESDAY),
            });

            const slot = (await get(`/vm/availability?date=${TUESDAY}`)).body.data.slots[0];

            assert.equal(slot.status, "blocked");
            assert.equal(slot.booking, null);
            assert.deepEqual(slot.block, { blockedBy: null, blockReason: null, blockedAt: null });
        });

        it("a bad or missing date is 400", async () => {
            for (const path of ["/vm/availability", "/vm/availability?date=2030-02-30", "/vm/availability?date=soon"]) {
                const res = await get(path);

                assert.equal(res.status, 400, path);
                assert.ok(res.body.errors.date, path);
            }
        });
    });

    // ── C5: callback availability and requests ────────────────────────────────

    describe("GET /admin/callback/availability", () => {
        it("every period with capacity, booked, blocked and the block details", async () => {
            await Settings.create({ key: "main", callbackCapacity: { morning: 4, afternoon: 6, evening: 2 } });
            await CallbackBucket.create({ date: TUESDAY, period: "morning", booked: 2, expireAt: expireAtFor(TUESDAY) });
            await CallbackBucket.create({
                date: TUESDAY, period: "afternoon", booked: 1, blocked: true,
                blockedBy: "Rohan", blockReason: "Team meeting", blockedAt: new Date("2030-03-02T10:00:00Z"),
                expireAt: expireAtFor(TUESDAY),
            });

            const res = await get(`/callback/availability?date=${TUESDAY}`);

            assert.equal(res.status, 200);
            const { date, working, holidayName, periods } = res.body.data;
            assert.equal(date, TUESDAY);
            assert.equal(working, true);
            assert.equal(holidayName, null);
            assert.deepEqual(periods, [
                { key: "morning", label: "Morning", timeRange: "9 AM – 12 PM", capacity: 4, booked: 2, blocked: false, block: null },
                {
                    key: "afternoon", label: "Afternoon", timeRange: "12 PM – 3 PM", capacity: 6, booked: 1, blocked: true,
                    block: { blockedBy: "Rohan", blockReason: "Team meeting", blockedAt: "2030-03-02T10:00:00.000Z" },
                },
                { key: "evening", label: "Evening", timeRange: "3 PM – 6 PM", capacity: 2, booked: 0, blocked: false, block: null },
            ]);
        });

        it("uses the default capacity when there are no saved settings", async () => {
            const { periods } = (await get(`/callback/availability?date=${TUESDAY}`)).body.data;

            assert.deepEqual(periods.map((p) => p.capacity), [5, 5, 3]);
            assert.deepEqual(periods.map((p) => p.booked), [0, 0, 0]);
        });

        it("working follows the callback rules: Saturdays run, second Saturday and Sunday do not", async () => {
            const working = async (date) => (await get(`/callback/availability?date=${date}`)).body.data.working;

            assert.equal(await working(FIRST_SATURDAY), true);
            assert.equal(await working(SECOND_SATURDAY), false);
            assert.equal(await working(SUNDAY), false);
            assert.equal(await working(TUESDAY), true);

            await Holiday.create({ date: HOLIDAY, name: "Holi" });
            const holiday = (await get(`/callback/availability?date=${HOLIDAY}`)).body.data;
            assert.equal(holiday.working, false);
            assert.equal(holiday.holidayName, "Holi");
        });

        it("a bad or missing date is 400", async () => {
            assert.equal((await get("/callback/availability")).status, 400);
            assert.equal((await get("/callback/availability?date=2030-13-01")).status, 400);
        });
    });

    describe("GET /admin/callback/requests", () => {
        it("lists the non-cancelled requests of a date in period then arrival order", async () => {
            const { r1, r2, r3, r5 } = await seedBusyDay();
            await addRequest(WEDNESDAY, "morning", { name: "Other Day" });

            const res = await get(`/callback/requests?date=${TUESDAY}`);

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data.requests.map((r) => r.requestId), [
                r1.requestId, r2.requestId, r3.requestId, r5.requestId,
            ]);
            assert.ok(res.body.data.requests.every((r) => r.status !== "cancelled"));
        });

        it("period filters to one period", async () => {
            const { r1, r2, r5 } = await seedBusyDay();

            const morning = (await get(`/callback/requests?date=${TUESDAY}&period=morning`)).body.data.requests;
            assert.deepEqual(morning.map((r) => r.requestId), [r1.requestId, r2.requestId]);

            const evening = (await get(`/callback/requests?date=${TUESDAY}&period=evening`)).body.data.requests;
            assert.deepEqual(evening.map((r) => r.requestId), [r5.requestId], "the cancelled evening request is excluded");
        });

        it("returns the stored fields without expireAt", async () => {
            await seedBusyDay();

            const [request1] = (await get(`/callback/requests?date=${TUESDAY}`)).body.data.requests;

            assert.ok(!("expireAt" in request1) && !("_id" in request1) && !("__v" in request1));
            assert.equal(request1.name, "John Doe");
            assert.equal(request1.email.endsWith("@example.com"), true);
            assert.equal(request1.mobileNumber, "+917654321098");
            assert.equal(request1.reason, "Water testing quote");
            assert.equal(request1.status, "pending");
            assert.ok(request1.createdAt);
        });

        it("a date with none is an empty list", async () => {
            const res = await get(`/callback/requests?date=${WEDNESDAY}`);

            assert.deepEqual(res.body.data, { requests: [] });
        });

        it("a bad period or a bad / missing date is 400", async () => {
            const bad = await get(`/callback/requests?date=${TUESDAY}&period=night`);
            assert.equal(bad.status, 400);
            assert.ok(bad.body.errors.period);

            assert.equal((await get("/callback/requests")).status, 400);
            assert.equal((await get("/callback/requests?date=31-12-2030")).status, 400);
        });
    });

    // ── C6: settings and holidays ─────────────────────────────────────────────

    describe("GET /admin/settings", () => {
        it("returns the default capacity when nothing is saved", async () => {
            const res = await get("/settings");

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { callbackCapacity: { morning: 5, afternoon: 5, evening: 3 } });
        });

        it("returns the saved capacity", async () => {
            await Settings.create({ key: "main", callbackCapacity: { morning: 8, afternoon: 0, evening: 12 } });

            const res = await get("/settings");

            assert.deepEqual(res.body.data, { callbackCapacity: { morning: 8, afternoon: 0, evening: 12 } });
        });
    });

    describe("GET /admin/holidays", () => {
        it("returns that year's holidays sorted by date, and no other year's", async () => {
            await Holiday.create({ date: "2030-08-15", name: "Independence Day" });
            await Holiday.create({ date: "2029-12-25", name: "Christmas" });
            await Holiday.create({ date: "2030-01-26", name: "Republic Day" });
            await Holiday.create({ date: "2031-01-01", name: "New Year" });
            await Holiday.create({ date: "2030-12-31", name: "Year End" });

            const res = await get("/holidays?year=2030");

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data.holidays, [
                { date: "2030-01-26", name: "Republic Day" },
                { date: "2030-08-15", name: "Independence Day" },
                { date: "2030-12-31", name: "Year End" },
            ]);
        });

        it("a year with none is an empty list", async () => {
            assert.deepEqual((await get("/holidays?year=2040")).body.data, { holidays: [] });
        });

        it("a malformed or missing year is 400", async () => {
            for (const year of ["30", "20300", "abcd", "2030-01", ""]) {
                const res = await get(`/holidays?year=${year}`);

                assert.equal(res.status, 400, year);
                assert.ok(res.body.errors.year, year);
            }
            assert.equal((await get("/holidays")).status, 400);
        });
    });

    // ── C7: scripts/seed-demo.js ──────────────────────────────────────────────

    describe("scripts/seed-demo.js (npm run seed:demo)", () => {
        const script = fileURLToPath(new URL("../scripts/seed-demo.js", import.meta.url));
        const seedDb = () => mongoose.connection.client.db(DB_NAME);

        const run = (nodeEnv) =>
            spawnSync(process.execPath, [script], {
                encoding: "utf8",
                cwd: os.tmpdir(),   // so dotenv cannot read the real .env
                timeout: 120000,
                env: {
                    PATH: process.env.PATH,
                    SystemRoot: process.env.SystemRoot,
                    ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
                    EMAIL_MODE: "smtp",   // the script must override this: nothing may be sent
                    MONGODB_URI: process.env.MONGODB_URI,
                    CORS_ORIGINS: TEST_ORIGIN,
                    MAIL_FROM: "a@b.c",
                    COMPANY_MAIL: "d@e.f",
                    OTP_SECRET: TEST_OTP_SECRET,
                    BOOKING_TOKEN_SECRET: TEST_BOOKING_TOKEN_SECRET,
                    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
                    DATA_GOV_API_KEY: "test-data-gov-api-key",
                    CLOUDINARY_CLOUD_NAME: "test-cloud",
                    CLOUDINARY_API_KEY: "test-cloudinary-key",
                    CLOUDINARY_API_SECRET: "test-cloudinary-secret-0123456789",
                    // would make real calendar events if the script did not remove them
                    GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
                    GOOGLE_CLIENT_SECRET: "client-secret",
                    GOOGLE_REFRESH_TOKEN: "refresh-token",
                    ...TEST_ADMIN_ENV,
                },
            });

        const dump = async () => {
            const db = seedDb();
            const [vmBookings, vmSlots, requests, buckets] = await Promise.all([
                db.collection("vm_bookings").find().toArray(),
                db.collection("vm_slots").find().toArray(),
                db.collection("callback_requests").find().toArray(),
                db.collection("callback_buckets").find().toArray(),
            ]);
            return { vmBookings, vmSlots, requests, buckets };
        };

        beforeEach(async () => {
            await seedDb().dropDatabase();
        });

        it("refuses unless NODE_ENV=development, and touches nothing", async () => {
            for (const nodeEnv of ["production", "test", undefined]) {
                const result = run(nodeEnv);

                assert.equal(result.status, 1, `NODE_ENV=${nodeEnv}`);
                assert.match(result.stderr, /NODE_ENV=development/, `NODE_ENV=${nodeEnv}`);
                assert.match(result.stderr, /Nothing was changed/);
            }

            const { vmBookings, vmSlots, requests, buckets } = await dump();
            assert.equal(vmBookings.length + vmSlots.length + requests.length + buckets.length, 0);
        });

        it("creates bookings, blocks and requests over the next 7 working days with example.com emails only", async () => {
            const result = run("development");

            assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
            const { vmBookings, vmSlots, requests, buckets } = await dump();

            assert.ok(vmBookings.length >= 8, `vm bookings: ${vmBookings.length}`);
            assert.ok(requests.length >= 10, `callback requests: ${requests.length}`);
            assert.ok(vmSlots.some((slot) => slot.state === "blocked"), "VM blocks");
            assert.ok(buckets.some((bucket) => bucket.blocked), "callback blocks");

            // example.com only
            for (const row of [...vmBookings, ...requests]) {
                assert.match(row.email, /@example\.com$/, row.email);
            }

            // within the next 7 working days, never today or earlier
            const today = nowIST().dateKey;
            const dates = new Set([...vmBookings, ...requests, ...vmSlots, ...buckets].map((row) => row.date));
            assert.ok(dates.size <= 7, `dates: ${[...dates].join(",")}`);
            assert.ok([...dates].every((date) => date > today && date <= addDays(today, 21)));

            // created through the services: ids, pending state, and counters that match the requests
            assert.ok(vmBookings.every((b) => /^OE-VM-\d{6}-[A-Z0-9]{4}$/.test(b.bookingId) && b.status === "confirmed"));
            assert.ok(requests.every((r) => /^OE-CB-\d{6}-[A-Z0-9]{4}$/.test(r.requestId) && r.status === "pending"));
            for (const bucket of buckets) {
                const taken = requests.filter((r) => r.date === bucket.date && r.period === bucket.period).length;
                assert.equal(bucket.booked, taken, `${bucket.date} ${bucket.period}`);
            }
            // every booked slot belongs to a booking
            for (const slot of vmSlots.filter((s) => s.state === "booked")) {
                assert.ok(vmBookings.some((b) => b.bookingId === slot.bookingId), slot.bookingId);
            }

            // no real email, no Google event: the credentials passed in were removed, so Meet
            // reported "not configured" for every booking instead of calling Google
            assert.ok(vmBookings.every((b) => b.googleEventId == null), "no Google event was created");
            assert.match(result.stdout + result.stderr, /MeetNotConfiguredError/);
            assert.match(result.stdout + result.stderr, /No email was sent/);
        });

        it("is safe to run again: nothing is duplicated", async () => {
            assert.equal(run("development").status, 0);
            const first = await dump();

            const second = run("development");
            assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
            const after = await dump();

            assert.equal(after.vmBookings.length, first.vmBookings.length);
            assert.equal(after.requests.length, first.requests.length);
            assert.equal(after.vmSlots.length, first.vmSlots.length);
            assert.equal(after.buckets.length, first.buckets.length);
            assert.deepEqual(
                after.buckets.map((b) => [b.date, b.period, b.booked]).sort(),
                first.buckets.map((b) => [b.date, b.period, b.booked]).sort()
            );
        });
    });
});
