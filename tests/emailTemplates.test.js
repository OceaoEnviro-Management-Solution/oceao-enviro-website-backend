import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    otpCodeTemplate,
    vmConfirmationCustomerTemplate,
    vmNotificationCompanyTemplate,
    vmCancellationCustomerTemplate,
    vmMeetLinkFollowupTemplate,
    callbackConfirmationCustomerTemplate,
    callbackNotificationCompanyTemplate,
    callbackCancellationCustomerTemplate,
} from "../src/services/email/templates/booking/index.js";
import { renderLayout } from "../src/services/email/templates/layout.js";
import { formatDateLabel, formatTimeLabel, formatPeriodLabel } from "../src/services/email/templates/booking/shared.js";

// Pure functions: no database or app needed.

const HOSTILE_NAME = "<script>alert(1)</script> & \"Co\"";
const HOSTILE = (label) => `"><img src=x onerror=alert('${label}')>`;
const MEET_LINK = "https://meet.google.com/abc-defg-hij";

const base = {
    bookingId: "OE-VM-261015-K7Q2",
    requestId: "OE-CB-261015-M3XZ",
    date: "2026-10-15",
    time: "10:00",
    period: "morning",
    name: HOSTILE_NAME,
    email: "rahul@example.com",
    mobileNumber: "+919876543210",
    organisation: HOSTILE("org"),
    designation: HOSTILE("designation"),
    topic: HOSTILE("topic"),
    reason: HOSTILE("reason"),
    meetLink: MEET_LINK,
    meetStatus: "created",
};

// name -> [render, isCompany]
const templates = {
    otpCode: [() => otpCodeTemplate({ code: "<script>1</script>" }), false],
    vmConfirmationCustomer: [() => vmConfirmationCustomerTemplate(base), false],
    vmNotificationCompany: [() => vmNotificationCompanyTemplate(base), true],
    vmCancellationCustomer: [() => vmCancellationCustomerTemplate(base), false],
    vmMeetLinkFollowup: [() => vmMeetLinkFollowupTemplate(base), false],
    callbackConfirmationCustomer: [() => callbackConfirmationCustomerTemplate(base), false],
    callbackNotificationCompany: [() => callbackNotificationCompanyTemplate(base), true],
    callbackCancellationCustomer: [() => callbackCancellationCustomerTemplate(base), false],
};

