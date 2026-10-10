// Google Calendar / Meet integration (AGENT_CONTEXT.md section 8).
//
// Best effort: callers decide what a failure means (a booking is never failed because of
// Google). Every Google call has an 8 second timeout. With the three Google credentials
// missing the feature is disabled and createMeetEvent rejects immediately.
//
// googleapis is loaded lazily (it is large) and never in tests, which inject a fake
// client with setCalendarClient().

import { BOOKING } from "../config/booking.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { addDays, timeToMinutes } from "../utils/time.js";

export const MEET_TIMEOUT_MS = 8000;
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

const REQUIRED_CREDENTIALS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"];

export class MeetNotConfiguredError extends Error {
    constructor() {
        super("Google Meet is not configured");
        this.name = "MeetNotConfiguredError";
    }
}

export class MeetTimeoutError extends Error {
    constructor(operation, ms) {
        super(`Google Calendar ${operation} timed out after ${ms} ms`);
        this.name = "MeetTimeoutError";
    }
}

export class MeetLinkMissingError extends Error {
    constructor() {
        super("Google Calendar returned no Meet link");
        this.name = "MeetLinkMissingError";
    }
}

let injectedClient = null;
let realClient = null;
let timeoutMs = MEET_TIMEOUT_MS;

/** Test seam: use a fake calendar client ({ events: { insert, delete } }). Pass null to reset. */
export const setCalendarClient = (client) => {
    injectedClient = client ?? null;
};

/** Test seam: change the per-call timeout. Call with no argument to restore 8 seconds. */
export const setMeetTimeoutMs = (ms = MEET_TIMEOUT_MS) => {
    timeoutMs = ms;
};

const missingCredentials = (cfg) => REQUIRED_CREDENTIALS.filter((key) => !cfg[key]);

/** True when Meet links can be created (credentials present, or a client was injected). */
export const isMeetConfigured = (cfg = config) =>
    Boolean(injectedClient) || missingCredentials(cfg).length === 0;

/**
 * The one boot warning when Meet is disabled; null when it is fully configured.
 * Names the missing variables, never their values.
 */
export const meetBootWarning = (cfg = config) => {
    const missing = missingCredentials(cfg);
    if (missing.length === 0) return null;

    return `Google Meet links are disabled: ${missing.join(", ")} not set. Bookings will be created without a Meet link.`;
};

const getClient = async () => {
    if (injectedClient) return injectedClient;
    if (missingCredentials(config).length > 0) throw new MeetNotConfiguredError();

    if (!realClient) {
        const { google } = await import("googleapis");
        const auth = new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET);
        auth.setCredentials({ refresh_token: config.GOOGLE_REFRESH_TOKEN });
        realClient = google.calendar({ version: "v3", auth });
    }
    return realClient;
};

// Runs fn({ signal, timeout }) and rejects with MeetTimeoutError after timeoutMs,
// aborting the underlying request when the client supports it.
const withTimeout = async (operation, fn) => {
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new MeetTimeoutError(operation, timeoutMs));
        }, timeoutMs);
    });

    try {
        return await Promise.race([fn({ signal: controller.signal, timeout: timeoutMs }), timedOut]);
    } finally {
        clearTimeout(timer);
    }
};

const pad = (value) => String(value).padStart(2, "0");

// "2026-10-15" + "10:00" -> { start: "2026-10-15T10:00:00", end: "2026-10-15T11:00:00" } (IST wall clock)
const eventTimes = (date, time) => {
    const endTotal = timeToMinutes(time) + BOOKING.vm.durationMinutes;
    const endDate = addDays(date, Math.floor(endTotal / 1440));
    const endMinutes = endTotal % 1440;

    return {
        start: `${date}T${time}:00`,
        end: `${endDate}T${pad(Math.floor(endMinutes / 60))}:${pad(endMinutes % 60)}:00`,
    };
};

const describeBooking = (booking) =>
    [
        `Organisation: ${booking.organisation || "-"}`,
        `Mobile: ${booking.mobileNumber || "-"}`,
        `Topic: ${booking.topic || "-"}`,
        `Booking ID: ${booking.bookingId}`,
    ].join("\n");

/**
 * Creates a calendar event with a Google Meet conference and invites the customer.
 * @param {{ bookingId: string, name: string, email: string, organisation?: string,
 *           mobileNumber?: string, topic?: string, date: string, time: string }} booking
 * @returns {Promise<{ eventId: string, meetLink: string }>}
 * @throws MeetNotConfiguredError | MeetTimeoutError | MeetLinkMissingError | the Google error
 */
export const createMeetEvent = async (booking) => {
    const calendar = await getClient();
    const { start, end } = eventTimes(booking.date, booking.time);

    const response = await withTimeout("events.insert", (options) =>
        calendar.events.insert(
            {
                calendarId: config.GOOGLE_CALENDAR_ID,
                conferenceDataVersion: 1,
                sendUpdates: "all",
                requestBody: {
                    summary: `Oceao Enviro meeting with ${booking.name}`,
                    description: describeBooking(booking),
                    start: { dateTime: start, timeZone: BOOKING.timezone },
                    end: { dateTime: end, timeZone: BOOKING.timezone },
                    attendees: [{ email: booking.email }],
                    conferenceData: {
                        createRequest: {
                            requestId: booking.bookingId,
                            conferenceSolutionKey: { type: "hangoutsMeet" },
                        },
                    },
                },
            },
            options
        )
    );

    const event = response?.data ?? {};
    if (!event.id) throw new Error("Google Calendar returned no event ID");

    if (!event.hangoutLink) {
        // The event exists but has no link: do not leave a useless invitation behind.
        await deleteEvent(event.id);
        throw new MeetLinkMissingError();
    }

    return { eventId: event.id, meetLink: event.hangoutLink };
};

/**
 * Deletes an event and notifies the attendees. Never throws: a failure is logged and
 * false is returned. An event that is already gone counts as deleted.
 * @returns {Promise<boolean>}
 */
export const deleteEvent = async (eventId) => {
    if (!eventId) return false;

    try {
        const calendar = await getClient();
        await withTimeout("events.delete", (options) =>
            calendar.events.delete(
                { calendarId: config.GOOGLE_CALENDAR_ID, eventId, sendUpdates: "all" },
                options
            )
        );
        return true;
    } catch (error) {
        const status = error?.code ?? error?.status ?? error?.response?.status;
        if (status === 404 || status === 410) return true;

        logger.error("Could not delete the Google Calendar event", {
            reason: error?.code ?? error?.name ?? "unknown",
        });
        return false;
    }
};
