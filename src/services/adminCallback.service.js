// Admin actions on callbacks: block and unblock periods, cancel requests, set a request's
// status. Every change that is made writes an audit entry after it is saved.
//
// No MongoDB transactions: each step is one atomic operation guarded by a filter or the
// unique { date, period } index (AGENT_CONTEXT.md section 7). Blocking a period never
// cancels or moves the requests already in it.
//
// Every function takes an optional `now` so tests can freeze time.

import { BOOKING } from "../config/booking.js";
import { CallbackBucket } from "../models/callbackBucket.model.js";
import { CallbackRequest } from "../models/callbackRequest.model.js";
import { Holiday } from "../models/holiday.model.js";
import { ApiError } from "../utils/ApiError.js";
import { expireAtFor, nowIST } from "../utils/time.js";
import { recordAudit } from "./audit.service.js";
import { isCallbackWorkingDay } from "./calendar.service.js";
import { notifyCallbackCancelled } from "./notify.service.js";

const DUPLICATE_KEY = 11000;
const MAX_UPSERT_ATTEMPTS = 3;
const PERIODS = BOOKING.callback.periodOrder;

const NOT_BOOKABLE_MESSAGES = {
    past: "That date has already passed, so it cannot be blocked.",
    non_working_day: "Callbacks do not run on that day, so there is nothing to block.",
    holiday: "That date is a holiday, so there is nothing to block.",
};

const notBookable = (reason) =>
    new ApiError(422, "DATE_NOT_BOOKABLE", NOT_BOOKABLE_MESSAGES[reason], { reason });

const isDuplicateKey = (error) => error?.code === DUPLICATE_KEY;

const targetPeriods = ({ period, allDay }) => (allDay ? [...PERIODS] : [period]);
const targetId = ({ date, period, allDay }) => (allDay ? date : `${date} ${period}`);

// ── Block / unblock ───────────────────────────────────────────────────────────

/**
 * Marks one (date, period) bucket blocked, creating it when there is none. A bucket that is
 * already blocked is left exactly as it is (the first block's details stay).
 * Resolves true when this call blocked it, false when it was already blocked.
 */
const blockBucket = async ({ date, period, performedBy, reason }, now) => {
    for (let attempt = 1; attempt <= MAX_UPSERT_ATTEMPTS; attempt++) {
        try {
            await CallbackBucket.findOneAndUpdate(
                { date, period, blocked: { $ne: true } },
                {
                    $set: { blocked: true, blockedBy: performedBy, blockReason: reason, blockedAt: now },
                    $setOnInsert: { booked: 0, expireAt: expireAtFor(date) },
                },
                { upsert: true, returnDocument: "after" }
            );
            return true;
        } catch (error) {
            if (!isDuplicateKey(error)) throw error;

            // The filter excluded an existing bucket and the upsert then collided with it:
            // it is already blocked. Otherwise a public request created it a moment ago; go again.
            const existing = await CallbackBucket.findOne({ date, period }).select({ blocked: 1, _id: 0 }).lean();
            if (existing?.blocked) return false;
        }
    }
    throw new ApiError(409, "CONFLICT", "That period is changing right now. Please try again.");
};

/**
 * Blocks one period or the whole day. The bucket is created if needed (so a period that has
 * no requests can be blocked ahead of time). Past dates, closed days and holidays are 422.
 * @param {{ date: string, period?: string, allDay?: true, performedBy: string, reason: string }} input
 * @returns {Promise<{ blocked: string[] }>} the periods this call blocked
 */
const blockCallbackPeriods = async (input, { now = new Date() } = {}) => {
    const { date, performedBy, reason } = input;

    if (date < nowIST(now).dateKey) throw notBookable("past");
    if (!isCallbackWorkingDay(date)) throw notBookable("non_working_day");
    if (await Holiday.exists({ date })) throw notBookable("holiday");

    const blocked = [];
    const alreadyBlocked = [];
    for (const period of targetPeriods(input)) {
        const changed = await blockBucket({ date, period, performedBy, reason }, now);
        (changed ? blocked : alreadyBlocked).push(period);
    }

    await recordAudit({
        action: "callback.block",
        targetType: "callback_bucket",
        targetId: targetId(input),
        date,
        detail: { allDay: Boolean(input.allDay), blocked, alreadyBlocked },
        performedBy,
        reason,
    }, { now });

    return { blocked };
};

