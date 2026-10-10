// Virtual meeting booking. No MongoDB transactions: double booking is prevented by the
// unique { date, time } index on vm_slots, which is claimed BEFORE the booking is saved.
//
// Algorithm (AGENT_CONTEXT.md section 7):
//   1. (route)   body validated, email = req.verifiedEmail from the booking token
//   2. day bookable and slot time open, else 422 DATE_NOT_BOOKABLE
//   3. the email has no confirmed booking dated today or later, else 409 ACTIVE_BOOKING_EXISTS
//   4. claim the slot with VmSlot.create; duplicate key -> 409 SLOT_TAKEN
//   5. VmBooking.create; if it fails, release the claimed slot and rethrow
//   6. Google Meet, then respond 201 and send the emails without waiting for them
//
// Known, accepted gap: if the process dies between steps 4 and 5 the slot stays claimed
// without a booking until its TTL removes it.

import { BOOKING } from "../config/booking.js";
import { VmBooking } from "../models/vmBooking.model.js";
import { VmSlot } from "../models/vmSlot.model.js";
import { ApiError } from "../utils/ApiError.js";
import { generateBookingId } from "../utils/ids.js";
import { logger } from "../utils/logger.js";
import { expireAtFor, istToDate, nowIST } from "../utils/time.js";
import { getVmDayStatus, isVmSlotTimeOpen } from "./calendar.service.js";
import { createMeetEvent, MeetNotConfiguredError } from "./googleCalendar.service.js";
import { notifyVmBooked, notifyVmMeetLink } from "./notify.service.js";

const DUPLICATE_KEY = 11000;
const MAX_ID_ATTEMPTS = 3;

const NOT_BOOKABLE_MESSAGES = {
    past: "That date has already passed. Please pick another date.",
    beyond_horizon: `Bookings can be made up to ${BOOKING.vm.horizonDays} days ahead.`,
    non_working_day: "Virtual meetings are not available on that day. Please pick another date.",
    holiday: "That date is a holiday. Please pick another date.",
    invalid_date: "That is not a valid date.",
    closed: "That time is no longer available. Please pick a later slot.",
};

const notBookable = (reason) =>
    new ApiError(422, "DATE_NOT_BOOKABLE", NOT_BOOKABLE_MESSAGES[reason] ?? NOT_BOOKABLE_MESSAGES.closed, { reason });

const isDuplicateKey = (error) => error?.code === DUPLICATE_KEY;
const isDuplicateBookingId = (error) =>
    isDuplicateKey(error) && Object.hasOwn(error.keyPattern ?? {}, "bookingId");

// Step 6: Google Meet. Best effort and never throws: any problem (not configured, Google
// error, 8 second timeout, no link returned) yields "failed", the booking stays confirmed
// and an admin can retry later with retryMeetForBooking.
const createMeetLink = async (booking) => {
    try {
        const { eventId, meetLink } = await createMeetEvent(booking);
        return { meetStatus: "created", meetLink, googleEventId: eventId };
    } catch (error) {
        const log = error instanceof MeetNotConfiguredError ? logger.warn : logger.error;
        log("Meet link not created", {
            bookingId: booking.bookingId,
            reason: error?.code ?? error?.name ?? "unknown",
        });
        return { meetStatus: "failed", meetLink: null, googleEventId: null };
    }
};

/**
 * Books a virtual meeting slot. Resolves with the data for the 201 response.
 * @param {{ email: string, name: string, mobileNumber: string, organisation?: string,
 *           designation?: string, topic?: string, date: string, time: string }} input
 * @param {{ now?: Date }} [options] pass `now` to freeze time in tests
 */
