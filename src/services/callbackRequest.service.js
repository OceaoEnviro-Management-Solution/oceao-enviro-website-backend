// Callback requests. No MongoDB transactions: capacity is claimed with ONE atomic
// findOneAndUpdate on the (date, period) bucket (AGENT_CONTEXT.md section 7).
//
//   1. (route)   captcha verified, body validated
//   2. day bookable and period still open, else 422 DATE_NOT_BOOKABLE
//   3. the email has no pending request on that date, else 409 DUPLICATE_REQUEST
//   4. claim one unit of capacity atomically; none left -> 409 PERIOD_FULL / PERIOD_BLOCKED
//   5. insert the request; if that fails, give the unit back and rethrow
//   6. respond 201 and email without waiting
//
// Known, accepted gap: if the process dies between steps 4 and 5 one unit of capacity
// stays used until the bucket's TTL removes it.

import { CallbackBucket } from "../models/callbackBucket.model.js";
import { CallbackRequest } from "../models/callbackRequest.model.js";
import { ApiError } from "../utils/ApiError.js";
import { generateRequestId } from "../utils/ids.js";
import { expireAtFor } from "../utils/time.js";
import { getCallbackDayStatus, isCallbackPeriodOpen } from "./calendar.service.js";
import { notifyCallbackRequested } from "./notify.service.js";
import { getCallbackCapacity } from "./settings.service.js";

const DUPLICATE_KEY = 11000;
const MAX_ID_ATTEMPTS = 3;

const NOT_BOOKABLE_MESSAGES = {
    past: "That date has already passed. Please pick another date.",
    beyond_horizon: "That date is too far ahead. Please pick an earlier date.",
    non_working_day: "Callbacks are not available on that day. Please pick another date.",
    holiday: "That date is a holiday. Please pick another date.",
    invalid_date: "That is not a valid date.",
    closed: "That time window is no longer available. Please pick a later one.",
};

const notBookable = (reason) =>
    new ApiError(422, "DATE_NOT_BOOKABLE", NOT_BOOKABLE_MESSAGES[reason] ?? NOT_BOOKABLE_MESSAGES.closed, { reason });

const isDuplicateKey = (error) => error?.code === DUPLICATE_KEY;
const isDuplicateRequestId = (error) =>
    isDuplicateKey(error) && Object.hasOwn(error.keyPattern ?? {}, "requestId");

const periodFull = () =>
    new ApiError(409, "PERIOD_FULL", "That time window is full. Please pick another one.");
const periodBlocked = () =>
    new ApiError(409, "PERIOD_BLOCKED", "That time window is not available. Please pick another one.");

// Step 4. Resolves when one unit of capacity is claimed; otherwise throws PERIOD_FULL / PERIOD_BLOCKED.
const claimCapacity = async (date, period, expireAt) => {
    const capacity = (await getCallbackCapacity())[period];
    if (capacity === 0) throw periodFull();   // nothing to claim, no need to try

    try {
        const bucket = await CallbackBucket.findOneAndUpdate(
            { date, period, blocked: false, booked: { $lt: capacity } },
            { $inc: { booked: 1 }, $setOnInsert: { expireAt } },
            { upsert: true, returnDocument: "after" }
        );
        if (bucket) return;
    } catch (error) {
        if (!isDuplicateKey(error)) throw error;
    }

    // The filter did not match an existing bucket (and the upsert hit the unique index):
    // it is full or blocked. Look to say which.
    const existing = await CallbackBucket.findOne({ date, period }).lean();
    throw existing?.blocked ? periodBlocked() : periodFull();
};

// Gives one unit of capacity back; never goes below zero.
const releaseCapacity = (date, period) =>
    CallbackBucket.updateOne({ date, period, booked: { $gt: 0 } }, { $inc: { booked: -1 } });

/**
 * Creates a callback request. Resolves with the data for the 201 response.
 * @param {{ name: string, email: string, mobileNumber: string, date: string, period: string, reason?: string }} input
 * @param {{ now?: Date }} [options] pass `now` to freeze time in tests
 */
const createCallbackRequest = async (input, { now = new Date() } = {}) => {
    const { name, email, mobileNumber, date, period, reason } = input;

    // 2. Day and period rules
    const day = await getCallbackDayStatus(date, now);
    if (!day.bookable) throw notBookable(day.reason);
    if (!isCallbackPeriodOpen(date, period, now)) throw notBookable("closed");

    // 3. One pending request per email per date
    const duplicate = await CallbackRequest.exists({ email, date, status: "pending" });
    if (duplicate) {
        throw new ApiError(
            409,
            "DUPLICATE_REQUEST",
            "You already have a pending callback request for that date."
        );
    }

    // 4. Claim capacity atomically
    const expireAt = expireAtFor(date);
    await claimCapacity(date, period, expireAt);

    // 5. Save the request. On any failure the claimed capacity is given back and the error rethrown.
    //    A duplicate requestId (extremely rare) gets a new ID, up to MAX_ID_ATTEMPTS in total.
    let request;
    for (let attempt = 1; ; attempt++) {
        const requestId = generateRequestId(date);
        try {
            request = await CallbackRequest.create({
                requestId, date, period, name, email, mobileNumber, reason,
                status: "pending",
                expireAt,
            });
            break;
        } catch (error) {
            if (isDuplicateRequestId(error) && attempt < MAX_ID_ATTEMPTS) continue;
            await releaseCapacity(date, period);
            throw error;
        }
    }

    // 6. Emails are fire and forget: notifyCallbackRequested never rejects and is not awaited.
    void notifyCallbackRequested(request);

    return { requestId: request.requestId, date, period };
};

export { createCallbackRequest };