const ENTITY = /&(lt|gt|amp|quot|#0?39);/;

describe("booking email templates", () => {
    it("there are eight templates and each returns { subject, text, html }", () => {
        assert.equal(Object.keys(templates).length, 8);

        for (const [name, [render]] of Object.entries(templates)) {
            const result = render();

            assert.deepEqual(Object.keys(result).sort(), ["html", "subject", "text"], name);
            for (const key of ["subject", "text", "html"]) {
                assert.equal(typeof result[key], "string", `${name}.${key}`);
                assert.ok(result[key].length > 0, `${name}.${key} is not empty`);
            }
        }
    });

    describe("escaping", () => {
        for (const [name, [render]] of Object.entries(templates)) {
            it(`${name}: user values are escaped in the HTML`, () => {
                const { html } = render();

                assert.doesNotMatch(html, /<script>/i, "no raw <script>");
                assert.doesNotMatch(html, /<img/i, "no raw <img>");
                assert.doesNotMatch(html, /onerror=alert\('[a-z]+'\)>/, "no raw event-handler tag");
                assert.match(html, /&lt;script&gt;/, "the <script> value is shown escaped");
            });
        }

        it("escapes every field of the company notifications", () => {
            const vm = vmNotificationCompanyTemplate(base).html;
            const cb = callbackNotificationCompanyTemplate(base).html;

            for (const html of [vm, cb]) {
                assert.match(html, /&quot;&gt;&lt;img src=x onerror=alert\(&#039;reason&#039;\)|&quot;&gt;&lt;img src=x onerror=alert\(&#039;topic&#039;\)/);
                assert.match(html, /&amp; &quot;Co&quot;/);
            }
            assert.match(vm, /alert\(&#039;org&#039;\)/);
            assert.match(vm, /alert\(&#039;designation&#039;\)/);
            assert.match(vm, /alert\(&#039;topic&#039;\)/);
            assert.match(cb, /alert\(&#039;reason&#039;\)/);
        });

        it("escapes the Meet link and rejects non-http links", () => {
            const tricky = vmConfirmationCustomerTemplate({ ...base, meetLink: `${MEET_LINK}?a=1&b=2` });
            assert.match(tricky.html, /href="https:\/\/meet\.google\.com\/abc-defg-hij\?a=1&amp;b=2"/);

            for (const bad of ["javascript:alert(1)", "data:text/html,<script>1</script>", `${MEET_LINK}" onclick="x`, "meet.google.com/x"]) {
                const result = vmConfirmationCustomerTemplate({ ...base, meetLink: bad });

                assert.doesNotMatch(result.html, /<a /, `no link for ${bad}`);
                assert.match(result.text, /will follow in a separate email/);
            }
        });

        it("keeps raw values in the plain-text bodies", () => {
            const { text } = vmNotificationCompanyTemplate(base);

            assert.ok(text.includes(HOSTILE_NAME));
            assert.ok(text.includes(base.topic));
            assert.doesNotMatch(text, ENTITY);
        });
    });

    describe("subjects", () => {
        for (const [name, [render]] of Object.entries(templates)) {
            it(`${name}: no HTML entities and no line breaks`, () => {
                const { subject } = render();

                assert.doesNotMatch(subject, ENTITY);
                assert.doesNotMatch(subject, /&lt;|&amp;/);
                assert.doesNotMatch(subject, /[\r\n]/);
            });
        }

        it("company subjects use the raw name, with line breaks removed", () => {
            const evil = { ...base, name: "A & B <b>x</b>\r\nBcc: attacker@example.com" };

            for (const subject of [
                vmNotificationCompanyTemplate(evil).subject,
                callbackNotificationCompanyTemplate(evil).subject,
            ]) {
                assert.match(subject, /A & B <b>x<\/b> Bcc: attacker@example\.com/);
                assert.doesNotMatch(subject, /[\r\n]/);
                assert.doesNotMatch(subject, /&amp;|&lt;/);
            }
        });

        it("a very long name is truncated in the subject", () => {
            const { subject } = vmNotificationCompanyTemplate({ ...base, name: "N".repeat(500) });

            assert.ok(subject.length < 160, `subject length ${subject.length}`);
        });
    });

    describe("vmConfirmationCustomer", () => {
        it("with a Meet link: shows the link and not the 'will follow' message", () => {
            const { html, text, subject } = vmConfirmationCustomerTemplate(base);

            assert.match(html, /<a href="https:\/\/meet\.google\.com\/abc-defg-hij"/);
            assert.ok(html.includes(MEET_LINK));
            assert.ok(text.includes(`Join with Google Meet: ${MEET_LINK}`));
            assert.doesNotMatch(html, /will follow/);
            assert.doesNotMatch(text, /will follow/);
            assert.match(subject, /Thu, 15 Oct 2026, 10:00 AM IST/);
        });

        it("without a Meet link: says the link will follow", () => {
            for (const meetLink of [null, undefined, ""]) {
                const { html, text } = vmConfirmationCustomerTemplate({ ...base, meetLink, meetStatus: "failed" });

                assert.match(html, /Your Google Meet link will follow in a separate email\./);
                assert.match(text, /Your Google Meet link will follow in a separate email\./);
                assert.doesNotMatch(html, /meet\.google\.com/);
                assert.doesNotMatch(html, /<a /);
            }
        });

        it("shows the booking ID, date, time and duration", () => {
            const { html, text } = vmConfirmationCustomerTemplate({ ...base, time: "14:00" });

            for (const body of [html, text]) {
                assert.match(body, /OE-VM-261015-K7Q2/);
                assert.match(body, /Thu, 15 Oct 2026/);
                assert.match(body, /2:00 PM IST/);
                assert.match(body, /60 minutes/);
            }
        });
    });

    describe("date and time format", () => {
        it("formats dates as 'Thu, 15 Oct 2026'", () => {
            assert.equal(formatDateLabel("2026-10-15"), "Thu, 15 Oct 2026");
            assert.equal(formatDateLabel("2026-01-05"), "Mon, 5 Jan 2026");
            assert.equal(formatDateLabel("2026-12-31"), "Thu, 31 Dec 2026");
            assert.equal(formatDateLabel("2028-02-29"), "Tue, 29 Feb 2028");
        });

        it("formats times as '10:00 AM IST'", () => {
            assert.equal(formatTimeLabel("10:00"), "10:00 AM IST");
            assert.equal(formatTimeLabel("14:00"), "2:00 PM IST");
            assert.equal(formatTimeLabel("00:00"), "12:00 AM IST");
            assert.equal(formatTimeLabel("12:00"), "12:00 PM IST");
            assert.equal(formatTimeLabel("16:30"), "4:30 PM IST");
        });

        it("formats callback periods from the config", () => {
            assert.equal(formatPeriodLabel("morning"), "Morning (9 AM – 12 PM IST)");
            assert.equal(formatPeriodLabel("evening"), "Evening (3 PM – 6 PM IST)");
            assert.equal(formatPeriodLabel("constructor"), "constructor");
        });

        it("leaves invalid input readable instead of throwing", () => {
            assert.equal(formatDateLabel("2026-02-30"), "2026-02-30");
            assert.equal(formatDateLabel(undefined), "");
            assert.equal(formatTimeLabel("25:00"), "25:00");
        });

        it("shows dates and times in every booking email that has them", () => {
            for (const render of [
                () => vmConfirmationCustomerTemplate(base),
                () => vmNotificationCompanyTemplate(base),
                () => vmCancellationCustomerTemplate(base),
                () => vmMeetLinkFollowupTemplate(base),
            ]) {
                const { html, text } = render();

                assert.match(html, /Thu, 15 Oct 2026/);
                assert.match(html, /10:00 AM IST/);
                assert.match(text, /Thu, 15 Oct 2026/);
                assert.match(text, /10:00 AM IST/);
            }
            for (const render of [
                () => callbackConfirmationCustomerTemplate(base),
                () => callbackNotificationCompanyTemplate(base),
                () => callbackCancellationCustomerTemplate(base),
            ]) {
                const { html, text } = render();

                assert.match(html, /Thu, 15 Oct 2026/);
                assert.match(html, /Morning \(9 AM – 12 PM IST\)/);
                assert.match(text, /Morning \(9 AM – 12 PM IST\)/);
            }
        });
    });

    describe("what customers and the company see", () => {
        const secrets = {
            ...base,
            topic: "SECRET-TOPIC-123",
            reason: "SECRET-REASON-456",
            cancelReason: "INTERNAL-CANCEL-REASON-789",
            cancelledBy: "INTERNAL-STAFF-NAME",
        };
        const customerTemplates = [
            ["vmConfirmationCustomer", vmConfirmationCustomerTemplate],
            ["vmCancellationCustomer", vmCancellationCustomerTemplate],
            ["vmMeetLinkFollowup", vmMeetLinkFollowupTemplate],
            ["callbackConfirmationCustomer", callbackConfirmationCustomerTemplate],
            ["callbackCancellationCustomer", callbackCancellationCustomerTemplate],
        ];

        for (const [name, render] of customerTemplates) {
            it(`${name}: never includes the free-text topic, reason or an internal cancel reason`, () => {
                const { subject, text, html } = render(secrets);

                for (const hidden of ["SECRET-TOPIC-123", "SECRET-REASON-456", "INTERNAL-CANCEL-REASON-789", "INTERNAL-STAFF-NAME"]) {
                    assert.equal(subject.includes(hidden), false, `${name} subject has ${hidden}`);
                    assert.equal(text.includes(hidden), false, `${name} text has ${hidden}`);
                    assert.equal(html.includes(hidden), false, `${name} html has ${hidden}`);
                }
            });
        }

        it("company notifications include the topic or reason", () => {
            const vm = vmNotificationCompanyTemplate(secrets);
            const cb = callbackNotificationCompanyTemplate(secrets);

            assert.ok(vm.text.includes("SECRET-TOPIC-123"));
            assert.ok(vm.html.includes("SECRET-TOPIC-123"));
            assert.ok(cb.text.includes("SECRET-REASON-456"));
            assert.ok(cb.html.includes("SECRET-REASON-456"));
        });

        it("company notifications include the customer's contact details", () => {
            const vm = vmNotificationCompanyTemplate(secrets);

            for (const body of [vm.text, vm.html]) {
                assert.match(body, /rahul@example\.com/);
                assert.match(body, /\+919876543210/);
            }
        });

        it("shows a dash for optional company fields that are empty", () => {
            const { text, html } = vmNotificationCompanyTemplate({
                ...base, organisation: undefined, designation: "", topic: null,
            });

            assert.match(text, /Organisation: -/);
            assert.match(text, /Topic: -/);
            assert.doesNotMatch(html, /undefined|null/);
        });
    });

    describe("layout", () => {
        it("is a plain wrapper: inline styles only, 600px, company footer", () => {
            for (const [name, [render]] of Object.entries(templates)) {
                const { html } = render();

                assert.match(html, /^<!DOCTYPE html>/, name);
                assert.match(html, /max-width:600px/, name);
                assert.doesNotMatch(html, /<style/i, `${name} has no <style> block`);
                assert.doesNotMatch(html, /\sclass=/i, `${name} has no CSS classes`);
                assert.doesNotMatch(html, /<script/i, name);
                assert.match(html, /Oceao Enviro/, `${name} has the company name`);
            }
        });

        it("renderLayout escapes the title and inserts the body as given", () => {
            const html = renderLayout({ title: "A <b> title", body: "<p>Body &amp; more</p>" });

            assert.match(html, /<title>A &lt;b&gt; title<\/title>/);
            assert.ok(html.includes("<p>Body &amp; more</p>"));
        });
    });
});
