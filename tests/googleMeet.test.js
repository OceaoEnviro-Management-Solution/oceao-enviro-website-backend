import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import request from "supertest";

// The developer's shell may export real Google credentials; tests must not see them.
for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_CALENDAR_ID"]) {
    delete process.env[key];
}

const {
    startTestEnv, stopTestEnv, resetState, getApp, emailOutbox, TEST_BOOKING_TOKEN_SECRET,
    TEST_COMPANY_MAIL, TEST_OTP_SECRET,
} = await import("./helpers/setup.js");
const { expireAtFor } = await import("../src/utils/time.js");

const NOW = "2026-10-14T05:00:00Z";   // Wed 14 Oct 2026, 10:30 IST
const DATE = "2026-10-15";
const LINK = "https://meet.google.com/abc-defg-hij";

let google;      // googleCalendar.service
let booking;     // vmBooking.service
let VmBooking;
let VmSlot;

const freezeTime = () => mock.timers.enable({ apis: ["Date"], now: new Date(NOW) });

const fakeCalendar = ({ insert, remove } = {}) => {
    const calls = { insert: [], delete: [] };
    return {
        calls,
        events: {
            insert: async (params, options) => {
                calls.insert.push({ params, options });
                return insert
                    ? insert(params, options)
                    : { data: { id: "evt-123", hangoutLink: LINK } };
            },
            delete: async (params, options) => {
                calls.delete.push({ params, options });
                return remove ? remove(params, options) : {};
            },
        },
    };
};

const tokenFor = (email) =>
    jwt.sign({ sub: email, purpose: "vm-booking" }, TEST_BOOKING_TOKEN_SECRET, { algorithm: "HS256", expiresIn: 1800 });

const body = (overrides = {}) => ({
    name: "Rahul Kumar", mobileNumber: "9876543210", organisation: "ABC Pvt Ltd", designation: "Plant Head",
    topic: "EIA for new unit", date: DATE, time: "10:00", ...overrides,
});

const book = (email = "rahul@example.com", overrides = {}) =>
    request(getApp()).post("/api/v1/vm/bookings").set("Authorization", `Bearer ${tokenFor(email)}`).send(body(overrides));