/**
 * Removes blocks. Only the block fields change: the bucket (and its booked count) stays.
 * Works on any date. A period that was not blocked is simply not listed.
 * @returns {Promise<{ unblocked: string[] }>}
 */
const unblockCallbackPeriods = async (input, { now = new Date() } = {}) => {
    const { date, performedBy, reason } = input;

    const unblocked = [];
    for (const period of targetPeriods(input)) {
        const result = await CallbackBucket.updateOne(
            { date, period, blocked: true },
            { $set: { blocked: false }, $unset: { blockedBy: 1, blockReason: 1, blockedAt: 1 } }
        );
        if (result.modifiedCount === 1) unblocked.push(period);
    }

    await recordAudit({
        action: "callback.unblock",
        targetType: "callback_bucket",
        targetId: targetId(input),
        date,
        detail: { allDay: Boolean(input.allDay), unblocked },
        performedBy,
        reason,
    }, { now });

    return { unblocked };
};

// ── Cancel requests ───────────────────────────────────────────────────────────

/**
 * Cancels pending requests. For each one: status -> cancelled (one conditional update, so a
 * request can only be cancelled once), the bucket's booked count goes down by 1 (never below
 * 0), the customer is emailed without the internal reason, and one audit entry is written.
 * A request that is not pending is skipped: not_found, already_cancelled, or not_pending
 * (completed or no_answer).
 * @returns {Promise<{ cancelled: string[], skipped: Array<{ id: string, reason: string }> }>}
 */
const cancelCallbackRequests = async ({ requestIds, performedBy, reason }, { now = new Date() } = {}) => {
    const cancelled = [];
    const skipped = [];

    for (const id of new Set(requestIds)) {
        const request = await CallbackRequest.findOneAndUpdate(
            { requestId: id, status: "pending" },
            { $set: { status: "cancelled", cancelledBy: performedBy, cancelReason: reason, cancelledAt: now } },
            { returnDocument: "after" }
        );

        if (!request) {
            const existing = await CallbackRequest.findOne({ requestId: id }).select({ status: 1, _id: 0 }).lean();
            skipped.push({
                id,
                reason: !existing ? "not_found" : existing.status === "cancelled" ? "already_cancelled" : "not_pending",
            });
            continue;
        }

        // Give the unit of capacity back; the guard keeps the counter from going below zero.
        await CallbackBucket.updateOne(
            { date: request.date, period: request.period, booked: { $gt: 0 } },
            { $inc: { booked: -1 } }
        );

        void notifyCallbackCancelled(request);   // never rejects; failure is logged only

        await recordAudit({
            action: "callback.cancel",
            targetType: "callback_request",
            targetId: id,
            date: request.date,
            detail: { period: request.period },
            performedBy,
            reason,
        }, { now });

        cancelled.push(id);
    }

    return { cancelled, skipped };
};

// ── Request status ────────────────────────────────────────────────────────────

/**
 * Sets a request's status to pending, completed or no_answer. A cancelled request cannot be
 * changed (409 CONFLICT); an unknown one is 404. Setting the status it already has is a
 * no-op that still answers 200 and writes nothing.
 * @returns {Promise<{ requestId: string, status: string }>}
 */
const setCallbackRequestStatus = async (requestId, { status, performedBy }, { now = new Date() } = {}) => {
    const before = await CallbackRequest.findOneAndUpdate(
        { requestId, status: { $nin: ["cancelled", status] } },
        { $set: { status, statusUpdatedBy: performedBy } },
        { returnDocument: "before" }
    );

    if (!before) {
        const existing = await CallbackRequest.findOne({ requestId }).select({ status: 1, _id: 0 }).lean();
        if (!existing) throw new ApiError(404, "NOT_FOUND", "Callback request not found.");
        if (existing.status === "cancelled") {
            throw new ApiError(409, "CONFLICT", "This request was cancelled, so its status can no longer be changed.");
        }
        return { requestId, status };   // already has this status
    }

    await recordAudit({
        action: "callback.status",
        targetType: "callback_request",
        targetId: requestId,
        date: before.date,
        detail: { period: before.period, from: before.status, to: status },
        performedBy,
    }, { now });

    return { requestId, status };
};

export { blockCallbackPeriods, unblockCallbackPeriods, cancelCallbackRequests, setCallbackRequestStatus };
