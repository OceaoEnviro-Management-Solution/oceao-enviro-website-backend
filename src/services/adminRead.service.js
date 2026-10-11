// Admin read endpoints (API_CONTRACT.md "Admin read endpoints"). Read only.
//
// Unlike the public availability, these views show what is STORED: a slot is "available"
// when it has no vm_slots document, whatever the time of day, and dates in the past or beyond
// the booking horizon can be viewed. "working" means the weekday rules and the holidays
// allow bookings on that date (it ignores whether the date is in the past).
//
// Every function takes an optional `now` so tests can freeze time.

import { BOOKING } from "../config/booking.js";
import { CallbackBucket } from "../models/callbackBucket.model.js";
import { CallbackRequest } from "../models/callbackRequest.model.js";
import { Holiday } from "../models/holiday.model.js";
import { VmBooking } from "../models/vmBooking.model.js";
import { VmSlot } from "../models/vmSlot.model.js";
import { addDays, nowIST } from "../utils/time.js";
import { isCallbackWorkingDay, isVmWorkingDay } from "./calendar.service.js";
import { getCallbackCapacity } from "./settings.service.js";

const SLOT_TIMES = BOOKING.vm.slotTimes;
const { periodOrder, periods } = BOOKING.callback;
const PERIOD_RANK = Object.fromEntries(periodOrder.map((key, index) => [key, index]));

// "all stored fields except expireAt and googleEventId"; mongoose's own _id and __v are left out too.
const HIDE_INTERNAL = { _id: 0, __v: 0, expireAt: 0, googleEventId: 0 };

// Callback requests are read in arrival order (creation time, then _id, which grows with
// every document one server creates) and then re-sorted with this comparator. Array.sort is
// stable, so requests of the same date and period stay in arrival order.
const ARRIVAL_ORDER = { date: 1, createdAt: 1, _id: 1 };
const byDateThenPeriod = (a, b) =>
    a.date.localeCompare(b.date) || PERIOD_RANK[a.period] - PERIOD_RANK[b.period];

const blockDetails = ({ blockedBy, blockReason, blockedAt } = {}) => ({
    blockedBy: blockedBy ?? null,
    blockReason: blockReason ?? null,
    blockedAt: blockedAt ?? null,
});

// ── Shared lookups ────────────────────────────────────────────────────────────

const getHolidayName = async (date) => {
    const holiday = await Holiday.findOne({ date }).select({ name: 1, _id: 0 }).lean();
    return holiday?.name ?? null;
};

const confirmedVmBookings = (filter) =>
    VmBooking.find({ ...filter, status: "confirmed" }).select(HIDE_INTERNAL).lean();

/**
 * One entry per configured slot time of one date:
 *   { time, state: "booked", booking }  a confirmed booking holds it
 *   { time, state: "blocked", block }   staff blocked it
 *   { time, state: "free" }             no document
 * A slot document that says "booked" but has no confirmed booking behind it (the process
 * died between claiming the slot and saving the booking) is reported as blocked with empty
 * block details, because the slot cannot be booked by anyone.
 */
const resolveVmSlots = (bookings, slots) => {
    const bookingByTime = new Map(bookings.map((booking) => [booking.time, booking]));
    const slotByTime = new Map(slots.map((slot) => [slot.time, slot]));

    return SLOT_TIMES.map((time) => {
        const booking = bookingByTime.get(time);
        if (booking) return { time, state: "booked", booking };

        const slot = slotByTime.get(time);
        if (slot) return { time, state: "blocked", block: blockDetails(slot) };

        return { time, state: "free" };
    });
};

// ── GET /admin/dashboard ──────────────────────────────────────────────────────

const KIND_RANK = { meeting: 0, available: 1, blocked: 2, callback: 3 };

/**
 * The day at a glance. `date` defaults to today in IST.
 * Timeline entries are sorted by time; at the same time VM entries come before callbacks.
 */
