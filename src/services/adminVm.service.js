// Admin actions on virtual meetings: block and unblock slots, cancel a booking, retry a
// missing Meet link. Every action writes one audit entry after the change is saved.
//
// No MongoDB transactions: each step is a single atomic operation guarded by a unique
// index or a filter (AGENT_CONTEXT.md section 7).
//
// Every function takes an optional `now` so tests can freeze time.

import { BOOKING } from "../config/booking.js";
import { Holiday } from "../models/holiday.model.js";
import { VmBooking } from "../models/vmBooking.model.js";
import { VmSlot } from "../models/vmSlot.model.js";
import { ApiError } from "../utils/ApiError.js";
import { expireAtFor, istToDate, nowIST } from "../utils/time.js";
import { recordAudit } from "./audit.service.js";
import { isVmWorkingDay } from "./calendar.service.js";
import { deleteEvent } from "./googleCalendar.service.js";
import { notifyVmCancelled } from "./notify.service.js";
import { retryMeetForBooking } from "./vmBooking.service.js";

const DUPLICATE_KEY = 11000;
const MAX_CREATE_ATTEMPTS = 3;
const SLOT_TIMES = BOOKING.vm.slotTimes;

const NOT_BOOKABLE_MESSAGES = {
    past: "That date has already passed, so it cannot be blocked.",
    non_working_day: "Virtual meetings do not run on that day, so there is nothing to block.",
    holiday: "That date is a holiday, so there is nothing to block.",
};

const notBookable = (reason) =>
    new ApiError(422, "DATE_NOT_BOOKABLE", NOT_BOOKABLE_MESSAGES[reason], { reason });

const isDuplicateKey = (error) => error?.code === DUPLICATE_KEY;

const targetTimes = ({ time, allDay }) => (allDay ? [...SLOT_TIMES] : [time]);
const targetId = ({ date, time, allDay }) => (allDay ? date : `${date} ${time}`);

// ── Block ─────────────────────────────────────────────────────────────────────

/**
 * Blocks one slot: VmSlot.create, where the unique { date, time } index decides.
 * Resolves { blocked: true } or { skipped: "booked" | "already_blocked" }.
 */
const blockOne = async ({ date, time, performedBy, reason }, now) => {
    for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt++) {
        try {
            await VmSlot.create({
                date, time, state: "blocked",
                blockedBy: performedBy, blockReason: reason, blockedAt: now,
                expireAt: expireAtFor(date),
            });
            return { blocked: true };
        } catch (error) {
            if (!isDuplicateKey(error)) throw error;

            // Taken: look at what holds it. If it was freed in the meantime, try again.
            const existing = await VmSlot.findOne({ date, time }).select({ state: 1, _id: 0 }).lean();
            if (existing) return { skipped: existing.state === "booked" ? "booked" : "already_blocked" };
        }
    }
    throw new ApiError(409, "CONFLICT", "That slot is changing right now. Please try again.");
};

/**
 * Blocks one slot time or the whole day. A slot that is booked or already blocked is
 * skipped, never overwritten. Past dates, closed days and holidays are 422 DATE_NOT_BOOKABLE.
 * @param {{ date: string, time?: string, allDay?: true, performedBy: string, reason: string }} input
 * @returns {Promise<{ blocked: string[], skipped: Array<{ time: string, reason: string }> }>}
 */
const blockVmSlots = async (input, { now = new Date() } = {}) => {
    const { date, performedBy, reason } = input;

    if (date < nowIST(now).dateKey) throw notBookable("past");
    if (!isVmWorkingDay(date)) throw notBookable("non_working_day");
    if (await Holiday.exists({ date })) throw notBookable("holiday");

    const blocked = [];
    const skipped = [];
    for (const time of targetTimes(input)) {
        const outcome = await blockOne({ date, time, performedBy, reason }, now);
        if (outcome.blocked) blocked.push(time);
        else skipped.push({ time, reason: outcome.skipped });
    }

    await recordAudit({
        action: "vm.block",
        targetType: "vm_slot",
        targetId: targetId(input),
        date,
        detail: { allDay: Boolean(input.allDay), blocked, skipped },
        performedBy,
        reason,
    }, { now });

    return { blocked, skipped };
};

// ── Unblock ───────────────────────────────────────────────────────────────────

/**
 * Removes blocks. Only documents with state "blocked" are deleted: a booked slot is never
 * touched, and a free slot is simply not listed. Works on any date.
 * @returns {Promise<{ unblocked: string[] }>}
 */