const waitForEmails = async (count) => {
    for (let i = 0; i < 100 && emailOutbox.all().length < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return emailOutbox.all();
};

const rejectsWith = async (promise, check) => {
    try {
        await promise;
    } catch (error) {
        check(error);
        return;
    }
    assert.fail("expected the promise to reject");
};

describe("Google Meet", () => {
    before(async () => {
        await startTestEnv();
        google = await import("../src/services/googleCalendar.service.js");
        booking = await import("../src/services/vmBooking.service.js");
        ({ VmBooking } = await import("../src/models/vmBooking.model.js"));
        ({ VmSlot } = await import("../src/models/vmSlot.model.js"));
    });
    after(stopTestEnv);
    beforeEach(resetState);
    afterEach(() => {
        mock.timers.reset();
        google.setCalendarClient(null);
        google.setMeetTimeoutMs();
    });

    describe("createMeetEvent", () => {
        const input = {
            bookingId: "OE-VM-261015-K7Q2", name: "Rahul Kumar", email: "rahul@example.com",
            organisation: "ABC Pvt Ltd", mobileNumber: "+919876543210", topic: "EIA for new unit",
            date: DATE, time: "10:00",
        };

        it("calls events.insert exactly as specified and returns the event ID and Meet link", async () => {
            const client = fakeCalendar();
            google.setCalendarClient(client);

            const result = await google.createMeetEvent(input);

            assert.deepEqual(result, { eventId: "evt-123", meetLink: LINK });
            assert.equal(client.calls.insert.length, 1);
            const { params } = client.calls.insert[0];
            assert.equal(params.calendarId, "primary");
            assert.equal(params.conferenceDataVersion, 1);
            assert.equal(params.sendUpdates, "all");

            const event = params.requestBody;
            assert.equal(event.summary, "Oceao Enviro meeting with Rahul Kumar");
            assert.deepEqual(event.start, { dateTime: "2026-10-15T10:00:00", timeZone: "Asia/Kolkata" });
            assert.deepEqual(event.end, { dateTime: "2026-10-15T11:00:00", timeZone: "Asia/Kolkata" });
            assert.deepEqual(event.attendees, [{ email: "rahul@example.com" }]);
            assert.deepEqual(event.conferenceData, {
                createRequest: { requestId: "OE-VM-261015-K7Q2", conferenceSolutionKey: { type: "hangoutsMeet" } },
            });
            assert.match(event.description, /Organisation: ABC Pvt Ltd/);
            assert.match(event.description, /Mobile: \+919876543210/);
            assert.match(event.description, /Topic: EIA for new unit/);
        });

        it("ends a 16:00 meeting at 17:00 and fills missing optional details with a dash", async () => {
            const client = fakeCalendar();
            google.setCalendarClient(client);

            await google.createMeetEvent({ ...input, time: "16:00", organisation: undefined, topic: undefined });

            const event = client.calls.insert[0].params.requestBody;
            assert.equal(event.start.dateTime, "2026-10-15T16:00:00");
            assert.equal(event.end.dateTime, "2026-10-15T17:00:00");
            assert.match(event.description, /Organisation: -/);
            assert.match(event.description, /Topic: -/);
        });

        it("gives every call an 8 second timeout and an abort signal", async () => {
            const client = fakeCalendar();
            google.setCalendarClient(client);

            await google.createMeetEvent(input);
            await google.deleteEvent("evt-123");

            assert.equal(google.MEET_TIMEOUT_MS, 8000);
            for (const call of [...client.calls.insert, ...client.calls.delete]) {
                assert.equal(call.options.timeout, 8000);
                assert.ok(call.options.signal instanceof AbortSignal);
            }
        });

        it("times out when Google does not answer, and aborts the request", async () => {
            const client = fakeCalendar({ insert: () => new Promise(() => {}) });
            google.setCalendarClient(client);
            google.setMeetTimeoutMs(60);

            const started = Date.now();
            await rejectsWith(google.createMeetEvent(input), (error) => {
                assert.equal(error.name, "MeetTimeoutError");
            });

            assert.ok(Date.now() - started < 2000, "gave up quickly");
            assert.equal(client.calls.insert[0].options.signal.aborted, true);
        });

        it("rejects when the event has no Meet link, and removes the useless event", async () => {
            const client = fakeCalendar({ insert: async () => ({ data: { id: "evt-9" } }) });
            google.setCalendarClient(client);

            await rejectsWith(google.createMeetEvent(input), (error) => {
                assert.equal(error.name, "MeetLinkMissingError");
            });

            assert.equal(client.calls.delete.length, 1);
            assert.equal(client.calls.delete[0].params.eventId, "evt-9");
        });

        it("rejects immediately when Google is not configured", async () => {
            await rejectsWith(google.createMeetEvent(input), (error) => {
                assert.equal(error.name, "MeetNotConfiguredError");
            });
            assert.equal(google.isMeetConfigured(), false);
        });

        it("passes Google's own error through", async () => {
            const client = fakeCalendar({ insert: async () => { throw Object.assign(new Error("quota"), { code: 403 }); } });
            google.setCalendarClient(client);

            await rejectsWith(google.createMeetEvent(input), (error) => assert.equal(error.code, 403));
        });
    });

    describe("deleteEvent", () => {
        it("deletes with sendUpdates all", async () => {
            const client = fakeCalendar();
            google.setCalendarClient(client);

            assert.equal(await google.deleteEvent("evt-123"), true);
            assert.deepEqual(client.calls.delete[0].params, { calendarId: "primary", eventId: "evt-123", sendUpdates: "all" });
        });

        it("never throws: a failure is logged and returns false", async () => {
            google.setCalendarClient(fakeCalendar({ remove: async () => { throw new Error("boom"); } }));
            const errors = mock.method(console, "error", () => {});
            try {
                assert.equal(await google.deleteEvent("evt-123"), false);
                assert.equal(errors.mock.callCount(), 1);
            } finally {
                errors.mock.restore();
            }
        });

        it("treats an event that is already gone as deleted", async () => {
            google.setCalendarClient(fakeCalendar({ remove: async () => { throw Object.assign(new Error("gone"), { code: 404 }); } }));

            assert.equal(await google.deleteEvent("evt-123"), true);
        });

        it("returns false for a missing event ID without calling Google", async () => {
            const client = fakeCalendar();
            google.setCalendarClient(client);

            assert.equal(await google.deleteEvent(undefined), false);
            assert.equal(client.calls.delete.length, 0);
        });
    });

    describe("booking with Meet", () => {
        it("success: stores the event and link, and the response and emails use the link", async () => {
            freezeTime();
            const client = fakeCalendar();
            google.setCalendarClient(client);

            const res = await book();

            assert.equal(res.status, 201);
            assert.equal(res.body.data.meetLink, LINK);
            assert.equal(res.body.data.meetStatus, "created");

            const saved = await VmBooking.findOne({ bookingId: res.body.data.bookingId }).lean();
            assert.equal(saved.meetStatus, "created");
            assert.equal(saved.meetLink, LINK);
            assert.equal(saved.googleEventId, "evt-123");
            assert.equal(saved.status, "confirmed");

            assert.equal(client.calls.insert[0].params.requestBody.conferenceData.createRequest.requestId, res.body.data.bookingId);

            const mails = await waitForEmails(2);
            const customer = mails.find((m) => m.to === "rahul@example.com");
            assert.ok(customer.text.includes(LINK));
            assert.doesNotMatch(customer.text, /will follow/);
        });

        it("Google failure: still 201, meetStatus failed, booking confirmed, bookingId logged", async () => {
            freezeTime();
            google.setCalendarClient(fakeCalendar({ insert: async () => { throw Object.assign(new Error("quota"), { code: 403 }); } }));
            const errors = mock.method(console, "error", () => {});
            let res;
            try {
                res = await book();
                const logged = errors.mock.calls.map((c) => c.arguments.join(" ")).join("\n");

                assert.match(logged, new RegExp(res.body.data.bookingId));
                assert.doesNotMatch(logged, /rahul@example\.com/);
            } finally {
                errors.mock.restore();
            }

            assert.equal(res.status, 201);
            assert.equal(res.body.data.meetStatus, "failed");
            assert.equal(res.body.data.meetLink, null);
            const saved = await VmBooking.findOne({ bookingId: res.body.data.bookingId }).lean();
            assert.equal(saved.status, "confirmed");
            assert.equal(saved.meetStatus, "failed");
            assert.equal(saved.googleEventId, null);
            assert.equal(await VmSlot.countDocuments(), 1, "the slot stays booked");

            const mails = await waitForEmails(2);
            const customer = mails.find((m) => m.to === "rahul@example.com");
            assert.match(customer.text, /Your Google Meet link will follow in a separate email\./);
        });

        it("timeout counts as a failure: 201 with meetStatus failed", async () => {
            freezeTime();
            const client = fakeCalendar({ insert: () => new Promise(() => {}) });
            google.setCalendarClient(client);
            google.setMeetTimeoutMs(80);

            const started = Date.now();
            const res = await book();

            assert.equal(res.status, 201);
            assert.equal(res.body.data.meetStatus, "failed");
            assert.equal(res.body.data.meetLink, null);
            assert.ok(Date.now() - started < 3000);
            assert.equal((await VmBooking.findOne().lean()).status, "confirmed");
        });

        it("not configured: 201 with meetStatus failed, logged as a warning not an error", async () => {
            freezeTime();
            const warnings = mock.method(console, "warn", () => {});
            const errors = mock.method(console, "error", () => {});
            try {
                const res = await book();

                assert.equal(res.status, 201);
                assert.equal(res.body.data.meetStatus, "failed");
                assert.equal(warnings.mock.callCount(), 1);
                assert.equal(errors.mock.callCount(), 0);
            } finally {
                warnings.mock.restore();
                errors.mock.restore();
            }
        });

        it("an event without a link is treated as a failure and cleaned up", async () => {
            freezeTime();
            const client = fakeCalendar({ insert: async () => ({ data: { id: "evt-9" } }) });
            google.setCalendarClient(client);

            const res = await book();

            assert.equal(res.status, 201);
            assert.equal(res.body.data.meetStatus, "failed");
            assert.equal(client.calls.delete.length, 1);
        });
    });

    describe("retryMeetForBooking", () => {
        const failingClient = () =>
            fakeCalendar({ insert: async () => { throw Object.assign(new Error("quota"), { code: 403 }); } });

        // A booking that was created while Google was down.
        const failedBooking = async () => {
            freezeTime();
            google.setCalendarClient(failingClient());
            const errors = mock.method(console, "error", () => {});
            let res;
            try {
                res = await book();
            } finally {
                errors.mock.restore();
            }
            await waitForEmails(2);
            emailOutbox.clear();
            return res.body.data.bookingId;
        };

        it("creates the event, saves it and emails the follow-up link", async () => {
            const bookingId = await failedBooking();
            const client = fakeCalendar();
            google.setCalendarClient(client);

            const result = await booking.retryMeetForBooking(bookingId);

            assert.deepEqual(result, { bookingId, meetLink: LINK, meetStatus: "created" });
            const saved = await VmBooking.findOne({ bookingId }).lean();
            assert.equal(saved.meetStatus, "created");
            assert.equal(saved.meetLink, LINK);
            assert.equal(saved.googleEventId, "evt-123");
            assert.equal(client.calls.insert.length, 1);

            const mails = await waitForEmails(1);
            assert.equal(mails.length, 1);
            assert.equal(mails[0].to, "rahul@example.com");
            assert.match(mails[0].subject, /Your Google Meet Link/);
            assert.ok(mails[0].text.includes(LINK));
            assert.notEqual(mails[0].to, TEST_COMPANY_MAIL);
        });

        it("refuses a booking that already has a link and does not call Google", async () => {
            freezeTime();
            const client = fakeCalendar();
            google.setCalendarClient(client);
            const res = await book();
            client.calls.insert.length = 0;

            await rejectsWith(booking.retryMeetForBooking(res.body.data.bookingId), (error) => {
                assert.equal(error.statusCode, 409);
                assert.equal(error.code, "MEET_ALREADY_CREATED");
            });
            assert.equal(client.calls.insert.length, 0);
        });

        it("answers NOT_FOUND for an unknown booking", async () => {
            google.setCalendarClient(fakeCalendar());

            await rejectsWith(booking.retryMeetForBooking("OE-VM-261015-ZZZZ"), (error) => {
                assert.equal(error.statusCode, 404);
                assert.equal(error.code, "NOT_FOUND");
            });
        });

        it("a Google failure gives MEET_CREATE_FAILED and leaves the booking retryable", async () => {
            const bookingId = await failedBooking();
            google.setCalendarClient(failingClient());
            const errors = mock.method(console, "error", () => {});
            try {
                await rejectsWith(booking.retryMeetForBooking(bookingId), (error) => {
                    assert.equal(error.statusCode, 502);
                    assert.equal(error.code, "MEET_CREATE_FAILED");
                });
            } finally {
                errors.mock.restore();
            }
            assert.equal((await VmBooking.findOne({ bookingId }).lean()).meetStatus, "failed");
            assert.equal(emailOutbox.all().length, 0, "no follow-up email");

            google.setCalendarClient(fakeCalendar());
            const result = await booking.retryMeetForBooking(bookingId);
            assert.equal(result.meetStatus, "created");
        });

        it("refuses a cancelled booking", async () => {
            const bookingId = await failedBooking();
            await VmBooking.updateOne({ bookingId }, { $set: { status: "cancelled" } });
            const client = fakeCalendar();
            google.setCalendarClient(client);

            await rejectsWith(booking.retryMeetForBooking(bookingId), (error) => {
                assert.equal(error.code, "NOT_CANCELLABLE");
            });
            assert.equal(client.calls.insert.length, 0);
        });

        it("refuses a meeting that has already started", async () => {
            const bookingId = await failedBooking();
            const client = fakeCalendar();
            google.setCalendarClient(client);
            const afterStart = new Date("2026-10-15T05:00:00Z");   // 10:30 IST on the meeting day

            await rejectsWith(booking.retryMeetForBooking(bookingId, { now: afterStart }), (error) => {
                assert.equal(error.code, "NOT_CANCELLABLE");
            });
            assert.equal(client.calls.insert.length, 0);
            assert.equal((await VmBooking.findOne({ bookingId }).lean()).meetStatus, "failed");
        });

        it("two simultaneous retries create exactly one event", async () => {
            const bookingId = await failedBooking();
            const client = fakeCalendar({
                insert: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 40));
                    return { data: { id: "evt-1", hangoutLink: LINK } };
                },
            });
            google.setCalendarClient(client);

            const results = await Promise.allSettled([
                booking.retryMeetForBooking(bookingId),
                booking.retryMeetForBooking(bookingId),
            ]);

            assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
            assert.equal(client.calls.insert.length, 1);
            const rejected = results.find((r) => r.status === "rejected");
            assert.ok(["CONFLICT", "MEET_ALREADY_CREATED"].includes(rejected.reason.code));
        });
    });

    describe("boot warning", () => {
        const meetBootWarning = (cfg) => google.meetBootWarning(cfg);

        it("is null when all three credentials are set", () => {
            const cfg = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REFRESH_TOKEN: "token" };

            assert.equal(meetBootWarning(cfg), null);
        });

        it("names every missing variable (never a value) when any of the three is absent", () => {
            const none = meetBootWarning({});
            assert.match(none, /Google Meet links are disabled/);
            for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]) {
                assert.match(none, new RegExp(name));
            }

            const partial = meetBootWarning({ GOOGLE_CLIENT_ID: "super-secret-id", GOOGLE_CLIENT_SECRET: "x" });
            assert.match(partial, /GOOGLE_REFRESH_TOKEN/);
            assert.doesNotMatch(partial, /GOOGLE_CLIENT_ID|super-secret-id/);
        });

        it("GOOGLE_CALENDAR_ID defaults to primary", async () => {
            const { config } = await import("../src/config/env.js");

            assert.equal(config.GOOGLE_CALENDAR_ID, "primary");
        });
    });

    describe("scripts/google-auth.js", () => {
        const scriptPath = fileURLToPath(new URL("../scripts/google-auth.js", import.meta.url));

        const runScript = (visit) =>
            new Promise((resolve, reject) => {
                const child = spawn(process.execPath, [scriptPath], {
                    cwd: os.tmpdir(),   // so dotenv cannot read the real .env
                    env: {
                        PATH: process.env.PATH,
                        SystemRoot: process.env.SystemRoot,
                        NODE_ENV: "test",
                        MONGODB_URI: "mongodb://127.0.0.1:27017",
                        CORS_ORIGINS: "http://localhost:5173",
                        MAIL_FROM: "a@b.c",
                        COMPANY_MAIL: "d@e.f",
                        OTP_SECRET: TEST_OTP_SECRET,
                        BOOKING_TOKEN_SECRET: TEST_BOOKING_TOKEN_SECRET,
                        GOOGLE_CLIENT_ID: "client-id-123.apps.googleusercontent.com",
                        GOOGLE_CLIENT_SECRET: "client-secret-456",
                    },
                });
                let out = "";
                let err = "";
                let visited = false;
                const timer = setTimeout(() => { child.kill(); reject(new Error(`script did not finish:\n${out}\n${err}`)); }, 45000);   // the first import of googleapis is slow on a cold machine

                child.stdout.on("data", async (chunk) => {
                    out += chunk;
                    const match = /(https:\/\/accounts\.google\.com\/\S+)/.exec(out);
                    if (match && !visited) {
                        visited = true;
                        try { await visit(new URL(match[1])); } catch (error) { reject(error); }
                    }
                });
                child.stderr.on("data", (chunk) => (err += chunk));
                child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
            });

        it("prints an offline, consent, calendar.events URL with a loopback redirect, then reports a denied request", async (t) => {
            let consent;
            const result = await runScript(async (url) => {
                consent = url;
                const state = url.searchParams.get("state");
                await fetch(`http://127.0.0.1:5555/?error=access_denied&state=${state}`);
            });
            if (/already in use/.test(result.err)) return t.skip("port 5555 is busy on this machine");

            assert.equal(consent.searchParams.get("access_type"), "offline");
            assert.equal(consent.searchParams.get("prompt"), "consent");
            assert.equal(consent.searchParams.get("scope"), "https://www.googleapis.com/auth/calendar.events");
            assert.equal(consent.searchParams.get("redirect_uri"), "http://127.0.0.1:5555");
            assert.equal(consent.searchParams.get("client_id"), "client-id-123.apps.googleusercontent.com");
            assert.equal(consent.searchParams.get("response_type"), "code");
            assert.ok(consent.searchParams.get("state"));

            assert.equal(result.code, 1);
            assert.match(result.err, /access_denied/);
            assert.doesNotMatch(result.out + result.err, /client-secret-456/, "the secret is never printed");
        });

        it("rejects a redirect whose state does not match", async (t) => {
            const result = await runScript(async () => {
                await fetch("http://127.0.0.1:5555/?code=stolen&state=wrong");
            });
            if (/already in use/.test(result.err)) return t.skip("port 5555 is busy on this machine");

            assert.equal(result.code, 1);
            assert.match(result.err, /state/i);
        });

        it("writes no files", () => {
            const source = fs.readFileSync(scriptPath, "utf8");

            assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream|copyFile|rename\(|from "node:fs"|require\("fs"\)/);
        });
    });
});
