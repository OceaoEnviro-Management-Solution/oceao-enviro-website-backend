import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { startTestEnv, stopTestEnv, resetState } from "./helpers/setup.js";
import {
    generateBookingId,
    generateRequestId,
    ID_ALPHABET,
    BOOKING_ID_PATTERN,
    REQUEST_ID_PATTERN,
} from "../src/utils/ids.js";
import { expireAtFor } from "../src/utils/time.js";

let models;

const EXPIRE_AT = expireAtFor("2026-10-15");

const slot = (overrides = {}) => ({
    date: "2026-10-15", time: "10:00", state: "booked", bookingId: "OE-VM-261015-K7Q2", expireAt: EXPIRE_AT, ...overrides,
});
const booking = (overrides = {}) => ({
    bookingId: "OE-VM-261015-K7Q2", date: "2026-10-15", time: "10:00", name: "Rahul Kumar",
    email: "rahul@example.com", mobileNumber: "+919876543210", expireAt: EXPIRE_AT, ...overrides,
});
const bucket = (overrides = {}) => ({ date: "2026-10-15", period: "morning", expireAt: EXPIRE_AT, ...overrides });
const callback = (overrides = {}) => ({
    requestId: "OE-CB-261015-M3XZ", date: "2026-10-15", period: "morning", name: "John Doe",
    email: "john@example.com", mobileNumber: "+917654321098", expireAt: EXPIRE_AT, ...overrides,
});
const otp = (overrides = {}) => ({
    email: "user@example.com", codeHash: "hash", codeExpiresAt: new Date(), windowStartedAt: new Date(),
    lastSentAt: new Date(), expireAt: new Date(Date.now() + 3600 * 1000), ...overrides,
});

const isDuplicateKey = (error) => error.code === 11000;
const isValidationError = (field) => (error) => error.name === "ValidationError" && field in error.errors;