const unblockVmSlots = async (input, { now = new Date() } = {}) => {
    const { date, performedBy, reason } = input;

    const unblocked = [];
    for (const time of targetTimes(input)) {
        const { deletedCount } = await VmSlot.deleteOne({ date, time, state: "blocked" });
        if (deletedCount === 1) unblocked.push(time);
    }

    await recordAudit({
        action: "vm.unblock",
        targetType: "vm_slot",
        targetId: targetId(input),
        date,
        detail: { allDay: Boolean(input.allDay), unblocked },
        performedBy,
        reason,
    }, { now });

    return { unblocked };
};

// ── Cancel a booking ──────────────────────────────────────────────────────────

/**
 * Cancels a confirmed booking that has not started.
 *   1. booking -> cancelled (one conditional update, so two admins cannot both cancel)
 *   2. its slot: with alsoBlock ONE updateOne turns it into a block, otherwise it is deleted
 *   3. Google event deletion and the customer email run without being waited for
 *   4. audit entry
 * Errors: NOT_FOUND (404), NOT_CANCELLABLE (409: already cancelled or already started).
 * @returns {Promise<{ bookingId: string, status: "cancelled", slot: "released" | "blocked" }>}
 */
const cancelVmBooking = async (bookingId, { performedBy, reason, alsoBlock = false }, { now = new Date() } = {}) => {
    const existing = await VmBooking.findOne({ bookingId }).select({ status: 1, date: 1, time: 1, _id: 0 }).lean();
    if (!existing) throw new ApiError(404, "NOT_FOUND", "Booking not found.");

    if (existing.status !== "confirmed") {
        throw new ApiError(409, "NOT_CANCELLABLE", "This booking is already cancelled.");
    }
    if (istToDate(existing.date, existing.time).getTime() <= now.getTime()) {
        throw new ApiError(409, "NOT_CANCELLABLE", "This meeting has already started, so it can no longer be cancelled.");
    }

    const booking = await VmBooking.findOneAndUpdate(
        { bookingId, status: "confirmed" },
        { $set: { status: "cancelled", cancelledBy: performedBy, cancelReason: reason, cancelledAt: now } },
        { returnDocument: "after" }
    );
    if (!booking) throw new ApiError(409, "NOT_CANCELLABLE", "This booking is already cancelled.");

    const { date, time } = booking;
    let slot = "released";

    if (alsoBlock) {
        const result = await VmSlot.updateOne(
            { date, time, bookingId },
            {
                $set: { state: "blocked", blockedBy: performedBy, blockReason: reason, blockedAt: now },
                $unset: { bookingId: 1 },
            }
        );
        slot = "blocked";

        if (result.matchedCount === 0) {
            // The slot document is missing (it should not be). Make the block anyway; if someone
            // else already holds the slot there is nothing of ours to release or block.
            try {
                await VmSlot.create({
                    date, time, state: "blocked",
                    blockedBy: performedBy, blockReason: reason, blockedAt: now,
                    expireAt: expireAtFor(date),
                });
            } catch (error) {
                if (!isDuplicateKey(error)) throw error;
                slot = "released";
            }
        }
    } else {
        await VmSlot.deleteOne({ date, time, bookingId });
    }

    // Neither of these can fail the cancellation: both swallow and log their own errors.
    void deleteEvent(booking.googleEventId);
    void notifyVmCancelled(booking);

    await recordAudit({
        action: "vm.cancel",
        targetType: "vm_booking",
        targetId: bookingId,
        date,
        detail: { time, alsoBlock: Boolean(alsoBlock), slot },
        performedBy,
        reason,
    }, { now });

    return { bookingId, status: "cancelled", slot };
};

// ── Retry the Meet link ───────────────────────────────────────────────────────

/**
 * Creates the Meet link of a booking that has none (see retryMeetForBooking for the rules
 * and errors: NOT_FOUND, MEET_ALREADY_CREATED, NOT_CANCELLABLE, CONFLICT, MEET_CREATE_FAILED).
 * Only a retry that succeeded is audited; a failed one changes nothing.
 * @returns {Promise<{ bookingId: string, meetLink: string, meetStatus: "created" }>}
 */
const retryVmMeet = async (bookingId, { performedBy }, { now = new Date() } = {}) => {
    const result = await retryMeetForBooking(bookingId, { now });

    const booking = await VmBooking.findOne({ bookingId }).select({ date: 1, time: 1, _id: 0 }).lean();
    await recordAudit({
        action: "vm.retry_meet",
        targetType: "vm_booking",
        targetId: bookingId,
        date: booking?.date,
        detail: { time: booking?.time, meetStatus: result.meetStatus },
        performedBy,
    }, { now });

    return result;
};

export { blockVmSlots, unblockVmSlots, cancelVmBooking, retryVmMeet };
