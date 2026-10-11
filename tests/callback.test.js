import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import {
    startTestEnv,
    stopTestEnv,
    resetState,
    getApp,
    emailOutbox,
    rateLimiting,
    TEST_COMPANY_MAIL,
    TEST_CAPTCHA_TOKEN,
} from "./helpers/setup.js";
import { expireAtFor } from "../src/utils/time.js";

const CALENDAR = "/api/v1/callback/calendar";
const AVAILABILITY = "/api/v1/callback/availability";
const REQUESTS = "/api/v1/callback/requests";

// Wed 14 Oct 2026, 10:30 IST. Requests below are for Thu 15 Oct 2026.
const NOW = "2026-10-14T05:00:00Z";
const DATE = "2026-10-15";

let CallbackBucket;
let CallbackRequest;
let Holiday;
let setCallbackCapacity;

const freezeTime = (iso = NOW) => mock.timers.enable({ apis: ["Date"], now: new Date(iso) });

const validBody = (overrides = {}) => ({
    name: "John Doe",
    email: "john@example.com",
    mobileNumber: "9876543210",
    date: DATE,
    period: "morning",
    reason: "Water testing quote",
    turnstileToken: TEST_CAPTCHA_TOKEN,
    ...overrides,
});

const create = (overrides) => request(getApp()).post(REQUESTS).send(validBody(overrides));
const calendar = (from, to) => request(getApp()).get(CALENDAR).query({ from, to });
const availability = (date) => request(getApp()).get(AVAILABILITY).query({ date });
const day = (res, date) => res.body.data.days.find((d) => d.date === date);
const periodsOf = (res) => Object.fromEntries(res.body.data.periods.map((p) => [p.key, p.available]));

const bucketDoc = (date, period, fields = {}) =>
    CallbackBucket.create({ date, period, expireAt: expireAtFor(date), ...fields });

