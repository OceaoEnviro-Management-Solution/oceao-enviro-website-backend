// IST-correct time helpers. The server may run in any timezone, so nothing here uses
// local Date getters. A dateKey is "YYYY-MM-DD" in IST; times are "HH:mm" (24h) in IST.

import { BOOKING } from "../config/booking.js";

// India has no daylight saving, so IST is always UTC+05:30.
const IST_OFFSET_MINUTES = 330;
const MS_PER_MINUTE = 60 * 1000;
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const istFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOOKING.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
});

const parseDateKey = (value) => {
    const match = DATE_KEY_PATTERN.exec(typeof value === "string" ? value : "");
    if (!match) return null;

    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];

    // setUTCFullYear (unlike Date.UTC) does not map years 0-99 to 1900-1999.
    const probe = new Date(0);
    probe.setUTCFullYear(year, month - 1, day);
    const roundTrips =
        probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;

    return roundTrips ? { year, month, day } : null;
};

const formatDateKey = (date) => {
    const year = String(date.getUTCFullYear()).padStart(4, "0");
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
};

const utcMidnight = ({ year, month, day }) => {
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    return date;
};

/** True for a real calendar date written as "YYYY-MM-DD" ("2026-02-30" is rejected). */
export const isValidDateKey = (value) => parseDateKey(value) !== null;

/** True for "HH:mm" (24h). */
export const isValidTime = (value) => typeof value === "string" && TIME_PATTERN.test(value);

/** "HH:mm" -> minutes since midnight. */
export const timeToMinutes = (time) => {
    if (!isValidTime(time)) throw new RangeError(`Invalid time: ${time}`);
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
};

/**
 * The current date and time of day in IST.
 * @param {Date} [now] pass a Date to freeze time in tests
 * @returns {{ dateKey: string, minutes: number }} minutes = minutes since IST midnight
 */
export const nowIST = (now = new Date()) => {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new TypeError("nowIST expects a valid Date");
    }
    const parts = Object.fromEntries(
        istFormatter.formatToParts(now).map((part) => [part.type, part.value])
    );
    return {
        dateKey: `${parts.year}-${parts.month}-${parts.day}`,
        minutes: Number(parts.hour) * 60 + Number(parts.minute),
    };
};

/** Adds (or subtracts) whole days to a dateKey. */
export const addDays = (dateKey, days) => {
    const parsed = parseDateKey(dateKey);
    if (!parsed) throw new RangeError(`Invalid dateKey: ${dateKey}`);
    if (!Number.isInteger(days)) throw new TypeError("addDays expects an integer number of days");

    const date = utcMidnight(parsed);
    date.setUTCDate(date.getUTCDate() + days);
    return formatDateKey(date);
};

/** Day of week of a dateKey, 0 = Sunday. Never depends on the server timezone. */
export const dayOfWeek = (dateKey) => {
    const parsed = parseDateKey(dateKey);
    if (!parsed) throw new RangeError(`Invalid dateKey: ${dateKey}`);
    return utcMidnight(parsed).getUTCDay();
};

/** The real UTC instant for an IST wall-clock date and time. */
export const istToDate = (dateKey, time) => {
    const parsed = parseDateKey(dateKey);
    if (!parsed) throw new RangeError(`Invalid dateKey: ${dateKey}`);
    const minutesOfDay = timeToMinutes(time);

    const utcWallClock = utcMidnight(parsed).getTime() + minutesOfDay * MS_PER_MINUTE;
    return new Date(utcWallClock - IST_OFFSET_MINUTES * MS_PER_MINUTE);
};

/**
 * When a record dated `dateKey` should be deleted: retentionDays after the end of
 * that IST day (i.e. after 00:00 IST of the following day).
 */
export const expireAtFor = (dateKey) =>
    istToDate(addDays(dateKey, BOOKING.retentionDays + 1), "00:00");
