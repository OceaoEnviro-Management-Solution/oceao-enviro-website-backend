import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
    startTestEnv,
    stopTestEnv,
    resetState,
    emailOutbox,
    TEST_COMPANY_MAIL,
} from "./helpers/setup.js";

let notify;
let VmBooking;

const MAIL_FROM = "Oceao Enviro <no-reply@oceao.test>";

const booking = {
    bookingId: "OE-VM-261015-K7Q2", date: "2026-10-15", time: "10:00", name: "Rahul Kumar",
    email: "rahul@example.com", mobileNumber: "+919876543210", organisation: "ABC Pvt Ltd",
    designation: "Plant Head", topic: "EIA for new unit", meetLink: "https://meet.google.com/abc-defg-hij",
    meetStatus: "created",
};
const callbackRequest = {
    requestId: "OE-CB-261015-M3XZ", date: "2026-10-15", period: "morning", name: "John Doe",
    email: "john@example.com", mobileNumber: "+917654321098", reason: "Water testing quote",
};

describe("notify service", () => {
    before(async () => {
        await startTestEnv();
        notify = await import("../src/services/notify.service.js");
        ({ VmBooking } = await import("../src/models/vmBooking.model.js"));
    });
    after(stopTestEnv);
    beforeEach(resetState);

    describe("notifyVmBooked", () => {
        it("sends the company notification (Reply-To the customer) then the customer confirmation", async () => {
            const result = await notify.notifyVmBooked(booking);

            assert.deepEqual(result, { sent: ["vmNotificationCompany", "vmConfirmationCustomer"], failed: [] });
            const [company, customer, ...rest] = emailOutbox.all();
            assert.equal(rest.length, 0);

            assert.equal(company.to, TEST_COMPANY_MAIL);
            assert.equal(company.replyTo, "rahul@example.com");
            assert.equal(company.from, MAIL_FROM);
            assert.ok(company.text.includes("EIA for new unit"), "company sees the topic");

            assert.equal(customer.to, "rahul@example.com");
            assert.equal(customer.replyTo, undefined);
            assert.equal(customer.from, MAIL_FROM);
            assert.equal(customer.text.includes("EIA for new unit"), false, "customer does not see the topic");
            assert.ok(customer.html.includes("https://meet.google.com/abc-defg-hij"));
        });

        it("tells the customer the link will follow when there is none", async () => {
            await notify.notifyVmBooked({ ...booking, meetLink: null, meetStatus: "failed" });

            const [, customer] = emailOutbox.all();
            assert.match(customer.text, /Your Google Meet link will follow in a separate email\./);
        });

        it("accepts a mongoose document", async () => {
            const doc = new VmBooking({
                ...booking, email: "  RAHUL@Example.com ", expireAt: new Date(Date.now() + 86400000),
            });

            const result = await notify.notifyVmBooked(doc);

            assert.deepEqual(result.failed, []);
            assert.equal(emailOutbox.all()[1].to, "rahul@example.com");
        });
    });

    describe("failure policy", () => {
        it("a failed company email never blocks the customer email, and nothing throws", async () => {
            emailOutbox.failNext("company");

            const result = await notify.notifyVmBooked(booking);

            assert.deepEqual(result, { sent: ["vmConfirmationCustomer"], failed: ["vmNotificationCompany"] });
            assert.equal(emailOutbox.all().length, 1);
            assert.equal(emailOutbox.all()[0].to, "rahul@example.com");
        });

        it("a failed customer email still resolves", async () => {
            emailOutbox.failNext("customer");

            const result = await notify.notifyCallbackRequested(callbackRequest);

            assert.deepEqual(result, { sent: ["callbackNotificationCompany"], failed: ["callbackConfirmationCustomer"] });
        });

        it("resolves even when every email fails", async () => {
            emailOutbox.failNext("any");
            emailOutbox.failNext("any");

            const result = await notify.notifyVmBooked(booking);

            assert.deepEqual(result.sent, []);
            assert.equal(result.failed.length, 2);
            assert.equal(emailOutbox.all().length, 0);
        });

        it("resolves for malformed input instead of throwing", async () => {
            for (const bad of [undefined, null, {}, "text", 42]) {
                for (const fn of [
                    notify.notifyVmBooked, notify.notifyVmCancelled, notify.notifyVmMeetLink,
                    notify.notifyCallbackRequested, notify.notifyCallbackCancelled,
                ]) {
                    const result = await fn(bad);

                    assert.ok(Array.isArray(result.failed), `${fn.name}(${JSON.stringify(bad)})`);
                }
            }
        });

        it("logs an email name and ID, never the address, body or topic", async () => {
            const errors = mock.method(console, "error", () => {});
            try {
                emailOutbox.failNext("customer");
                await notify.notifyVmBooked(booking);

                const logged = errors.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
                assert.match(logged, /vmConfirmationCustomer/);
                assert.match(logged, /OE-VM-261015-K7Q2/);
                assert.doesNotMatch(logged, /rahul@example\.com/);
                assert.doesNotMatch(logged, /EIA for new unit/);
                assert.doesNotMatch(logged, /Simulated/, "no raw error text");
            } finally {
                errors.mock.restore();
            }
        });
    });

    describe("other events", () => {
        it("notifyVmCancelled sends only the customer cancellation", async () => {
            const result = await notify.notifyVmCancelled({ ...booking, cancelReason: "Internal: staff unavailable" });

            assert.deepEqual(result, { sent: ["vmCancellationCustomer"], failed: [] });
            const [mail] = emailOutbox.all();
            assert.equal(mail.to, "rahul@example.com");
            assert.equal(mail.text.includes("Internal: staff unavailable"), false);
        });

        it("notifyVmMeetLink sends the link to the customer", async () => {
            const result = await notify.notifyVmMeetLink(booking);

            assert.deepEqual(result, { sent: ["vmMeetLinkFollowup"], failed: [] });
            assert.ok(emailOutbox.all()[0].text.includes("https://meet.google.com/abc-defg-hij"));
        });

        it("notifyCallbackRequested sends the company notification (Reply-To customer) and confirmation", async () => {
            const result = await notify.notifyCallbackRequested(callbackRequest);

            assert.deepEqual(result.sent, ["callbackNotificationCompany", "callbackConfirmationCustomer"]);
            const [company, customer] = emailOutbox.all();
            assert.equal(company.to, TEST_COMPANY_MAIL);
            assert.equal(company.replyTo, "john@example.com");
            assert.ok(company.text.includes("Water testing quote"));
            assert.equal(customer.to, "john@example.com");
            assert.equal(customer.text.includes("Water testing quote"), false);
        });

        it("notifyCallbackCancelled sends only the customer cancellation", async () => {
            const result = await notify.notifyCallbackCancelled(callbackRequest);

            assert.deepEqual(result, { sent: ["callbackCancellationCustomer"], failed: [] });
            assert.equal(emailOutbox.all()[0].to, "john@example.com");
        });
    });

    describe("sendOtpEmail", () => {
        it("sends the code to the customer", async () => {
            await notify.sendOtpEmail({ email: "rahul@example.com", code: "482913" });

            const [mail, ...rest] = emailOutbox.all();
            assert.equal(rest.length, 0);
            assert.equal(mail.to, "rahul@example.com");
            assert.equal(mail.replyTo, undefined);
            assert.match(mail.text, /482913/);
            assert.match(mail.html, /482913/);
            assert.equal(mail.subject.includes("482913"), false, "the code is not in the subject");
        });

        it("throws ApiError 502 EMAIL_SEND_FAILED when sending fails, without leaking the cause", async () => {
            emailOutbox.failNext("customer");

            await assert.rejects(notify.sendOtpEmail({ email: "rahul@example.com", code: "482913" }), (error) => {
                assert.equal(error.statusCode, 502);
                assert.equal(error.code, "EMAIL_SEND_FAILED");
                assert.doesNotMatch(error.message, /Simulated|482913|rahul@example\.com/);
                return true;
            });
        });

        it("never logs the code or the address", async () => {
            const errors = mock.method(console, "error", () => {});
            const logs = mock.method(console, "log", () => {});
            try {
                emailOutbox.failNext("customer");
                await assert.rejects(notify.sendOtpEmail({ email: "rahul@example.com", code: "482913" }));
                await notify.sendOtpEmail({ email: "rahul@example.com", code: "482913" });

                const logged = [...errors.mock.calls, ...logs.mock.calls].map((call) => call.arguments.join(" ")).join("\n");
                assert.doesNotMatch(logged, /482913/);
                assert.doesNotMatch(logged, /rahul@example\.com/);
            } finally {
                errors.mock.restore();
                logs.mock.restore();
            }
        });
    });
});