const waitForEmails = async (count) => {
    for (let i = 0; i < 100 && emailOutbox.all().length < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return emailOutbox.all();
};

describe("callback", () => {
    before(async () => {
        await startTestEnv();
        ({ CallbackBucket } = await import("../src/models/callbackBucket.model.js"));
        ({ CallbackRequest } = await import("../src/models/callbackRequest.model.js"));
        ({ Holiday } = await import("../src/models/holiday.model.js"));
        ({ setCallbackCapacity } = await import("../src/services/settings.service.js"));
    });
    after(stopTestEnv);
    beforeEach(resetState);
    afterEach(() => mock.timers.reset());

    // ── GET /callback/availability ───────────────────────────────────────────
    describe("GET /callback/availability", () => {
        it("lists the three periods, all available on a free working day", async () => {
            freezeTime();

            const res = await availability(DATE);

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, {
                date: DATE,
                bookable: true,
                reason: null,
                periods: [
                    { key: "morning", label: "Morning", timeRange: "9 AM – 12 PM", available: true },
                    { key: "afternoon", label: "Afternoon", timeRange: "12 PM – 3 PM", available: true },
                    { key: "evening", label: "Evening", timeRange: "3 PM – 6 PM", available: true },
                ],
            });
        });

        it("a full period and a blocked period are unavailable, and counts are never exposed", async () => {
            freezeTime();
            await bucketDoc(DATE, "morning", { booked: 5 });                       // capacity 5: full
            await bucketDoc(DATE, "afternoon", { blocked: true, blockedBy: "Anita", blockReason: "Site visit" });
            await bucketDoc(DATE, "evening", { booked: 2 });                       // capacity 3: still open

            const res = await availability(DATE);

            assert.deepEqual(periodsOf(res), { morning: false, afternoon: false, evening: true });
            const raw = JSON.stringify(res.body);
            assert.doesNotMatch(raw, /booked|capacity|blocked|Anita|Site visit|"count"/i);
            for (const period of res.body.data.periods) {
                assert.deepEqual(Object.keys(period).sort(), ["available", "key", "label", "timeRange"]);
            }
        });

        it("a period past its cutoff (1 hour before it ends) is unavailable", async () => {
            freezeTime("2026-10-14T05:30:00Z");   // 11:00 IST today: the morning (ends 12:00) just closed

            const res = await availability("2026-10-14");

            assert.deepEqual(periodsOf(res), { morning: false, afternoon: true, evening: true });
        });

        it("the cutoff is exact: open at 10:59 IST, closed at 11:00 IST", async () => {
            freezeTime("2026-10-14T05:29:00Z");   // 10:59 IST
            assert.equal(periodsOf(await availability("2026-10-14")).morning, true);
            mock.timers.reset();

            freezeTime("2026-10-14T05:30:00Z");   // 11:00 IST
            assert.equal(periodsOf(await availability("2026-10-14")).morning, false);
        });

        it("a day with every period full, blocked or closed is bookable:false 'full' with periods: []", async () => {
            freezeTime();
            await bucketDoc(DATE, "morning", { booked: 5 });
            await bucketDoc(DATE, "afternoon", { blocked: true });
            await bucketDoc(DATE, "evening", { booked: 3 });

            const res = await availability(DATE);

            assert.deepEqual(res.body.data, { date: DATE, bookable: false, reason: "full", periods: [] });
        });

        it("today after the last cutoff is 'full'", async () => {
            freezeTime("2026-10-14T11:30:00Z");   // 17:00 IST: evening (ends 18:00) just closed

            const res = await availability("2026-10-14");

            assert.deepEqual(res.body.data, { date: "2026-10-14", bookable: false, reason: "full", periods: [] });
        });

        it("returns periods: [] with the reason for Sunday, a holiday, the past and the far future", async () => {
            freezeTime();
            await Holiday.create({ date: "2026-10-20", name: "Test holiday" });

            const expectations = [
                ["2026-10-18", "non_working_day"],   // Sunday
                ["2026-10-20", "holiday"],
                ["2026-10-13", "past"],
                ["2026-11-14", "beyond_horizon"],
            ];
            for (const [date, reason] of expectations) {
                const res = await availability(date);

                assert.equal(res.status, 200, date);
                assert.deepEqual(res.body.data, { date, bookable: false, reason, periods: [] }, date);
            }
        });

        it("Saturday is open (3rd Saturday)", async () => {
            freezeTime();

            const res = await availability("2026-10-17");

            assert.equal(res.body.data.bookable, true);
        });

        it("rejects a missing or invalid date with 400 VALIDATION_FAILED", async () => {
            for (const query of [{}, { date: "2026-02-30" }, { date: "tomorrow" }]) {
                const res = await request(getApp()).get(AVAILABILITY).query(query);

                assert.equal(res.status, 400);
                assert.equal(res.body.code, "VALIDATION_FAILED");
                assert.ok(Array.isArray(res.body.errors.date));
            }
        });

        it("reflects a capacity change made by an admin", async () => {
            freezeTime();
            await bucketDoc(DATE, "morning", { booked: 5 });
            assert.equal(periodsOf(await availability(DATE)).morning, false);

            await setCallbackCapacity({ morning: 6, afternoon: 5, evening: 3 });

            assert.equal(periodsOf(await availability(DATE)).morning, true);
        });
    });

    // ── GET /callback/calendar ───────────────────────────────────────────────
    describe("GET /callback/calendar", () => {
        it("returns { date, bookable, reason } per date, with no counts", async () => {
            freezeTime();
            await Holiday.create({ date: "2026-10-20", name: "Test holiday" });

            const res = await calendar("2026-10-13", "2026-10-20");

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data.days.map((d) => d.date), [
                "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20",
            ]);
            assert.deepEqual(day(res, "2026-10-13"), { date: "2026-10-13", bookable: false, reason: "past" });
            assert.deepEqual(day(res, "2026-10-15"), { date: "2026-10-15", bookable: true, reason: null });
            assert.deepEqual(day(res, "2026-10-17"), { date: "2026-10-17", bookable: true, reason: null }, "3rd Saturday is open");
            assert.deepEqual(day(res, "2026-10-18"), { date: "2026-10-18", bookable: false, reason: "non_working_day" });
            assert.deepEqual(day(res, "2026-10-20"), { date: "2026-10-20", bookable: false, reason: "holiday" });
            assert.doesNotMatch(JSON.stringify(res.body), /availableCount|booked|capacity/);
        });

        it("'full' only when every period is full, blocked or closed", async () => {
            freezeTime();
            // 15 Oct: morning full, afternoon blocked, evening still open
            await bucketDoc("2026-10-15", "morning", { booked: 5 });
            await bucketDoc("2026-10-15", "afternoon", { blocked: true });
            // 16 Oct: all three unavailable
            await bucketDoc("2026-10-16", "morning", { booked: 5 });
            await bucketDoc("2026-10-16", "afternoon", { booked: 5 });
            await bucketDoc("2026-10-16", "evening", { blocked: true });

            const res = await calendar("2026-10-15", "2026-10-16");

            assert.deepEqual(day(res, "2026-10-15"), { date: "2026-10-15", bookable: true, reason: null });
            assert.deepEqual(day(res, "2026-10-16"), { date: "2026-10-16", bookable: false, reason: "full" });
        });

        it("today counts as 'full' once every period has passed its cutoff", async () => {
            freezeTime("2026-10-14T11:30:00Z");   // 17:00 IST

            const res = await calendar("2026-10-14", "2026-10-15");

            assert.deepEqual(day(res, "2026-10-14"), { date: "2026-10-14", bookable: false, reason: "full" });
            assert.equal(day(res, "2026-10-15").bookable, true);
        });

        it("zero capacity everywhere makes a working day 'full'", async () => {
            freezeTime();
            await setCallbackCapacity({ morning: 0, afternoon: 0, evening: 0 });

            const res = await calendar("2026-10-15", "2026-10-15");

            assert.deepEqual(day(res, "2026-10-15"), { date: "2026-10-15", bookable: false, reason: "full" });
        });

        it("uses one buckets query and one holidays query for a 62 day range", async () => {
            freezeTime("2026-10-01T05:00:00Z");
            const bucketFind = mock.method(CallbackBucket, "find");
            const holidayFind = mock.method(Holiday, "find");
            const holidayExists = mock.method(Holiday, "exists");
            try {
                const res = await calendar("2026-10-01", "2026-12-01");

                assert.equal(res.status, 200);
                assert.equal(res.body.data.days.length, 62);
                assert.equal(bucketFind.mock.callCount(), 1);
                assert.equal(holidayFind.mock.callCount(), 1);
                assert.equal(holidayExists.mock.callCount(), 0);
            } finally {
                bucketFind.mock.restore();
                holidayFind.mock.restore();
                holidayExists.mock.restore();
            }
        });

        it("rejects more than 62 dates and bad parameters with 400 VALIDATION_FAILED", async () => {
            const tooLong = await calendar("2026-10-01", "2026-12-02");
            assert.equal(tooLong.status, 400);
            assert.equal(tooLong.body.code, "VALIDATION_FAILED");

            for (const query of [{}, { from: "2026-10-01" }, { from: "2026-10-05", to: "2026-10-01" }, { from: "x", to: "y" }]) {
                const res = await request(getApp()).get(CALENDAR).query(query);
                assert.equal(res.status, 400, JSON.stringify(query));
            }
        });
    });

    // ── POST /callback/requests ──────────────────────────────────────────────
    describe("POST /callback/requests", () => {
        it("creates the request: 201, a pending document, one unit of capacity and two emails", async () => {
            freezeTime();

            const res = await create({ email: "  John@Example.COM ", mobileNumber: "98765 43210" });

            assert.equal(res.status, 201);
            assert.equal(res.body.success, true);
            assert.deepEqual(Object.keys(res.body.data).sort(), ["date", "period", "requestId"]);
            assert.match(res.body.data.requestId, /^OE-CB-261015-[2-9A-HJKMNP-TV-Z]{4}$/);
            assert.equal(res.body.data.date, DATE);
            assert.equal(res.body.data.period, "morning");

            const saved = await CallbackRequest.findOne({ requestId: res.body.data.requestId }).lean();
            assert.equal(saved.status, "pending");
            assert.equal(saved.email, "john@example.com");
            assert.equal(saved.mobileNumber, "+919876543210");
            assert.equal(saved.reason, "Water testing quote");
            assert.equal(saved.expireAt.getTime(), expireAtFor(DATE).getTime());
            assert.equal("turnstileToken" in saved, false, "the CAPTCHA token is never stored");

            const bucket = await CallbackBucket.findOne({ date: DATE, period: "morning" }).lean();
            assert.equal(bucket.booked, 1);
            assert.equal(bucket.blocked, false);
            assert.equal(bucket.expireAt.getTime(), expireAtFor(DATE).getTime());

            const mails = await waitForEmails(2);
            assert.equal(mails.length, 2);
            const company = mails.find((m) => m.to === TEST_COMPANY_MAIL);
            const customer = mails.find((m) => m.to === "john@example.com");
            assert.ok(company && customer);
            assert.equal(company.replyTo, "john@example.com");
            assert.ok(company.text.includes("Water testing quote"), "company sees the reason");
            assert.equal(customer.text.includes("Water testing quote"), false, "customer does not");
        });

        it("accepts a request without a reason", async () => {
            freezeTime();

            const res = await create({ reason: undefined });

            assert.equal(res.status, 201);
            assert.equal((await CallbackRequest.findOne().lean()).reason, undefined);
        });

        it("increments the same bucket for each request and uses a separate bucket per period", async () => {
            freezeTime();

            await create({ email: "a@example.com", period: "morning" });
            await create({ email: "b@example.com", period: "morning" });
            await create({ email: "c@example.com", period: "evening" });

            assert.equal((await CallbackBucket.findOne({ date: DATE, period: "morning" })).booked, 2);
            assert.equal((await CallbackBucket.findOne({ date: DATE, period: "evening" })).booked, 1);
            assert.equal(await CallbackBucket.countDocuments(), 2);
        });

        describe("CAPTCHA", () => {
            it("a missing token gives 400 CAPTCHA_FAILED and creates nothing", async () => {
                freezeTime();

                const res = await create({ turnstileToken: undefined });

                assert.equal(res.status, 400);
                assert.equal(res.body.code, "CAPTCHA_FAILED");
                assert.equal(await CallbackRequest.countDocuments(), 0);
                assert.equal(await CallbackBucket.countDocuments(), 0);
                assert.equal(emailOutbox.all().length, 0);
            });

            it("an invalid token gives 400 CAPTCHA_FAILED", async () => {
                freezeTime();

                for (const turnstileToken of ["nope", "", 12345]) {
                    const res = await create({ turnstileToken });

                    assert.equal(res.status, 400, JSON.stringify(turnstileToken));
                    assert.equal(res.body.code, "CAPTCHA_FAILED");
                }
            });

            it("is checked before the body is validated", async () => {
                const res = await request(getApp()).post(REQUESTS).send({ name: "J" });

                assert.equal(res.body.code, "CAPTCHA_FAILED");
            });
        });

        it("rejects invalid fields with 400 VALIDATION_FAILED and per-field errors", async () => {
            freezeTime();
            const cases = [
                [{ name: "J" }, "name"],
                [{ name: undefined }, "name"],
                [{ email: "not-an-email" }, "email"],
                [{ email: undefined }, "email"],
                [{ mobileNumber: "5876543210" }, "mobileNumber"],
                [{ mobileNumber: undefined }, "mobileNumber"],
                [{ date: "2026-02-30" }, "date"],
                [{ date: undefined }, "date"],
                [{ period: "night" }, "period"],
                [{ period: undefined }, "period"],
                [{ reason: "R".repeat(501) }, "reason"],
            ];
            for (const [override, field] of cases) {
                const res = await create(override);

                assert.equal(res.status, 400, `${field} <- ${JSON.stringify(override).slice(0, 40)}`);
                assert.equal(res.body.code, "VALIDATION_FAILED");
                assert.ok(Array.isArray(res.body.errors[field]), `errors.${field}`);
            }
            assert.equal(await CallbackBucket.countDocuments(), 0);
        });

        describe("closed days and periods", () => {
            const expectNotBookable = (res, reason) => {
                assert.equal(res.status, 422);
                assert.equal(res.body.success, false);
                assert.equal(res.body.code, "DATE_NOT_BOOKABLE");
                assert.equal(res.body.errors.reason, reason);
            };

            it("a Sunday gives 422 DATE_NOT_BOOKABLE (non_working_day)", async () => {
                freezeTime();

                expectNotBookable(await create({ date: "2026-10-18" }), "non_working_day");
                assert.equal(await CallbackBucket.countDocuments(), 0);
            });

            it("a holiday, a past date and a date beyond the horizon give 422", async () => {
                freezeTime();
                await Holiday.create({ date: "2026-10-20", name: "Test holiday" });

                expectNotBookable(await create({ date: "2026-10-20" }), "holiday");
                expectNotBookable(await create({ date: "2026-10-13" }), "past");
                expectNotBookable(await create({ date: "2026-11-14" }), "beyond_horizon");
            });

            it("a period past its cutoff gives 422 with reason closed", async () => {
                freezeTime("2026-10-14T05:30:00Z");   // 11:00 IST: morning closed

                expectNotBookable(await create({ date: "2026-10-14", period: "morning" }), "closed");
                assert.equal(await CallbackBucket.countDocuments(), 0);

                const afternoon = await create({ date: "2026-10-14", period: "afternoon", email: "x@example.com" });
                assert.equal(afternoon.status, 201, "the afternoon is still open");
            });
        });

        describe("duplicates", () => {
            it("the same email with a pending request on that date gives 409 DUPLICATE_REQUEST", async () => {
                freezeTime();
                assert.equal((await create({ period: "morning" })).status, 201);

                const same = await create({ period: "morning" });
                const otherPeriod = await create({ period: "evening" });

                for (const res of [same, otherPeriod]) {
                    assert.equal(res.status, 409);
                    assert.equal(res.body.code, "DUPLICATE_REQUEST");
                }
                assert.equal((await CallbackBucket.findOne({ date: DATE, period: "morning" })).booked, 1);
                assert.equal(await CallbackBucket.countDocuments({ date: DATE, period: "evening" }), 0, "no capacity used");
                assert.equal(await CallbackRequest.countDocuments(), 1);
            });

            it("is case-insensitive on the email", async () => {
                freezeTime();
                await create({ email: "john@example.com" });

                const res = await create({ email: "JOHN@Example.com" });

                assert.equal(res.body.code, "DUPLICATE_REQUEST");
            });

            it("a different date, a different email, or a non-pending request does not conflict", async () => {
                freezeTime();
                await create({ email: "john@example.com", date: DATE });

                assert.equal((await create({ email: "john@example.com", date: "2026-10-16" })).status, 201);
                assert.equal((await create({ email: "other@example.com", date: DATE })).status, 201);

                await CallbackRequest.updateMany({ email: "john@example.com", date: DATE }, { $set: { status: "cancelled" } });
                assert.equal((await create({ email: "john@example.com", date: DATE })).status, 201);
            });
        });

        describe("capacity", () => {
            it("a full period gives 409 PERIOD_FULL", async () => {
                freezeTime();
                await bucketDoc(DATE, "morning", { booked: 5 });

                const res = await create();

                assert.equal(res.status, 409);
                assert.equal(res.body.code, "PERIOD_FULL");
                assert.equal((await CallbackBucket.findOne({ date: DATE, period: "morning" })).booked, 5, "unchanged");
                assert.equal(await CallbackRequest.countDocuments(), 0);
            });

            it("a blocked period gives 409 PERIOD_BLOCKED", async () => {
                freezeTime();
                await bucketDoc(DATE, "morning", { blocked: true, blockedBy: "Anita", blockReason: "Site visit" });

                const res = await create();

                assert.equal(res.status, 409);
                assert.equal(res.body.code, "PERIOD_BLOCKED");
                const bucket = await CallbackBucket.findOne({ date: DATE, period: "morning" }).lean();
                assert.equal(bucket.booked, 0);
                assert.equal(bucket.blocked, true);
            });

            it("a blocked period that is also full reports PERIOD_BLOCKED", async () => {
                freezeTime();
                await bucketDoc(DATE, "morning", { blocked: true, booked: 5 });

                assert.equal((await create()).body.code, "PERIOD_BLOCKED");
            });

            it("capacity 0 gives PERIOD_FULL without touching the bucket", async () => {
                freezeTime();
                await setCallbackCapacity({ morning: 0, afternoon: 5, evening: 3 });
                const findOneAndUpdate = mock.method(CallbackBucket, "findOneAndUpdate");
                try {
                    const res = await create();

                    assert.equal(res.status, 409);
                    assert.equal(res.body.code, "PERIOD_FULL");
                    assert.equal(findOneAndUpdate.mock.callCount(), 0, "no claim attempted");
                } finally {
                    findOneAndUpdate.mock.restore();
                }
                assert.equal(await CallbackBucket.countDocuments(), 0);
            });

            it("honours the capacity set by an admin", async () => {
                freezeTime();
                await setCallbackCapacity({ morning: 1, afternoon: 5, evening: 3 });

                assert.equal((await create({ email: "a@example.com" })).status, 201);
                const second = await create({ email: "b@example.com" });

                assert.equal(second.body.code, "PERIOD_FULL");
            });

            it("lowering capacity below what is booked blocks new requests but keeps existing ones", async () => {
                freezeTime();
                await create({ email: "a@example.com" });
                await create({ email: "b@example.com" });
                await setCallbackCapacity({ morning: 1, afternoon: 5, evening: 3 });

                const res = await create({ email: "c@example.com" });

                assert.equal(res.body.code, "PERIOD_FULL");
                assert.equal(await CallbackRequest.countDocuments(), 2);
                assert.equal((await CallbackBucket.findOne({ date: DATE, period: "morning" })).booked, 2);
            });
        });

        describe("concurrency", () => {
            it("capacity 3, 10 parallel requests with different emails: exactly 3 succeed and booked === 3", async () => {
                freezeTime();
                const emails = Array.from({ length: 10 }, (_, i) => `person${i}@example.com`);

                const results = await Promise.all(emails.map((email) => create({ email, period: "evening" })));

                const created = results.filter((r) => r.status === 201);
                const full = results.filter((r) => r.status === 409 && r.body.code === "PERIOD_FULL");
                assert.equal(created.length, 3, `statuses: ${results.map((r) => r.status).join(",")}`);
                assert.equal(full.length, 7);

                const bucket = await CallbackBucket.findOne({ date: DATE, period: "evening" }).lean();
                assert.equal(bucket.booked, 3);
                assert.equal(await CallbackRequest.countDocuments({ date: DATE, period: "evening" }), 3);
                assert.equal(await CallbackBucket.countDocuments({ date: DATE, period: "evening" }), 1, "one bucket only");

                const ids = new Set(created.map((r) => r.body.data.requestId));
                assert.equal(ids.size, 3, "three distinct request IDs");
            });

            it("a burst of 30 requests across the three periods fills each exactly to capacity", async () => {
                freezeTime();
                const periods = ["morning", "afternoon", "evening"];

                const results = await Promise.all(
                    Array.from({ length: 30 }, (_, i) => create({ email: `burst${i}@example.com`, period: periods[i % 3] }))
                );

                // capacities 5 / 5 / 3: 13 can succeed in total
                assert.equal(results.filter((r) => r.status === 201).length, 13);
                const booked = Object.fromEntries(
                    (await CallbackBucket.find({ date: DATE }).lean()).map((b) => [b.period, b.booked])
                );
                assert.deepEqual(booked, { morning: 5, afternoon: 5, evening: 3 });
                assert.equal(await CallbackRequest.countDocuments(), 13);
            });

            it("the first requests of a brand-new bucket race safely (upsert)", async () => {
                freezeTime();

                const results = await Promise.all(
                    Array.from({ length: 5 }, (_, i) => create({ email: `new${i}@example.com`, period: "afternoon" }))
                );

                assert.equal(results.filter((r) => r.status === 201).length, 5);
                assert.equal(await CallbackBucket.countDocuments({ date: DATE, period: "afternoon" }), 1);
                assert.equal((await CallbackBucket.findOne({ date: DATE, period: "afternoon" })).booked, 5);
            });
        });

        describe("failure handling", () => {
            it("gives the capacity back when saving the request fails", async () => {
                freezeTime();
                const createRequest = mock.method(CallbackRequest, "create", async () => {
                    throw new Error("database exploded");
                });

                const failed = await create();
                createRequest.mock.restore();

                assert.equal(failed.status, 500);
                assert.equal(failed.body.success, false);
                assert.equal((await CallbackBucket.findOne({ date: DATE, period: "morning" })).booked, 0, "unit given back");
                assert.equal(await CallbackRequest.countDocuments(), 0);

                const retry = await create();
                assert.equal(retry.status, 201);
                assert.equal((await CallbackBucket.findOne({ date: DATE, period: "morning" })).booked, 1);
            });

            it("a failing email does not fail the request", async () => {
                freezeTime();
                emailOutbox.failNext("company");
                emailOutbox.failNext("customer");

                const res = await create();

                assert.equal(res.status, 201);
                assert.equal(await CallbackRequest.countDocuments(), 1);
            });

            it("retries with a new requestId when the generated one already exists", async () => {
                freezeTime();
                await CallbackRequest.create({
                    requestId: "OE-CB-261015-2222", date: "2026-10-16", period: "morning", name: "Existing Person",
                    email: "existing@example.com", mobileNumber: "+919876543210", status: "cancelled",
                    expireAt: expireAtFor("2026-10-16"),
                });
                let calls = 0;
                const original = crypto.randomInt.bind(crypto);
                const randomInt = mock.method(crypto, "randomInt", (...args) => (calls++ < 4 ? 0 : original(...args)));

                const res = await create();
                randomInt.mock.restore();

                assert.equal(res.status, 201);
                assert.notEqual(res.body.data.requestId, "OE-CB-261015-2222");
                assert.equal((await CallbackBucket.findOne({ date: DATE, period: "morning" })).booked, 1);
            });

            it("gives up after 3 duplicate requestIds and returns the unit", async () => {
                freezeTime();
                await CallbackRequest.create({
                    requestId: "OE-CB-261015-2222", date: "2026-10-16", period: "morning", name: "Existing Person",
                    email: "existing@example.com", mobileNumber: "+919876543210", status: "cancelled",
                    expireAt: expireAtFor("2026-10-16"),
                });
                const randomInt = mock.method(crypto, "randomInt", () => 0);   // always "2222"

                const res = await create();
                const idsGenerated = randomInt.mock.callCount() / 4;
                randomInt.mock.restore();

                assert.equal(res.status, 409);
                assert.equal(res.body.code, "CONFLICT");
                assert.equal(idsGenerated, 3);
                assert.equal((await CallbackBucket.findOne({ date: DATE, period: "morning" })).booked, 0);
                assert.equal(await CallbackRequest.countDocuments({ email: "john@example.com" }), 0);
            });
        });

        it("is rate limited by the shared public form limiter (5 per window)", async () => {
            freezeTime();
            rateLimiting.enable();

            for (let i = 1; i <= 5; i++) {
                const res = await create({ email: `limit${i}@example.com` });
                assert.equal(res.status, 201, `request ${i}`);
            }
            const limited = await create({ email: "limit6@example.com" });

            assert.equal(limited.status, 429);
            assert.equal(limited.body.code, "RATE_LIMITED");
            assert.ok(limited.headers["retry-after"]);
        });
    });
});
