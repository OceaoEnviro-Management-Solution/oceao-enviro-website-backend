import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { startTestEnv, stopTestEnv, resetState, getApp } from "./helpers/setup.js";

const CALENDAR = "/api/v1/vm/calendar";
const AVAILABILITY = "/api/v1/vm/availability";

let VmSlot;
let Holiday;

// IST wall-clock times written as the UTC instants the server sees (IST = UTC+05:30).
const WED_1030_IST = "2026-10-14T05:00:00Z";   // Wed 14 Oct 2026, 10:30 IST

const freezeTime = (iso) => mock.timers.enable({ apis: ["Date"], now: new Date(iso) });

const expireAt = new Date("2099-01-01T00:00:00Z");
const occupy = (date, time, state = "booked") =>
    VmSlot.create({
        date, time, state, expireAt,
        ...(state === "booked"
            ? { bookingId: "OE-VM-261016-K7Q2" }
            : { blockedBy: "Anita", blockReason: "Site visit", blockedAt: new Date() }),
    });

const calendar = (from, to) => request(getApp()).get(CALENDAR).query({ from, to });
const availability = (date) => request(getApp()).get(AVAILABILITY).query({ date });
const day = (res, date) => res.body.data.days.find((d) => d.date === date);

describe("VM availability endpoints", () => {
    before(async () => {
        await startTestEnv();
        ({ VmSlot } = await import("../src/models/vmSlot.model.js"));
        ({ Holiday } = await import("../src/models/holiday.model.js"));
    });
    after(stopTestEnv);
    beforeEach(resetState);
    afterEach(() => mock.timers.reset());

    describe("GET /vm/calendar", () => {
        it("returns one entry per date with reason codes for weekends and holidays", async () => {
            freezeTime(WED_1030_IST);
            await Holiday.create({ date: "2026-10-20", name: "Test holiday" });

            const res = await calendar("2026-10-14", "2026-10-20");

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.deepEqual(res.body.data.days.map((d) => d.date), [
                "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20",
            ]);
            assert.deepEqual(day(res, "2026-10-17"), { date: "2026-10-17", bookable: false, reason: "non_working_day", availableCount: 0 });
            assert.deepEqual(day(res, "2026-10-18"), { date: "2026-10-18", bookable: false, reason: "non_working_day", availableCount: 0 });
            assert.deepEqual(day(res, "2026-10-20"), { date: "2026-10-20", bookable: false, reason: "holiday", availableCount: 0 });
            assert.deepEqual(day(res, "2026-10-15"), { date: "2026-10-15", bookable: true, reason: null, availableCount: 4 });
            assert.deepEqual(day(res, "2026-10-19"), { date: "2026-10-19", bookable: true, reason: null, availableCount: 4 });
        });

        it("counts booked and blocked slots as unavailable, without revealing which", async () => {
            freezeTime(WED_1030_IST);
            await occupy("2026-10-16", "10:00", "booked");
            await occupy("2026-10-16", "12:00", "blocked");

            const res = await calendar("2026-10-16", "2026-10-16");

            assert.deepEqual(day(res, "2026-10-16"), { date: "2026-10-16", bookable: true, reason: null, availableCount: 2 });
            const raw = JSON.stringify(res.body);
            assert.doesNotMatch(raw, /blocked|Anita|Site visit|OE-VM|bookingId/i);
        });

        it("applies the lead time to today only", async () => {
            freezeTime(WED_1030_IST);   // 10:30 IST: 10:00 started, 12:00 is 90 min away

            const res = await calendar("2026-10-14", "2026-10-15");

            assert.equal(day(res, "2026-10-14").availableCount, 2, "today: only 14:00 and 16:00 are far enough away");
            assert.equal(day(res, "2026-10-15").availableCount, 4, "tomorrow: all four slots");
        });

        it("a working day with no free slot is bookable:false with reason 'full'", async () => {
            freezeTime(WED_1030_IST);
            await occupy("2026-10-16", "10:00", "booked");
            await occupy("2026-10-16", "12:00", "blocked");
            await occupy("2026-10-16", "14:00", "booked");
            await occupy("2026-10-16", "16:00", "blocked");

            const res = await calendar("2026-10-15", "2026-10-17");

            assert.deepEqual(day(res, "2026-10-16"), { date: "2026-10-16", bookable: false, reason: "full", availableCount: 0 });
            assert.equal(day(res, "2026-10-15").bookable, true, "neighbouring days are unaffected");
        });

        it("reports today as full when every remaining slot is inside the lead window", async () => {
            freezeTime("2026-10-14T10:30:00Z");   // 16:00 IST: the 16:00 slot has started, none left

            const res = await calendar("2026-10-14", "2026-10-14");

            assert.deepEqual(day(res, "2026-10-14"), { date: "2026-10-14", bookable: false, reason: "full", availableCount: 0 });
        });

        it("reports past dates and dates beyond the 30 day horizon", async () => {
            freezeTime("2026-10-12T05:00:00Z");   // Mon 12 Oct; horizon ends Wed 11 Nov

            const res = await calendar("2026-10-09", "2026-11-12");

            assert.equal(day(res, "2026-10-09").reason, "past");
            assert.equal(day(res, "2026-10-11").reason, "past");
            assert.equal(day(res, "2026-10-12").bookable, true);
            assert.equal(day(res, "2026-11-11").bookable, true, "today + 30 is open");
            assert.equal(day(res, "2026-11-12").reason, "beyond_horizon", "today + 31 is closed");
        });

        it("uses one vm_slots query and one holidays query for a 62 day range", async () => {
            freezeTime("2026-10-01T05:00:00Z");
            const slotFind = mock.method(VmSlot, "find");
            const holidayFind = mock.method(Holiday, "find");
            const holidayExists = mock.method(Holiday, "exists");
            try {
                const res = await calendar("2026-10-01", "2026-12-01");   // exactly 62 dates

                assert.equal(res.status, 200);
                assert.equal(res.body.data.days.length, 62);
                assert.equal(slotFind.mock.callCount(), 1, "one vm_slots query");
                assert.equal(holidayFind.mock.callCount(), 1, "one holidays query");
                assert.equal(holidayExists.mock.callCount(), 0, "no per-date holiday lookups");
            } finally {
                slotFind.mock.restore();
                holidayFind.mock.restore();
                holidayExists.mock.restore();
            }
        });

        it("ignores slot documents outside the requested range", async () => {
            freezeTime(WED_1030_IST);
            await occupy("2026-10-22", "10:00", "booked");

            const res = await calendar("2026-10-15", "2026-10-16");

            assert.equal(day(res, "2026-10-15").availableCount, 4);
            assert.equal(day(res, "2026-10-16").availableCount, 4);
        });

        it("accepts a single-day range and exactly 62 dates", async () => {
            freezeTime("2026-10-01T05:00:00Z");

            assert.equal((await calendar("2026-10-15", "2026-10-15")).body.data.days.length, 1);
            assert.equal((await calendar("2026-10-01", "2026-12-01")).status, 200);
        });

        it("rejects a range of more than 62 days with 400 VALIDATION_FAILED", async () => {
            const res = await calendar("2026-10-01", "2026-12-02");   // 63 dates

            assert.equal(res.status, 400);
            assert.equal(res.body.success, false);
            assert.equal(res.body.code, "VALIDATION_FAILED");
            assert.ok(Array.isArray(res.body.errors.to));
            assert.match(res.body.errors.to[0], /62/);
        });

        it("rejects missing, malformed and reversed parameters", async () => {
            const cases = [
                [{}, ["from", "to"]],
                [{ from: "2026-10-01" }, ["to"]],
                [{ to: "2026-10-01" }, ["from"]],
                [{ from: "2026-02-30", to: "2026-03-05" }, ["from"]],
                [{ from: "15-10-2026", to: "2026-10-20" }, ["from"]],
                [{ from: "2026-10-20", to: "tomorrow" }, ["to"]],
                [{ from: "2026-10-20", to: "2026-10-19" }, ["to"]],
            ];
            for (const [query, fields] of cases) {
                const res = await request(getApp()).get(CALENDAR).query(query);

                assert.equal(res.status, 400, JSON.stringify(query));
                assert.equal(res.body.code, "VALIDATION_FAILED");
                for (const field of fields) {
                    assert.ok(Array.isArray(res.body.errors[field]), `${JSON.stringify(query)} -> errors.${field}`);
                }
            }
        });

        it("rejects repeated parameters", async () => {
            const res = await request(getApp()).get(`${CALENDAR}?from=2026-10-01&from=2026-10-02&to=2026-10-05`);

            assert.equal(res.status, 400);
            assert.equal(res.body.code, "VALIDATION_FAILED");
        });
    });

    describe("GET /vm/availability", () => {
        it("lists all four slots as available on a free working day", async () => {
            freezeTime(WED_1030_IST);

            const res = await availability("2026-10-15");

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, {
                date: "2026-10-15",
                bookable: true,
                reason: null,
                slots: [
                    { time: "10:00", status: "available" },
                    { time: "12:00", status: "available" },
                    { time: "14:00", status: "available" },
                    { time: "16:00", status: "available" },
                ],
            });
        });

        it("shows booked and blocked slots both as 'booked'", async () => {
            freezeTime(WED_1030_IST);
            await occupy("2026-10-16", "10:00", "booked");
            await occupy("2026-10-16", "12:00", "blocked");

            const res = await availability("2026-10-16");

            assert.deepEqual(res.body.data.slots, [
                { time: "10:00", status: "booked" },
                { time: "12:00", status: "booked" },
                { time: "14:00", status: "available" },
                { time: "16:00", status: "available" },
            ]);
            assert.doesNotMatch(JSON.stringify(res.body), /blocked|Anita|Site visit|OE-VM|bookingId/i);
        });

        it("shows slots inside the lead time as 'booked' (10:30 IST today)", async () => {
            freezeTime(WED_1030_IST);

            const res = await availability("2026-10-14");

            assert.deepEqual(res.body.data.slots, [
                { time: "10:00", status: "booked" },
                { time: "12:00", status: "booked" },
                { time: "14:00", status: "available" },
                { time: "16:00", status: "available" },
            ]);
        });

        it("opens a slot at exactly 120 minutes of lead and closes it one second later", async () => {
            freezeTime("2026-10-14T04:30:00Z");   // 10:00:00 IST: the 12:00 slot is exactly 120 min away
            let res = await availability("2026-10-14");
            assert.equal(res.body.data.slots.find((s) => s.time === "12:00").status, "available");
            mock.timers.reset();

            freezeTime("2026-10-14T04:30:01Z");   // 10:00:01 IST: 119 min 59 s away
            res = await availability("2026-10-14");
            assert.equal(res.body.data.slots.find((s) => s.time === "12:00").status, "booked");
        });

        it("returns slots: [] with the reason for weekends, holidays, past and far-future dates", async () => {
            freezeTime(WED_1030_IST);
            await Holiday.create({ date: "2026-10-20", name: "Test holiday" });

            const expectations = [
                ["2026-10-17", "non_working_day"],
                ["2026-10-18", "non_working_day"],
                ["2026-10-20", "holiday"],
                ["2026-10-13", "past"],
                ["2026-11-14", "beyond_horizon"],
            ];
            for (const [date, reason] of expectations) {
                const res = await availability(date);

                assert.equal(res.status, 200, date);
                assert.deepEqual(res.body.data, { date, bookable: false, reason, slots: [] }, date);
            }
        });

        it("a day with every slot taken is bookable:false 'full' with slots: [] (same as the calendar)", async () => {
            freezeTime(WED_1030_IST);
            for (const time of ["10:00", "12:00", "14:00", "16:00"]) {
                await occupy("2026-10-16", time, time === "12:00" || time === "16:00" ? "blocked" : "booked");
            }

            const res = await availability("2026-10-16");
            const cal = await calendar("2026-10-16", "2026-10-16");

            assert.deepEqual(res.body.data, { date: "2026-10-16", bookable: false, reason: "full", slots: [] });
            assert.equal(day(cal, "2026-10-16").reason, "full");
        });

        it("agrees with the calendar's availableCount", async () => {
            freezeTime(WED_1030_IST);
            await occupy("2026-10-15", "14:00", "booked");

            const res = await availability("2026-10-15");
            const cal = await calendar("2026-10-15", "2026-10-15");

            const freeSlots = res.body.data.slots.filter((s) => s.status === "available").length;
            assert.equal(freeSlots, 3);
            assert.equal(day(cal, "2026-10-15").availableCount, freeSlots);
        });

        it("rejects a missing or invalid date with 400 VALIDATION_FAILED", async () => {
            for (const query of [{}, { date: "" }, { date: "2026-02-30" }, { date: "15/10/2026" }, { date: "soon" }]) {
                const res = await request(getApp()).get(AVAILABILITY).query(query);

                assert.equal(res.status, 400, JSON.stringify(query));
                assert.equal(res.body.code, "VALIDATION_FAILED");
                assert.ok(Array.isArray(res.body.errors.date));
            }
        });

        it("needs no authentication", async () => {
            freezeTime(WED_1030_IST);

            const res = await request(getApp()).get(AVAILABILITY).query({ date: "2026-10-15" });

            assert.equal(res.status, 200);
        });
    });
});
