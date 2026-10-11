// Public availability of callback periods.
//
// A period is available when its day is bookable, it has not passed its cutoff
// (closes cutoffMinutesBeforeEnd before it ends), it is not blocked, and it is below
// capacity. The public never sees counts or capacity, only a yes/no per period.
//
// Both functions take an optional `now` so tests can freeze time.

import { BOOKING } from "../config/booking.js";
import { CallbackBucket } from "../models/callbackBucket.model.js";
import {
    getCallbackDayStatus,
    getCallbackDayStatuses,
    isCallbackPeriodOpen,
} from "./calendar.service.js";
import { getCallbackCapacity } from "./settings.service.js";
import { enumerateDates } from "./vmAvailability.service.js";

const { periodOrder, periods } = BOOKING.callback;

// date -> period -> { booked, blocked }
const groupBuckets = (buckets) => {
    const byDate = new Map();
    for (const { date, period, booked, blocked } of buckets) {
        if (!byDate.has(date)) byDate.set(date, new Map());
        byDate.get(date).set(period, { booked: booked ?? 0, blocked: Boolean(blocked) });
    }
    return byDate;
};

const isPeriodAvailable = (date, periodKey, bucket, capacity, now) => {
    if (!isCallbackPeriodOpen(date, periodKey, now)) return false;     // past its cutoff
    if (bucket?.blocked) return false;                                 // blocked by staff
    return (bucket?.booked ?? 0) < capacity[periodKey];                // full (capacity 0 is always full)
};

/**
 * One entry per date from `from` to `to` (inclusive): { date, bookable, reason }.
 * A working day on which every period is full, blocked or closed is
 * { bookable: false, reason: "full" }. One callback_buckets query, one holidays query and
 * one settings query cover the whole range.
 */
const getCallbackCalendar = async (from, to, now = new Date()) => {
    const dates = enumerateDates(from, to);

    const [statuses, buckets, capacity] = await Promise.all([
        getCallbackDayStatuses(dates, now),
        CallbackBucket.find({ date: { $gte: from, $lte: to } })
            .select({ date: 1, period: 1, booked: 1, blocked: 1, _id: 0 })
            .lean(),
        getCallbackCapacity(),
    ]);
    const bucketsByDate = groupBuckets(buckets);

    return dates.map((date, index) => {
        const { bookable, reason } = statuses[index];
        if (!bookable) return { date, bookable: false, reason };

        const dayBuckets = bucketsByDate.get(date) ?? new Map();
        const anyAvailable = periodOrder.some((key) =>
            isPeriodAvailable(date, key, dayBuckets.get(key), capacity, now)
        );

        return anyAvailable
            ? { date, bookable: true, reason: null }
            : { date, bookable: false, reason: "full" };
    });
};

/**
 * The periods of one date with a yes/no `available`. A date that cannot be booked
 * (any reason, including "full") returns periods: [].
 */
const getCallbackAvailability = async (date, now = new Date()) => {
    const day = await getCallbackDayStatus(date, now);
    if (!day.bookable) return { date, bookable: false, reason: day.reason, periods: [] };

    const [buckets, capacity] = await Promise.all([
        CallbackBucket.find({ date }).select({ period: 1, booked: 1, blocked: 1, _id: 0 }).lean(),
        getCallbackCapacity(),
    ]);
    const byPeriod = new Map(buckets.map((b) => [b.period, { booked: b.booked ?? 0, blocked: Boolean(b.blocked) }]));

    const list = periodOrder.map((key) => ({
        key,
        label: periods[key].label,
        timeRange: periods[key].timeRange,
        available: isPeriodAvailable(date, key, byPeriod.get(key), capacity, now),
    }));

    if (!list.some((period) => period.available)) {
        return { date, bookable: false, reason: "full", periods: [] };
    }
    return { date, bookable: true, reason: null, periods: list };
};

export { getCallbackCalendar, getCallbackAvailability };
