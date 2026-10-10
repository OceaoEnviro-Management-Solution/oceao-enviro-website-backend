import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startTestEnv, stopTestEnv, resetState } from "./helpers/setup.js";
import { BOOKING } from "../src/config/booking.js";
import {
    nowIST,
    isValidDateKey,
    addDays,
    dayOfWeek,
    istToDate,
    expireAtFor,
} from "../src/utils/time.js";

// Loaded after startTestEnv so config/env.js sees the test environment.
let getVmDayStatus;
let isVmSlotTimeOpen;
let getCallbackDayStatus;
let isCallbackPeriodOpen;
let Holiday;

// IST wall-clock -> the real instant, so test times read as IST.
const ist = (dateKey, time) => istToDate(dateKey, time);

describe("calendar rules", () => {
    before(async () => {
        await startTestEnv();
        ({ getVmDayStatus, isVmSlotTimeOpen, getCallbackDayStatus, isCallbackPeriodOpen } =
            await import("../src/services/calendar.service.js"));
        ({ Holiday } = await import("../src/models/holiday.model.js"));
        await Holiday.init();
    });
    after(stopTestEnv);
    beforeEach(resetState);

    describe("config", () => {
        it("BOOKING is deeply frozen and matches the documented rules", () => {
            assert.ok(Object.isFrozen(BOOKING));
            assert.ok(Object.isFrozen(BOOKING.vm));
            assert.ok(Object.isFrozen(BOOKING.vm.slotTimes));
            assert.ok(Object.isFrozen(BOOKING.callback.periods.morning));
            assert.throws(() => { "use strict"; BOOKING.vm.horizonDays = 99; }, TypeError);

            assert.equal(BOOKING.timezone, "Asia/Kolkata");
            assert.deepEqual(BOOKING.vm.workingDays, [1, 2, 3, 4, 5]);
            assert.deepEqual(BOOKING.vm.slotTimes, ["10:00", "12:00", "14:00", "16:00"]);
            assert.equal(BOOKING.vm.minLeadMinutes, 120);
            assert.deepEqual(BOOKING.callback.workingDays, [1, 2, 3, 4, 5, 6]);
            assert.deepEqual(BOOKING.callback.closedSaturdaysOfMonth, [2]);
            assert.deepEqual(BOOKING.callback.periodOrder, ["morning", "afternoon", "evening"]);
            assert.equal(BOOKING.callback.cutoffMinutesBeforeEnd, 60);
            assert.equal(BOOKING.retentionDays, 30);
        });
    });

    describe("time utilities", () => {
        it("isValidDateKey rejects impossible and malformed dates", () => {
            for (const good of ["2026-10-15", "2028-02-29", "2026-12-31"]) {
                assert.equal(isValidDateKey(good), true, good);
            }
            for (const bad of ["2026-02-30", "2026-02-29", "2026-13-01", "2026-00-10", "2026-10-00", "2026-10-32",
                "2026-1-5", "26-10-15", "2026/10/15", "", " 2026-10-15", "abc", null, undefined, 20261015, {}]) {
                assert.equal(isValidDateKey(bad), false, String(bad));
            }
        });

        it("addDays crosses month, year and leap-day boundaries", () => {
            assert.equal(addDays("2026-10-15", 30), "2026-11-14");
            assert.equal(addDays("2026-12-31", 1), "2027-01-01");
            assert.equal(addDays("2027-01-01", -1), "2026-12-31");
            assert.equal(addDays("2028-02-28", 1), "2028-02-29");
            assert.equal(addDays("2027-02-28", 1), "2027-03-01");
            assert.equal(addDays("2026-10-15", 0), "2026-10-15");
            assert.throws(() => addDays("2026-02-30", 1), RangeError);
        });

        it("dayOfWeek uses UTC so it never depends on the server timezone (0 = Sunday)", () => {
            assert.equal(dayOfWeek("2026-10-18"), 0);   // Sunday
            assert.equal(dayOfWeek("2026-10-15"), 4);   // Thursday
            assert.equal(dayOfWeek("2026-10-17"), 6);   // Saturday
            assert.equal(dayOfWeek("2000-01-01"), 6);
        });

        it("istToDate returns the real UTC instant (IST = UTC+05:30)", () => {
            assert.equal(ist("2026-10-15", "10:00").toISOString(), "2026-10-15T04:30:00.000Z");
            assert.equal(ist("2026-10-15", "00:00").toISOString(), "2026-10-14T18:30:00.000Z");
            assert.equal(ist("2026-10-15", "23:59").toISOString(), "2026-10-15T18:29:00.000Z");
            assert.throws(() => istToDate("2026-10-15", "25:00"), RangeError);
            assert.throws(() => istToDate("2026-10-15", "9:00"), RangeError);
        });

        it("expireAtFor is retentionDays after the end of that IST day", () => {
            // End of 15 Oct IST = 16 Oct 00:00 IST = 15 Oct 18:30 UTC; +30 days.
            assert.equal(expireAtFor("2026-10-15").toISOString(), "2026-11-14T18:30:00.000Z");
            assert.equal(expireAtFor("2026-12-15").toISOString(), "2027-01-14T18:30:00.000Z");
        });

        it("18:45 UTC on 14 Oct is already 15 Oct in IST", () => {
            const instant = new Date("2026-10-14T18:45:00Z");

            assert.deepEqual(nowIST(instant), { dateKey: "2026-10-15", minutes: 15 });   // 00:15 IST
        });

        it("nowIST reports minutes since IST midnight", () => {
            assert.deepEqual(nowIST(new Date("2026-10-15T04:30:00Z")), { dateKey: "2026-10-15", minutes: 600 });
            assert.deepEqual(nowIST(new Date("2026-10-14T18:29:59Z")), { dateKey: "2026-10-14", minutes: 1439 });
            assert.deepEqual(nowIST(new Date("2026-10-14T18:30:00Z")), { dateKey: "2026-10-15", minutes: 0 });
        });
    });

    describe("VM day status", () => {
        // Wed 14 Oct 2026, 10:30 IST
        const now = new Date("2026-10-14T05:00:00Z");

        it("closes Saturday and Sunday", async () => {
            assert.deepEqual(await getVmDayStatus("2026-10-17", now), { bookable: false, reason: "non_working_day" });
            assert.deepEqual(await getVmDayStatus("2026-10-18", now), { bookable: false, reason: "non_working_day" });
        });

        it("opens Monday to Friday", async () => {
            for (const date of ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"]) {
                assert.deepEqual(await getVmDayStatus(date, now), { bookable: true, reason: null }, date);
            }
        });

        it("closes a holiday", async () => {
            await Holiday.create({ date: "2026-10-20", name: "Test holiday" });

            assert.deepEqual(await getVmDayStatus("2026-10-20", now), { bookable: false, reason: "holiday" });
            assert.deepEqual(await getVmDayStatus("2026-10-21", now), { bookable: true, reason: null });
        });

        it("allows today and today+30, closes yesterday and today+31", async () => {
            const monday = new Date("2026-10-12T05:00:00Z");   // Mon 12 Oct; +30 = Wed 11 Nov, +31 = Thu 12 Nov

            assert.deepEqual(await getVmDayStatus("2026-10-11", monday), { bookable: false, reason: "past" });
            assert.deepEqual(await getVmDayStatus("2026-10-12", monday), { bookable: true, reason: null });
            assert.deepEqual(await getVmDayStatus("2026-11-11", monday), { bookable: true, reason: null });
            assert.deepEqual(await getVmDayStatus("2026-11-12", monday), { bookable: false, reason: "beyond_horizon" });
        });

        it("reports invalid dates", async () => {
            for (const bad of ["2026-02-30", "2026-13-01", "not-a-date", "", null, undefined, 20261015]) {
                assert.deepEqual(await getVmDayStatus(bad, now), { bookable: false, reason: "invalid_date" }, String(bad));
            }
        });

        it("uses the IST date, not the UTC date: 18:45 UTC on 14 Oct is 15 Oct", async () => {
            const lateUtc = new Date("2026-10-14T18:45:00Z");

            assert.deepEqual(await getVmDayStatus("2026-10-14", lateUtc), { bookable: false, reason: "past" });
            assert.deepEqual(await getVmDayStatus("2026-10-15", lateUtc), { bookable: true, reason: null });
        });
    });

    describe("VM slot lead time", () => {
        // 12:00 slot on Thu 15 Oct 2026
        it("is open with exactly 120 minutes of lead and closed with 119", () => {
            const exactly120 = ist("2026-10-15", "10:00");
            const minus119 = new Date(exactly120.getTime() + 60 * 1000);   // 10:01 -> 119 minutes to 12:00

            assert.equal(isVmSlotTimeOpen("2026-10-15", "12:00", exactly120), true);
            assert.equal(isVmSlotTimeOpen("2026-10-15", "12:00", minus119), false);
        });

        it("is closed for a slot that has started or is within the lead window", () => {
            const now = ist("2026-10-15", "10:30");

            assert.equal(isVmSlotTimeOpen("2026-10-15", "10:00", now), false);   // already started
            assert.equal(isVmSlotTimeOpen("2026-10-15", "12:00", now), false);   // 90 minutes away
            assert.equal(isVmSlotTimeOpen("2026-10-15", "14:00", now), true);
            assert.equal(isVmSlotTimeOpen("2026-10-15", "16:00", now), true);
        });

        it("measures lead across midnight", () => {
            const now = ist("2026-10-14", "23:00");

            assert.equal(isVmSlotTimeOpen("2026-10-15", "10:00", now), true);
            assert.equal(isVmSlotTimeOpen("2026-10-14", "16:00", now), false);
        });

        it("is closed for times that are not configured slots and for invalid dates", () => {
            const now = ist("2026-10-01", "09:00");

            for (const time of ["11:00", "12:30", "09:00", "18:00", "", null, undefined, "noon"]) {
                assert.equal(isVmSlotTimeOpen("2026-10-15", time, now), false, String(time));
            }
            assert.equal(isVmSlotTimeOpen("2026-02-30", "10:00", now), false);
            assert.equal(isVmSlotTimeOpen(undefined, "10:00", now), false);
        });
    });

    describe("callback day status", () => {
        it("keeps the 1st, 3rd and 4th Saturday open and closes the 2nd (October 2026)", async () => {
            const now = new Date("2026-10-01T05:00:00Z");   // Thu 1 Oct; horizon runs to Sat 31 Oct

            assert.deepEqual(await getCallbackDayStatus("2026-10-03", now), { bookable: true, reason: null });   // 1st
            assert.deepEqual(await getCallbackDayStatus("2026-10-10", now), { bookable: false, reason: "non_working_day" }); // 2nd
            assert.deepEqual(await getCallbackDayStatus("2026-10-17", now), { bookable: true, reason: null });   // 3rd
            assert.deepEqual(await getCallbackDayStatus("2026-10-24", now), { bookable: true, reason: null });   // 4th
            assert.deepEqual(await getCallbackDayStatus("2026-10-31", now), { bookable: true, reason: null });   // 5th
        });

        it("closes the 2nd Saturday in another month too (November 2026)", async () => {
            const now = new Date("2026-11-02T05:00:00Z");   // Mon 2 Nov

            assert.deepEqual(await getCallbackDayStatus("2026-11-07", now), { bookable: true, reason: null });   // 1st
            assert.deepEqual(await getCallbackDayStatus("2026-11-14", now), { bookable: false, reason: "non_working_day" }); // 2nd
            assert.deepEqual(await getCallbackDayStatus("2026-11-21", now), { bookable: true, reason: null });   // 3rd
            assert.deepEqual(await getCallbackDayStatus("2026-11-28", now), { bookable: true, reason: null });   // 4th
        });

        it("closes Sunday and opens Monday to Friday", async () => {
            const now = new Date("2026-10-14T05:00:00Z");

            assert.deepEqual(await getCallbackDayStatus("2026-10-18", now), { bookable: false, reason: "non_working_day" });
            assert.deepEqual(await getCallbackDayStatus("2026-10-19", now), { bookable: true, reason: null });
            assert.deepEqual(await getCallbackDayStatus("2026-10-16", now), { bookable: true, reason: null });
        });

        it("closes a holiday, also when it falls on an open Saturday", async () => {
            const now = new Date("2026-10-01T05:00:00Z");
            await Holiday.create([
                { date: "2026-10-20", name: "Weekday holiday" },
                { date: "2026-10-17", name: "Saturday holiday" },   // 3rd Saturday
            ]);

            assert.deepEqual(await getCallbackDayStatus("2026-10-20", now), { bookable: false, reason: "holiday" });
            assert.deepEqual(await getCallbackDayStatus("2026-10-17", now), { bookable: false, reason: "holiday" });
        });

        it("allows today+30 and closes today+31, and closes the past", async () => {
            const monday = new Date("2026-10-12T05:00:00Z");

            assert.deepEqual(await getCallbackDayStatus("2026-10-11", monday), { bookable: false, reason: "past" });
            assert.deepEqual(await getCallbackDayStatus("2026-11-11", monday), { bookable: true, reason: null });
            assert.deepEqual(await getCallbackDayStatus("2026-11-12", monday), { bookable: false, reason: "beyond_horizon" });
        });

        it("reports invalid dates", async () => {
            const now = new Date("2026-10-14T05:00:00Z");

            for (const bad of ["2026-02-30", "2026-00-01", "nope", "", null, undefined]) {
                assert.deepEqual(await getCallbackDayStatus(bad, now), { bookable: false, reason: "invalid_date" }, String(bad));
            }
        });
    });

    describe("callback period cutoff", () => {
        const date = "2026-10-15";

        // Each period closes cutoffMinutesBeforeEnd (60) before it ends: 11:00, 14:00, 17:00.
        const cases = [
            { period: "morning", closesAt: "11:00", before: "10:59", } ,
            { period: "afternoon", closesAt: "14:00", before: "13:59" },
            { period: "evening", closesAt: "17:00", before: "16:59" },
        ];

        for (const { period, closesAt, before: justBefore } of cases) {
            it(`${period}: open at ${justBefore}, closed from ${closesAt}`, () => {
                assert.equal(isCallbackPeriodOpen(date, period, ist(date, justBefore)), true);
                assert.equal(isCallbackPeriodOpen(date, period, ist(date, closesAt)), false);
                assert.equal(isCallbackPeriodOpen(date, period, ist(date, "23:00")), false);
            });
        }

        it("a later date is open all day and an earlier date is closed", () => {
            const now = ist("2026-10-15", "16:30");

            assert.equal(isCallbackPeriodOpen("2026-10-16", "morning", now), true);
            assert.equal(isCallbackPeriodOpen("2026-10-14", "evening", now), false);
        });

        it("is closed for unknown periods and invalid dates", () => {
            const now = ist("2026-10-01", "09:00");

            for (const period of ["night", "", null, undefined, "constructor", "__proto__"]) {
                assert.equal(isCallbackPeriodOpen(date, period, now), false, String(period));
            }
            assert.equal(isCallbackPeriodOpen("2026-02-30", "morning", now), false);
        });
    });

    describe("Holiday model", () => {
        it("stores date and name and enforces a unique date", async () => {
            await Holiday.create({ date: "2026-11-09", name: "Diwali" });

            await assert.rejects(
                Holiday.create({ date: "2026-11-09", name: "Duplicate" }),
                (error) => error.code === 11000
            );
            assert.equal(await Holiday.countDocuments({ date: "2026-11-09" }), 1);
        });

        it("rejects impossible dates and missing names", async () => {
            await assert.rejects(Holiday.create({ date: "2026-02-30", name: "Nope" }), /valid YYYY-MM-DD/);
            await assert.rejects(Holiday.create({ date: "2026-11-09" }), /name/);
        });
    });
});
