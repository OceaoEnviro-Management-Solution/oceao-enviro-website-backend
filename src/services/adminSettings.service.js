// Admin settings: callback capacity and the holiday calendar. Every change that is made
// writes an audit entry after it is saved.
//
// Nothing here ever cancels a booking or request. Adding a holiday or lowering capacity
// leaves existing bookings in place; staff decide what to do about them.
//
// Every function takes an optional `now` so tests can freeze time.

import { Holiday } from "../models/holiday.model.js";
import { CallbackRequest } from "../models/callbackRequest.model.js";
import { VmBooking } from "../models/vmBooking.model.js";
import { SETTINGS_KEY } from "../models/settings.model.js";
import { ApiError } from "../utils/ApiError.js";
import { recordAudit } from "./audit.service.js";
import { isClosedByRule } from "./calendar.service.js";
import { getCallbackCapacity, setCallbackCapacity } from "./settings.service.js";

const DUPLICATE_KEY = 11000;

const isDuplicateKey = (error) => error?.code === DUPLICATE_KEY;

// ── Callback capacity ─────────────────────────────────────────────────────────

/**
 * Saves the capacity of each period. It applies to the very next public request; requests
 * already booked are never cancelled, even when they now exceed the capacity.
 * @param {{ morning: number, afternoon: number, evening: number, performedBy: string, reason: string }} input
 * @returns {Promise<{ callbackCapacity: { morning: number, afternoon: number, evening: number } }>}
 */
const updateCallbackCapacity = async (input, { now = new Date() } = {}) => {
    const { morning, afternoon, evening, performedBy, reason } = input;

    const previous = await getCallbackCapacity();
    const callbackCapacity = await setCallbackCapacity({ morning, afternoon, evening });

    await recordAudit({
        action: "settings.capacity",
        targetType: "settings",
        targetId: SETTINGS_KEY,
        detail: { from: previous, to: callbackCapacity },
        performedBy,
        reason,
    }, { now });

    return { callbackCapacity };
};

// ── Holidays ──────────────────────────────────────────────────────────────────

/** How many live bookings and requests fall on these dates (cancelled ones are not counted). */
const countAffected = async (dates) => {
    if (dates.length === 0) return { vmBookings: 0, callbackRequests: 0 };

    const [vmBookings, callbackRequests] = await Promise.all([
        VmBooking.countDocuments({ date: { $in: dates }, status: "confirmed" }),
        CallbackRequest.countDocuments({ date: { $in: dates }, status: { $ne: "cancelled" } }),
    ]);
    return { vmBookings, callbackRequests };
};

const alreadyClosed = () =>
    new ApiError(
        422,
        "ALREADY_CLOSED",
        "That date is already closed (a Sunday or second Saturday), so it does not need to be a holiday."
    );

/**
 * Adds one holiday. It succeeds even when bookings exist on that date and reports how many
 * (`affected`); nothing is cancelled.
 * Errors: ALREADY_CLOSED (422: Sunday or second Saturday), CONFLICT (409: already a holiday).
 */
const addHoliday = async ({ date, name, performedBy, reason }, { now = new Date() } = {}) => {
    if (isClosedByRule(date)) throw alreadyClosed();

    try {
        await Holiday.create({ date, name });
    } catch (error) {
        if (isDuplicateKey(error)) throw new ApiError(409, "CONFLICT", "That date is already a holiday.");
        throw error;
    }

    const affected = await countAffected([date]);

    await recordAudit({
        action: "holiday.add",
        targetType: "holiday",
        targetId: date,
        date,
        detail: { name, affected },
        performedBy,
        reason,
    }, { now });

    return { holiday: { date, name }, affected };
};

/**
 * Adds many holidays (the start-of-year setup). Each date is handled on its own:
 * a Sunday or second Saturday is skipped as "closed_by_rule", a date that already is a
 * holiday (or repeats earlier in the list) as "exists". One audit entry per holiday added.
 * @returns {Promise<{ added: string[], skipped: Array<{ date: string, reason: string }>,
 *                     affected: { vmBookings: number, callbackRequests: number } }>}
 */
const addHolidays = async ({ holidays, performedBy, reason }, { now = new Date() } = {}) => {
    const added = [];
    const skipped = [];
    const names = new Map();
    const seen = new Set();

    for (const { date, name } of holidays) {
        if (isClosedByRule(date)) {
            skipped.push({ date, reason: "closed_by_rule" });
            continue;
        }
        if (seen.has(date)) {
            skipped.push({ date, reason: "exists" });
            continue;
        }
        seen.add(date);

        try {
            await Holiday.create({ date, name });
            added.push(date);
            names.set(date, name);
        } catch (error) {
            if (!isDuplicateKey(error)) throw error;
            skipped.push({ date, reason: "exists" });
        }
    }

    for (const date of added) {
        await recordAudit({
            action: "holiday.add",
            targetType: "holiday",
            targetId: date,
            date,
            detail: { name: names.get(date), bulk: true },
            performedBy,
            reason,
        }, { now });
    }

    return { added, skipped, affected: await countAffected(added) };
};

/** Renames a holiday. Unknown date: 404 NOT_FOUND. */
const renameHoliday = async (date, { name, performedBy, reason }, { now = new Date() } = {}) => {
    const before = await Holiday.findOneAndUpdate(
        { date },
        { $set: { name } },
        { returnDocument: "before", runValidators: true }
    );
    if (!before) throw new ApiError(404, "NOT_FOUND", "Holiday not found.");

    await recordAudit({
        action: "holiday.rename",
        targetType: "holiday",
        targetId: date,
        date,
        detail: { from: before.name, to: name },
        performedBy,
        reason,
    }, { now });

    return { holiday: { date, name } };
};

/** Removes a holiday, reopening the date. Unknown date: 404 NOT_FOUND. */
const deleteHoliday = async (date, { performedBy, reason }, { now = new Date() } = {}) => {
    const removed = await Holiday.findOneAndDelete({ date });
    if (!removed) throw new ApiError(404, "NOT_FOUND", "Holiday not found.");

    await recordAudit({
        action: "holiday.delete",
        targetType: "holiday",
        targetId: date,
        date,
        detail: { name: removed.name },
        performedBy,
        reason,
    }, { now });

    return { date };
};

export { updateCallbackCapacity, addHoliday, addHolidays, renameHoliday, deleteHoliday };
