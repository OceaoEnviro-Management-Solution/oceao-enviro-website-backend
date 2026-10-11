// Working-calendar rules: which dates and times can be booked.
// All rules come from config/booking.js; all "now" logic is IST via utils/time.js.
// Every function takes an optional `now` (a Date) so tests can freeze time.

import { BOOKING } from "../config/booking.js";
import { Holiday } from "../models/holiday.model.js";
import { addDays, dayOfWeek, isValidDateKey, istToDate, nowIST } from "../utils/time.js";

const MS_PER_MINUTE = 60 * 1000;
const SATURDAY = 6;

const closed = (reason) => ({ bookable: false, reason });
const open = () => ({ bookable: true, reason: null });

// Which Saturday of its month a date is: 1 for days 1-7, 2 for days 8-14, ...
const saturdayOfMonth = (dateKey) => Math.ceil(Number(dateKey.slice(8, 10)) / 7);

const isVmWorkingDay = (dateKey) => BOOKING.vm.workingDays.includes(dayOfWeek(dateKey));

const isCallbackWorkingDay = (dateKey) => {
    const dow = dayOfWeek(dateKey);
    if (!BOOKING.callback.workingDays.includes(dow)) return false;
    if (dow === SATURDAY && BOOKING.callback.closedSaturdaysOfMonth.includes(saturdayOfMonth(dateKey))) {
        return false;
    }
    return true;
};

/**
 * True when the weekday rules close the date for BOTH VM and callbacks
 * (Sundays and second Saturdays). Such dates are never stored as holidays.
 */
const isClosedByRule = (dateKey) =>
    isValidDateKey(dateKey) && !isVmWorkingDay(dateKey) && !isCallbackWorkingDay(dateKey);

// Order matters: a date is reported with the first reason that applies.
// `isHoliday` may be sync or async; the default looks the date up in the database.
const evaluateDay = async (
    dateKey,
    now,
    { horizonDays, isWorkingDay },
    isHoliday = (key) => Holiday.exists({ date: key })
) => {
    if (!isValidDateKey(dateKey)) return closed("invalid_date");

    const today = nowIST(now).dateKey;
    if (dateKey < today) return closed("past");
    if (dateKey > addDays(today, horizonDays)) return closed("beyond_horizon");
    if (!isWorkingDay(dateKey)) return closed("non_working_day");
    if (await isHoliday(dateKey)) return closed("holiday");

    return open();
};

/**
 * Can a virtual meeting be booked on this date at all?
 * @returns {Promise<{ bookable: boolean, reason: null | "invalid_date" | "past" | "beyond_horizon" | "non_working_day" | "holiday" }>}
 */
const getVmDayStatus = (dateKey, now = new Date()) =>
    evaluateDay(dateKey, now, { horizonDays: BOOKING.vm.horizonDays, isWorkingDay: isVmWorkingDay });

// Day statuses for many dates with a single holidays query.
const getDayStatuses = async (dateKeys, now, rules) => {
    const candidates = dateKeys.filter(isValidDateKey);
    const holidays = candidates.length > 0
        ? new Set((await Holiday.find({ date: { $in: candidates } }).select({ date: 1, _id: 0 }).lean()).map((h) => h.date))
        : new Set();

    return Promise.all(
        dateKeys.map((dateKey) => evaluateDay(dateKey, now, rules, (key) => holidays.has(key)))
    );
};

/**
 * getVmDayStatus for many dates with a single holidays query.
 * @param {string[]} dateKeys
 * @returns {Promise<Array<{ bookable: boolean, reason: string | null }>>} same order as dateKeys
 */
const getVmDayStatuses = (dateKeys, now = new Date()) =>
    getDayStatuses(dateKeys, now, { horizonDays: BOOKING.vm.horizonDays, isWorkingDay: isVmWorkingDay });

/**
 * getCallbackDayStatus for many dates with a single holidays query.
 * @param {string[]} dateKeys
 * @returns {Promise<Array<{ bookable: boolean, reason: string | null }>>} same order as dateKeys
 */
const getCallbackDayStatuses = (dateKeys, now = new Date()) =>
    getDayStatuses(dateKeys, now, { horizonDays: BOOKING.callback.horizonDays, isWorkingDay: isCallbackWorkingDay });

/**
 * Is this slot time bookable right now? False for a time that is not a configured
 * slot, or one that starts less than minLeadMinutes from now. Does not check the day;
 * use getVmDayStatus for that.
 */
const isVmSlotTimeOpen = (dateKey, time, now = new Date()) => {
    if (!isValidDateKey(dateKey) || !BOOKING.vm.slotTimes.includes(time)) return false;

    const startsAt = istToDate(dateKey, time).getTime();
    return startsAt - now.getTime() >= BOOKING.vm.minLeadMinutes * MS_PER_MINUTE;
};

/**
 * Can a callback be requested on this date at all? Same reasons as getVmDayStatus;
 * second Saturdays (closedSaturdaysOfMonth) are reported as non_working_day.
 */
const getCallbackDayStatus = (dateKey, now = new Date()) =>
    evaluateDay(dateKey, now, {
        horizonDays: BOOKING.callback.horizonDays,
        isWorkingDay: isCallbackWorkingDay,
    });

/**
 * Is this callback period still open? A period closes cutoffMinutesBeforeEnd before
 * it ends (morning ends 12:00 and closes at 11:00 sharp). Does not check the day.
 */
const isCallbackPeriodOpen = (dateKey, periodKey, now = new Date()) => {
    const period = Object.hasOwn(BOOKING.callback.periods, periodKey)
        ? BOOKING.callback.periods[periodKey]
        : null;
    if (!period || !isValidDateKey(dateKey)) return false;

    const closesAt =
        istToDate(dateKey, period.end).getTime() - BOOKING.callback.cutoffMinutesBeforeEnd * MS_PER_MINUTE;
    return now.getTime() < closesAt;
};

export {
    getVmDayStatus,
    getVmDayStatuses,
    isVmSlotTimeOpen,
    getCallbackDayStatus,
    getCallbackDayStatuses,
    isCallbackPeriodOpen,
    isClosedByRule,
    isVmWorkingDay,
    isCallbackWorkingDay,
};