const getDashboard = async (date, now = new Date()) => {
    const day = date ?? nowIST(now).dateKey;

    const [holidayName, bookings, slots, requests] = await Promise.all([
        getHolidayName(day),
        confirmedVmBookings({ date: day }),
        VmSlot.find({ date: day }).select({ time: 1, state: 1, blockedBy: 1, blockReason: 1, blockedAt: 1, _id: 0 }).lean(),
        CallbackRequest.find({ date: day, status: { $ne: "cancelled" } })
            .select({ __v: 0, expireAt: 0 })
            .sort(ARRIVAL_ORDER)
            .lean(),
    ]);

    const vmWorking = isVmWorkingDay(day) && holidayName === null;
    const timeline = [];

    for (const slot of resolveVmSlots(bookings, slots)) {
        if (slot.state === "booked") {
            const { booking } = slot;
            timeline.push({
                kind: "meeting",
                time: slot.time,
                bookingId: booking.bookingId,
                name: booking.name,
                organisation: booking.organisation ?? null,
                email: booking.email,
                mobileNumber: booking.mobileNumber,
                topic: booking.topic ?? null,
                meetLink: booking.meetLink ?? null,
                meetStatus: booking.meetStatus,
            });
        } else if (slot.state === "blocked") {
            timeline.push({
                kind: "blocked",
                time: slot.time,
                blockedBy: slot.block.blockedBy,
                blockReason: slot.block.blockReason,
            });
        } else if (vmWorking) {
            timeline.push({ kind: "available", time: slot.time });
        }
    }

    for (const request of requests.sort(byDateThenPeriod)) {
        timeline.push({
            kind: "callback",
            time: periods[request.period].start,
            period: request.period,
            requestId: request.requestId,
            name: request.name,
            email: request.email,
            mobileNumber: request.mobileNumber,
            reason: request.reason ?? null,
            status: request.status,
        });
    }

    // Array.prototype.sort is stable, so entries of the same kind and time keep the order above.
    timeline.sort((a, b) => a.time.localeCompare(b.time) || KIND_RANK[a.kind] - KIND_RANK[b.kind]);

    const count = (kind) => timeline.filter((entry) => entry.kind === kind).length;
    return {
        date: day,
        counts: {
            meetings: count("meeting"),
            callbacks: count("callback"),
            openVmSlots: count("available"),
            blockedVmSlots: count("blocked"),
        },
        timeline,
    };
};

// ── GET /admin/bookings ───────────────────────────────────────────────────────

/**
 * VM bookings and callback requests dated from..to, sorted by date then time / period.
 * Cancelled ones are left out unless includeCancelled is true.
 * @param {{ from: string, to: string, type: "all" | "vm" | "callback", includeCancelled: boolean }} query
 */
const listBookings = async ({ from, to, type, includeCancelled }) => {
    const range = { date: { $gte: from, $lte: to } };

    const [vmBookings, callbackRequests] = await Promise.all([
        type === "callback"
            ? []
            : VmBooking.find(includeCancelled ? range : { ...range, status: "confirmed" })
                .select(HIDE_INTERNAL)
                .sort({ date: 1, time: 1, createdAt: 1, _id: 1 })
                .lean(),
        type === "vm"
            ? []
            : CallbackRequest.find(includeCancelled ? range : { ...range, status: { $ne: "cancelled" } })
                .select(HIDE_INTERNAL)
                .sort(ARRIVAL_ORDER)
                .lean(),
    ]);

    return { vmBookings, callbackRequests: callbackRequests.sort(byDateThenPeriod) };
};

// ── GET /admin/vm/calendar ────────────────────────────────────────────────────

const daysOfMonth = (month) => {
    const [year, number] = month.split("-").map(Number);
    const length = new Date(Date.UTC(year, number, 0)).getUTCDate();
    const first = `${month}-01`;
    return Array.from({ length }, (_, index) => addDays(first, index));
};

/**
 * One entry per day of the month: whether VM runs that day, the holiday name if any, and
 * how many slots are booked, blocked and still free (free is 0 on a day VM does not run).
 * @param {string} month "YYYY-MM"
 */
