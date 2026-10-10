import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
    startTestEnv,
    stopTestEnv,
    resetState,
    getApp,
    emailOutbox,
    rateLimiting,
    TEST_COMPANY_MAIL,
} from "./helpers/setup.js";

const URL = "/api/v1/query/new-query";

const validQuery = (overrides = {}) => ({
    name: "Rahul Kumar",
    email: "rahul@example.com",
    mobileNumber: "9876543210",
    organisation: "ABC Pvt Ltd",
    industry: "Manufacturing",
    source: "Google",
    subject: "Environmental audit",
    query: "We would like to know more about your environmental audit services.",
    ...overrides,
});

// Sends the fields as multipart form data, the same way the website form does.
const submit = (fields) => {
    const req = request(getApp()).post(URL);
    for (const [key, value] of Object.entries(fields)) req.field(key, value);
    return req;
};

describe("POST /api/v1/query/new-query", () => {
    before(startTestEnv);
    after(stopTestEnv);
    beforeEach(resetState);

    it("accepts a valid submission and sends two emails", async () => {
        const res = await submit(validQuery());

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            statusCode: 200,
            data: null,
            message: "Query received successfully",
            success: true,
        });

        const [company, customer, ...rest] = emailOutbox.all();
        assert.equal(rest.length, 0, "exactly two emails");

        assert.equal(company.to, TEST_COMPANY_MAIL);
        assert.equal(company.replyTo, "rahul@example.com", "company email replies to the customer");
        assert.equal(company.subject, "QUERY: Environmental audit");

        assert.equal(customer.to, "rahul@example.com");
        assert.equal(customer.replyTo, undefined);
        assert.match(customer.text, /regarding: Environmental audit/);
        assert.doesNotMatch(customer.text + customer.html, /undefined|null/);
    });

    it("rejects missing fields with VALIDATION_FAILED and per-field errors", async () => {
        const res = await submit({ name: "R" });

        assert.equal(res.status, 400);
        assert.equal(res.body.success, false);
        assert.equal(res.body.code, "VALIDATION_FAILED");
        assert.equal(typeof res.body.message, "string");
        for (const field of ["name", "email", "mobileNumber", "subject", "query"]) {
            assert.ok(Array.isArray(res.body.errors[field]), `errors.${field} is an array`);
            assert.ok(res.body.errors[field].length > 0);
        }
        assert.equal(emailOutbox.all().length, 0, "no email on validation failure");
    });

    it("normalizes the mobile number to +91XXXXXXXXXX", async () => {
        for (const input of ["9876543210", "98765 43210", "09876543210", "+91 98765-43210"]) {
            emailOutbox.clear();
            const res = await submit(validQuery({ mobileNumber: input }));

            assert.equal(res.status, 200, `accepted ${input}`);
            const [company] = emailOutbox.all();
            assert.match(company.text, /Mobile Number: \+919876543210/, `normalized ${input}`);
        }
    });

    it("rejects an invalid mobile number", async () => {
        const res = await submit(validQuery({ mobileNumber: "5876543210" }));

        assert.equal(res.status, 400);
        assert.equal(res.body.code, "VALIDATION_FAILED");
        assert.ok(res.body.errors.mobileNumber);
    });

    it("escapes user values in the company email HTML and keeps text raw", async () => {
        const res = await submit(
            validQuery({
                name: "<script>alert(1)</script>",
                organisation: '"><svg onload=alert(1)>',
                subject: "Hello <b>there</b>\r\nBcc: attacker@example.com",
                query: "<img src=x onerror=alert(1)> please call",
            })
        );

        assert.equal(res.status, 200);
        const [company] = emailOutbox.all();

        assert.doesNotMatch(company.html, /<script>|<svg|<img|<b>there/);
        assert.match(company.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.match(company.html, /&lt;img src=x onerror=alert\(1\)&gt;/);

        assert.match(company.text, /<script>alert\(1\)<\/script>/, "text body keeps raw values");
        assert.match(company.text, /<img src=x onerror=alert\(1\)>/);

        assert.doesNotMatch(company.subject, /[\r\n]/, "no header injection through the subject");
        assert.doesNotMatch(company.subject, /&lt;|&gt;/, "subject is raw text, not escaped HTML");
        assert.match(company.subject, /<b>there<\/b>/);
    });

    it("returns a safe 500 when the company email fails", async () => {
        emailOutbox.failNext("company");

        const res = await submit(validQuery());

        assert.equal(res.status, 500);
        assert.equal(res.body.success, false);
        assert.equal(res.body.code, "INTERNAL_ERROR");
        assert.equal(res.body.message, "Unable to process your query at the moment. Please try again later.");
        assert.doesNotMatch(JSON.stringify(res.body), /Simulated|stack|ECONN|smtp/i, "no internal details leak");
        assert.equal(emailOutbox.all().length, 0, "no confirmation sent when the company email failed");
    });

    it("still returns 200 when only the customer email fails", async () => {
        emailOutbox.failNext("customer");

        const res = await submit(validQuery());

        assert.equal(res.status, 200);
        const sent = emailOutbox.all();
        assert.equal(sent.length, 1);
        assert.equal(sent[0].to, TEST_COMPANY_MAIL);
    });

    it("is rate limited to 5 requests per window when limiting is enabled", async () => {
        rateLimiting.enable();

        for (let i = 1; i <= 5; i++) {
            const ok = await submit(validQuery());
            assert.equal(ok.status, 200, `request ${i}`);
        }
        const limited = await submit(validQuery());

        assert.equal(limited.status, 429);
        assert.equal(limited.body.code, "RATE_LIMITED");
        assert.equal(limited.body.success, false);
        assert.ok(limited.headers["retry-after"], "Retry-After header present");
    });

    it("does not rate limit when limiting is off (the default in tests)", async () => {
        for (let i = 1; i <= 7; i++) {
            const res = await submit(validQuery());
            assert.equal(res.status, 200, `request ${i}`);
        }
    });
});
