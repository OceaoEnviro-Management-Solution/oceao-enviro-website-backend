// Public availability of virtual meeting slots.
//
// A slot is "available" when it has no vm_slots document (a free slot has none) and
// still starts at least minLeadMinutes from now. Booked, blocked and too-late slots are
// all reported as "booked" so the public never learns why a slot is unavailable.
//
// Both functions take an optional `now` so tests can freeze time.

import { BOOKING } from "../config/booking.js";
import { VmSlot } from "../models/vmSlot.model.js";
import { getVmDayStatus, getVmDayStatuses, isVmSlotTimeOpen } from "./calendar.service.js";
import { addDays } from "../utils/time.js";

/** A calendar request may cover at most this many dates (inclusive), i.e. two months. */
export const MAX_CALENDAR_RANGE_DAYS = 62;

const SLOT_TIMES = BOOKING.vm.slotTimes;

export const enumerateDates = (from, to) => {
    const dates = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
        dates.push(date);
        if (dates.length > MAX_CALENDAR_RANGE_DAYS) {
            throw new RangeError(`Range exceeds ${MAX_CALENDAR_RANGE_DAYS} days`);
        }
    }
    return dates;
};

// date -> Set of occupied times (booked or blocked)
const groupOccupied = (slots) => {
    const byDate = new Map();
    for (const { date, time } of slots) {
        if (!byDate.has(date)) byDate.set(date, new Set());
        byDate.get(date).add(time);
    }
    return byDate;
};

const freeSlotTimes = (date, occupied, now) =>
    SLOT_TIMES.filter((time) => !occupied.has(time) && isVmSlotTimeOpen(date, time, now));

/**
 * One entry per date from `from` to `to` (inclusive). One vm_slots query and one
 * holidays query cover the whole range.
 * @returns {Promise<Array<{ date: string, bookable: boolean, reason: string | null, availableCount: number }>>}
 */
const getVmCalendar = async (from, to, now = new Date()) => {
    const dates = enumerateDates(from, to);

    const [statuses, slots] = await Promise.all([
        getVmDayStatuses(dates, now),
        VmSlot.find({ date: { $gte: from, $lte: to } }).select({ date: 1, time: 1, _id: 0 }).lean(),
    ]);
    const occupiedByDate = groupOccupied(slots);

    return dates.map((date, index) => {
        const { bookable, reason } = statuses[index];
        if (!bookable) return { date, bookable: false, reason, availableCount: 0 };

        const free = freeSlotTimes(date, occupiedByDate.get(date) ?? new Set(), now);
        if (free.length === 0) return { date, bookable: false, reason: "full", availableCount: 0 };

        return { date, bookable: true, reason: null, availableCount: free.length };
    });
};

/**
 * Every configured slot of one date with status "available" or "booked".
 * A date that cannot be booked (any reason, including "full") returns slots: [].
 */
const getVmAvailability = async (date, now = new Date()) => {
    const { bookable, reason } = await getVmDayStatus(date, now);
    if (!bookable) return { date, bookable: false, reason, slots: [] };

    const taken = await VmSlot.find({ date }).select({ time: 1, _id: 0 }).lean();
    const occupied = new Set(taken.map((slot) => slot.time));
    const free = new Set(freeSlotTimes(date, occupied, now));

    if (free.size === 0) return { date, bookable: false, reason: "full", slots: [] };

    return {
        date,
        bookable: true,
        reason: null,
        slots: SLOT_TIMES.map((time) => ({ time, status: free.has(time) ? "available" : "booked" })),
    };
};

export { getVmCalendar, getVmAvailability };