const getVmMonth = async (month) => {
    const dates = daysOfMonth(month);
    const [first, last] = [dates[0], dates[dates.length - 1]];

    const [holidays, slots] = await Promise.all([
        Holiday.find({ date: { $gte: first, $lte: last } }).select({ date: 1, name: 1, _id: 0 }).lean(),
        VmSlot.find({ date: { $gte: first, $lte: last } }).select({ date: 1, state: 1, _id: 0 }).lean(),
    ]);
    const holidayNames = new Map(holidays.map((holiday) => [holiday.date, holiday.name]));

    const tally = new Map();
    for (const { date, state } of slots) {
        const entry = tally.get(date) ?? { booked: 0, blocked: 0 };
        entry[state === "booked" ? "booked" : "blocked"] += 1;
        tally.set(date, entry);
    }

    return {
        month,
        days: dates.map((date) => {
            const holidayName = holidayNames.get(date) ?? null;
            const working = isVmWorkingDay(date) && holidayName === null;
            const { booked, blocked } = tally.get(date) ?? { booked: 0, blocked: 0 };
            return {
                date,
                working,
                holidayName,
                booked,
                blocked,
                available: working ? Math.max(0, SLOT_TIMES.length - booked - blocked) : 0,
            };
        }),
    };
};

// ── GET /admin/vm/availability ────────────────────────────────────────────────

/** Every slot of one date with its status and, when occupied, the booking or block details. */
const getVmDay = async (date) => {
    const [holidayName, bookings, slots] = await Promise.all([
        getHolidayName(date),
        confirmedVmBookings({ date }),
        VmSlot.find({ date }).select({ time: 1, state: 1, blockedBy: 1, blockReason: 1, blockedAt: 1, _id: 0 }).lean(),
    ]);

    return {
        date,
        working: isVmWorkingDay(date) && holidayName === null,
        holidayName,
        slots: resolveVmSlots(bookings, slots).map((slot) => ({
            time: slot.time,
            status: slot.state === "free" ? "available" : slot.state,
            booking: slot.state === "booked" ? slot.booking : null,
            block: slot.state === "blocked" ? slot.block : null,
        })),
    };
};

// ── GET /admin/callback/availability ──────────────────────────────────────────

/** The three callback periods of one date with capacity, booked count and block details. */
const getCallbackDay = async (date) => {
    const [holidayName, buckets, capacity] = await Promise.all([
        getHolidayName(date),
        CallbackBucket.find({ date }).lean(),
        getCallbackCapacity(),
    ]);
    const bucketByPeriod = new Map(buckets.map((bucket) => [bucket.period, bucket]));

    return {
        date,
        working: isCallbackWorkingDay(date) && holidayName === null,
        holidayName,
        periods: periodOrder.map((key) => {
            const bucket = bucketByPeriod.get(key);
            const blocked = Boolean(bucket?.blocked);
            return {
                key,
                label: periods[key].label,
                timeRange: periods[key].timeRange,
                capacity: capacity[key],
                booked: bucket?.booked ?? 0,
                blocked,
                block: blocked ? blockDetails(bucket) : null,
            };
        }),
    };
};

// ── GET /admin/callback/requests ──────────────────────────────────────────────

/** Non-cancelled requests of one date, optionally one period, in period then arrival order. */
const listCallbackRequests = async ({ date, period }) => {
    const requests = await CallbackRequest.find({
        date,
        status: { $ne: "cancelled" },
        ...(period ? { period } : {}),
    })
        .select(HIDE_INTERNAL)
        .sort(ARRIVAL_ORDER)
        .lean();

    return { requests: requests.sort(byDateThenPeriod) };
};

// ── GET /admin/settings and GET /admin/holidays ───────────────────────────────

const getAdminSettings = async () => ({ callbackCapacity: await getCallbackCapacity() });

/** The holidays of one calendar year, sorted by date. @param {string} year "YYYY" */
const listHolidays = async (year) => {
    const holidays = await Holiday.find({ date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } })
        .select({ date: 1, name: 1, _id: 0 })
        .sort({ date: 1 })
        .lean();

    return { holidays };
};

export {
    getDashboard,
    listBookings,
    getVmMonth,
    getVmDay,
    getCallbackDay,
    listCallbackRequests,
    getAdminSettings,
    listHolidays,
};