const createVmBooking = async (input, { now = new Date() } = {}) => {
    const { email, name, mobileNumber, organisation, designation, topic, date, time } = input;

    // 2. Day and time rules
    const day = await getVmDayStatus(date, now);
    if (!day.bookable) throw notBookable(day.reason);
    if (!isVmSlotTimeOpen(date, time, now)) throw notBookable("closed");

    // 3. One active booking per email
    const todayKey = nowIST(now).dateKey;
    const hasActive = await VmBooking.exists({ email, status: "confirmed", date: { $gte: todayKey } });
    if (hasActive) {
        throw new ApiError(
            409,
            "ACTIVE_BOOKING_EXISTS",
            "You already have an upcoming virtual meeting. Please attend or cancel it before booking another."
        );
    }

    // 4. Claim the slot. The unique { date, time } index decides who wins a race.
    let bookingId = generateBookingId(date);
    const expireAt = expireAtFor(date);
    try {
        await VmSlot.create({ date, time, state: "booked", bookingId, expireAt });
    } catch (error) {
        if (isDuplicateKey(error)) {
            throw new ApiError(409, "SLOT_TAKEN", "That slot was just booked. Please pick another.");
        }
        throw error;
    }

    // 5. Save the booking. On any failure the claimed slot is released and the error rethrown.
    //    A duplicate bookingId (extremely rare) gets a new ID, up to MAX_ID_ATTEMPTS in total.
    let booking;
    for (let attempt = 1; ; attempt++) {
        try {
            booking = await VmBooking.create({
                bookingId, date, time, name, email, mobileNumber, organisation, designation, topic,
                status: "confirmed",
                meetStatus: "pending",
                expireAt,
            });
            break;
        } catch (error) {
            if (isDuplicateBookingId(error) && attempt < MAX_ID_ATTEMPTS) {
                const nextId = generateBookingId(date);
                await VmSlot.updateOne({ date, time, bookingId }, { $set: { bookingId: nextId } });
                bookingId = nextId;
                continue;
            }
            await VmSlot.deleteOne({ date, time, bookingId });
            throw error;
        }
    }

    // 6. Google Meet. Never fails the booking.
    const meet = await createMeetLink(booking);
    booking.meetStatus = meet.meetStatus;
    booking.meetLink = meet.meetLink;
    booking.googleEventId = meet.googleEventId;
    try {
        await VmBooking.updateOne(
            { _id: booking._id },
            { $set: { meetStatus: meet.meetStatus, meetLink: meet.meetLink, googleEventId: meet.googleEventId } }
        );
    } catch (error) {
        // The booking is already saved; do not fail it because this follow-up write failed.
        logger.error("Could not record the Meet status", { bookingId, reason: error?.code || error?.name });
    }

    // Emails are fire and forget: notifyVmBooked never rejects and is not awaited.
    void notifyVmBooked(booking);

    return {
        bookingId,
        date,
        time,
        durationMinutes: BOOKING.vm.durationMinutes,
        meetLink: meet.meetLink,
        meetStatus: meet.meetStatus,
    };
};

/**
 * Creates the Meet event for a booking whose link is missing, saves it and emails the
 * customer the link. Used by the admin "retry" action.
 *
 * Errors: NOT_FOUND (404), MEET_ALREADY_CREATED (409), NOT_CANCELLABLE (409: the booking
 * is cancelled or has already started), CONFLICT (409: a retry is already running),
 * MEET_CREATE_FAILED (502: Google failed; the booking stays "failed").
 *
 * @returns {Promise<{ bookingId: string, meetLink: string, meetStatus: "created" }>}
 */
const retryMeetForBooking = async (bookingId, { now = new Date() } = {}) => {
    // Claim the retry atomically so two admins clicking at once create one event.
    const claimed = await VmBooking.findOneAndUpdate(
        { bookingId, status: "confirmed", meetStatus: "failed" },
        { $set: { meetStatus: "pending" } },
        { returnDocument: "after" }
    );

    if (!claimed) {
        const existing = await VmBooking.findOne({ bookingId }).lean();
        if (!existing) throw new ApiError(404, "NOT_FOUND", "Booking not found.");
        if (existing.meetStatus === "created" || existing.meetLink) {
            throw new ApiError(409, "MEET_ALREADY_CREATED", "This booking already has a Meet link.");
        }
        if (existing.status !== "confirmed") {
            throw new ApiError(409, "NOT_CANCELLABLE", "This booking is cancelled, so no Meet link can be created.");
        }
        throw new ApiError(409, "CONFLICT", "A Meet link is already being created for this booking.");
    }

    if (istToDate(claimed.date, claimed.time).getTime() <= now.getTime()) {
        await VmBooking.updateOne({ _id: claimed._id }, { $set: { meetStatus: "failed" } });
        throw new ApiError(409, "NOT_CANCELLABLE", "This meeting has already started, so no Meet link can be created.");
    }

    try {
        const { eventId, meetLink } = await createMeetEvent(claimed);
        await VmBooking.updateOne(
            { _id: claimed._id },
            { $set: { meetStatus: "created", meetLink, googleEventId: eventId } }
        );

        claimed.meetStatus = "created";
        claimed.meetLink = meetLink;
        claimed.googleEventId = eventId;
        void notifyVmMeetLink(claimed);   // fire and forget; never rejects

        return { bookingId, meetLink, meetStatus: "created" };
    } catch (error) {
        // Put the booking back to "failed" so it can be retried again.
        await VmBooking.updateOne({ _id: claimed._id }, { $set: { meetStatus: "failed" } });
        logger.error("Meet retry failed", {
            bookingId,
            reason: error?.code ?? error?.name ?? "unknown",
        });
        throw new ApiError(
            502,
            "MEET_CREATE_FAILED",
            "Could not create the Google Meet link. Please try again in a moment."
        );
    }
};

export { createVmBooking, retryMeetForBooking };