describe("models", () => {
    before(async () => {
        await startTestEnv();
        models = await import("../src/models/index.js");
    });
    after(stopTestEnv);
    beforeEach(resetState);

    describe("cleanup", () => {
        it("the obsolete client and slot models are gone and the new files exist", () => {
            const dir = new URL("../src/models/", import.meta.url);
            const files = fs.readdirSync(dir);

            for (const removed of ["client.model.js", "slot.model.js", "vmbooking.model.js"]) {
                assert.equal(files.includes(removed), false, `${removed} should not exist`);
            }
            for (const present of ["vmSlot.model.js", "vmBooking.model.js", "callbackBucket.model.js",
                "callbackRequest.model.js", "otpChallenge.model.js"]) {
                assert.equal(files.includes(present), true, `${present} should exist`);
            }
        });

        it("uses the documented collection names", () => {
            assert.equal(models.VmSlot.collection.name, "vm_slots");
            assert.equal(models.VmBooking.collection.name, "vm_bookings");
            assert.equal(models.CallbackBucket.collection.name, "callback_buckets");
            assert.equal(models.CallbackRequest.collection.name, "callback_requests");
            assert.equal(models.OtpChallenge.collection.name, "otp_challenges");
        });
    });

    describe("unique indexes", () => {
        it("rejects a duplicate (date, time) in vm_slots, even for a blocked slot", async () => {
            await models.VmSlot.create(slot());

            await assert.rejects(models.VmSlot.create(slot({ bookingId: "OE-VM-261015-AAAA" })), isDuplicateKey);
            await assert.rejects(
                models.VmSlot.create(slot({ state: "blocked", bookingId: undefined, blockedBy: "Anita", blockReason: "Site visit" })),
                isDuplicateKey
            );
            assert.equal(await models.VmSlot.countDocuments(), 1);
        });

        it("allows the same time on another date and another time on the same date", async () => {
            await models.VmSlot.create(slot());
            await models.VmSlot.create(slot({ date: "2026-10-16", bookingId: "OE-VM-261016-AAAA" }));
            await models.VmSlot.create(slot({ time: "12:00", bookingId: "OE-VM-261015-BBBB" }));

            assert.equal(await models.VmSlot.countDocuments(), 3);
        });

        it("rejects a duplicate (date, period) callback bucket", async () => {
            await models.CallbackBucket.create(bucket());

            await assert.rejects(models.CallbackBucket.create(bucket({ booked: 2 })), isDuplicateKey);
            await models.CallbackBucket.create(bucket({ period: "evening" }));
            assert.equal(await models.CallbackBucket.countDocuments(), 2);
        });

        it("rejects a duplicate bookingId, requestId and otp email", async () => {
            await models.VmBooking.create(booking());
            await assert.rejects(models.VmBooking.create(booking({ time: "12:00" })), isDuplicateKey);

            await models.CallbackRequest.create(callback());
            await assert.rejects(models.CallbackRequest.create(callback({ period: "evening" })), isDuplicateKey);

            await models.OtpChallenge.create(otp());
            await assert.rejects(models.OtpChallenge.create(otp({ codeHash: "other" })), isDuplicateKey);
        });
    });

    describe("TTL and secondary indexes", () => {
        const ttlModels = ["VmSlot", "VmBooking", "CallbackBucket", "CallbackRequest", "OtpChallenge"];

        for (const name of ttlModels) {
            it(`${name} has a TTL index on expireAt with expireAfterSeconds 0`, async () => {
                const indexes = await models[name].collection.indexes();
                const ttl = indexes.find((index) => index.key.expireAt === 1);

                assert.ok(ttl, "expireAt index exists");
                assert.deepEqual(ttl.key, { expireAt: 1 });
                assert.equal(ttl.expireAfterSeconds, 0);
            });
        }

        it("has the documented unique and compound indexes", async () => {
            const keysOf = async (model) =>
                (await model.collection.indexes()).map((index) => ({ key: index.key, unique: Boolean(index.unique) }));
            const has = (list, key, unique) =>
                list.some((index) => JSON.stringify(index.key) === JSON.stringify(key) && index.unique === unique);

            const slotIndexes = await keysOf(models.VmSlot);
            assert.ok(has(slotIndexes, { date: 1, time: 1 }, true));

            const bookingIndexes = await keysOf(models.VmBooking);
            assert.ok(has(bookingIndexes, { bookingId: 1 }, true));
            assert.ok(has(bookingIndexes, { email: 1, status: 1, date: 1 }, false));
            assert.ok(has(bookingIndexes, { date: 1, time: 1 }, false));

            const bucketIndexes = await keysOf(models.CallbackBucket);
            assert.ok(has(bucketIndexes, { date: 1, period: 1 }, true));

            const requestIndexes = await keysOf(models.CallbackRequest);
            assert.ok(has(requestIndexes, { requestId: 1 }, true));
            assert.ok(has(requestIndexes, { date: 1, period: 1 }, false));
            assert.ok(has(requestIndexes, { email: 1, date: 1, status: 1 }, false));

            const otpIndexes = await keysOf(models.OtpChallenge);
            assert.ok(has(otpIndexes, { email: 1 }, true));
        });
    });

    describe("validation", () => {
        it("rejects values outside the enums", async () => {
            await assert.rejects(models.VmSlot.create(slot({ time: "11:00" })), isValidationError("time"));
            await assert.rejects(models.VmSlot.create(slot({ state: "free" })), isValidationError("state"));
            await assert.rejects(models.VmBooking.create(booking({ time: "09:00" })), isValidationError("time"));
            await assert.rejects(models.VmBooking.create(booking({ status: "completed" })), isValidationError("status"));
            await assert.rejects(models.VmBooking.create(booking({ meetStatus: "ok" })), isValidationError("meetStatus"));
            await assert.rejects(models.CallbackBucket.create(bucket({ period: "night" })), isValidationError("period"));
            await assert.rejects(models.CallbackRequest.create(callback({ period: "night" })), isValidationError("period"));
            await assert.rejects(models.CallbackRequest.create(callback({ status: "done" })), isValidationError("status"));
            assert.equal(await models.VmSlot.countDocuments(), 0);
        });

        it("requires bookingId for a booked slot but not for a blocked one", async () => {
            await assert.rejects(models.VmSlot.create(slot({ bookingId: undefined })), isValidationError("bookingId"));

            const blocked = await models.VmSlot.create(
                slot({ state: "blocked", bookingId: undefined, blockedBy: "Anita", blockReason: "Site visit", blockedAt: new Date() })
            );
            assert.equal(blocked.bookingId, undefined);
        });

        it("rejects invalid dates, IDs, mobile numbers and negative or fractional counters", async () => {
            await assert.rejects(models.VmSlot.create(slot({ date: "2026-02-30" })), isValidationError("date"));
            await assert.rejects(models.VmBooking.create(booking({ bookingId: "BOOKING-1" })), isValidationError("bookingId"));
            await assert.rejects(models.VmBooking.create(booking({ bookingId: "OE-VM-261015-K7Q0" })), isValidationError("bookingId"));
            await assert.rejects(models.VmBooking.create(booking({ mobileNumber: "9876543210" })), isValidationError("mobileNumber"));
            await assert.rejects(models.CallbackRequest.create(callback({ requestId: "OE-VM-261015-M3XZ" })), isValidationError("requestId"));
            await assert.rejects(models.CallbackBucket.create(bucket({ booked: -1 })), isValidationError("booked"));
            await assert.rejects(models.CallbackBucket.create(bucket({ booked: 1.5 })), isValidationError("booked"));
        });

        it("requires expireAt on every TTL model", async () => {
            await assert.rejects(models.VmSlot.create(slot({ expireAt: undefined })), isValidationError("expireAt"));
            await assert.rejects(models.VmBooking.create(booking({ expireAt: undefined })), isValidationError("expireAt"));
            await assert.rejects(models.CallbackBucket.create(bucket({ expireAt: undefined })), isValidationError("expireAt"));
            await assert.rejects(models.CallbackRequest.create(callback({ expireAt: undefined })), isValidationError("expireAt"));
            await assert.rejects(models.OtpChallenge.create(otp({ expireAt: undefined })), isValidationError("expireAt"));
        });

        it("applies defaults", async () => {
            const savedBooking = await models.VmBooking.create(booking());
            const savedBucket = await models.CallbackBucket.create(bucket());
            const savedRequest = await models.CallbackRequest.create(callback());

            assert.equal(savedBooking.status, "confirmed");
            assert.equal(savedBooking.meetStatus, "pending");
            assert.equal(savedBooking.meetLink, null);
            assert.equal(savedBooking.googleEventId, null);
            assert.equal(savedBucket.booked, 0);
            assert.equal(savedBucket.blocked, false);
            assert.equal(savedRequest.status, "pending");
        });
    });

    describe("schema options", () => {
        it("trims and lowercases emails", async () => {
            const savedBooking = await models.VmBooking.create(booking({ email: "  Rahul.Kumar@Example.COM " }));
            const savedRequest = await models.CallbackRequest.create(callback({ email: " JOHN@Example.com" }));
            const savedOtp = await models.OtpChallenge.create(otp({ email: "  User@EXAMPLE.com  " }));

            assert.equal(savedBooking.email, "rahul.kumar@example.com");
            assert.equal(savedRequest.email, "john@example.com");
            assert.equal(savedOtp.email, "user@example.com");
        });

        it("stores a differently-cased email as the same OTP challenge", async () => {
            await models.OtpChallenge.create(otp({ email: "user@example.com" }));

            await assert.rejects(models.OtpChallenge.create(otp({ email: "USER@example.com" })), isDuplicateKey);
        });

        it("is strict: unknown fields are not stored", async () => {
            const saved = await models.VmBooking.create({ ...booking(), isAdmin: true, notes: "hello" });
            const raw = await models.VmBooking.collection.findOne({ _id: saved._id });

            assert.equal("isAdmin" in raw, false);
            assert.equal("notes" in raw, false);
        });

        it("adds createdAt and updatedAt", async () => {
            const saved = await models.VmSlot.create(slot());
            const raw = await models.VmSlot.collection.findOne({ _id: saved._id });

            assert.ok(raw.createdAt instanceof Date);
            assert.ok(raw.updatedAt instanceof Date);
        });
    });

    describe("ID generator", () => {
        it("generateBookingId returns OE-VM-YYMMDD-XXXX", () => {
            const id = generateBookingId("2026-10-15");

            assert.match(id, /^OE-VM-261015-[2-9A-HJKMNP-TV-Z]{4}$/);
            assert.match(id, BOOKING_ID_PATTERN);
        });

        it("generateRequestId returns OE-CB-YYMMDD-XXXX", () => {
            const id = generateRequestId("2027-01-05");

            assert.match(id, /^OE-CB-270105-[2-9A-HJKMNP-TV-Z]{4}$/);
            assert.match(id, REQUEST_ID_PATTERN);
        });

        it("only ever uses the 30-character alphabet", () => {
            assert.equal(ID_ALPHABET, "23456789ABCDEFGHJKMNPQRSTVWXYZ");
            assert.equal(ID_ALPHABET.length, 30);

            const seen = new Set();
            for (let i = 0; i < 2000; i++) {
                const suffix = generateBookingId("2026-10-15").slice(-4);
                for (const char of suffix) seen.add(char);
            }
            for (const char of seen) assert.ok(ID_ALPHABET.includes(char), `unexpected character ${char}`);
            assert.ok(seen.size > 20, "uses a wide range of the alphabet");
            for (const ambiguous of ["0", "1", "O", "I", "L", "U"]) assert.equal(seen.has(ambiguous), false);
        });

        it("draws each character with crypto.randomInt(0, 30)", () => {
            const randomInt = mock.method(crypto, "randomInt", () => 0);
            try {
                const id = generateBookingId("2026-10-15");

                assert.equal(id, "OE-VM-261015-2222");
                assert.equal(randomInt.mock.callCount(), 4);
                for (const call of randomInt.mock.calls) assert.deepEqual(call.arguments, [0, 30]);
            } finally {
                randomInt.mock.restore();
            }
        });

        it("produces different IDs", () => {
            const ids = new Set(Array.from({ length: 200 }, () => generateRequestId("2026-10-15")));

            assert.ok(ids.size > 190);
        });

        it("rejects an invalid dateKey", () => {
            for (const bad of ["2026-02-30", "15-10-2026", "", null, undefined]) {
                assert.throws(() => generateBookingId(bad), RangeError, String(bad));
                assert.throws(() => generateRequestId(bad), RangeError, String(bad));
            }
        });

        it("IDs it generates pass the model validation", async () => {
            const saved = await models.VmBooking.create(booking({ bookingId: generateBookingId("2026-10-15") }));
            const request = await models.CallbackRequest.create(callback({ requestId: generateRequestId("2026-10-15") }));

            assert.match(saved.bookingId, BOOKING_ID_PATTERN);
            assert.match(request.requestId, REQUEST_ID_PATTERN);
        });
    });
});
