import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
    startTestEnv,
    stopTestEnv,
    resetState,
    getApp,
    emailOutbox,
    TEST_COMPANY_MAIL,
    PNG_BUFFER,
    PDF_BUFFER,
} from "./helpers/setup.js";

const URL = "/api/v1/feedback/new-feedback";
const MB = 1024 * 1024;

const validFeedback = (overrides = {}) => ({
    type: "Suggestion",
    name: "Anita Sharma",
    email: "anita@example.com",
    mobileNumber: "9876543210",
    subject: "Great consulting service",
    message: "The team was helpful and professional throughout the project.",
    ...overrides,
});

// Sends fields as multipart form data, optionally with a file under "attachment".
const submit = (fields, file) => {
    const req = request(getApp()).post(URL);
    for (const [key, value] of Object.entries(fields)) req.field(key, value);
    if (file) req.attach("attachment", file.buffer, { filename: file.filename, contentType: file.contentType });
    return req;
};

describe("POST /api/v1/feedback/new-feedback", () => {
    before(startTestEnv);
    after(stopTestEnv);
    beforeEach(resetState);

    it("accepts feedback without a file", async () => {
        const res = await submit(validFeedback());

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            statusCode: 200,
            data: null,
            message: "Feedback received successfully",
            success: true,
        });

        const [company, customer, ...rest] = emailOutbox.all();
        assert.equal(rest.length, 0);
        assert.equal(company.to, TEST_COMPANY_MAIL);
        assert.equal(company.replyTo, "anita@example.com");
        assert.deepEqual(company.attachments, []);
        assert.match(company.text, /Attachment: No attachment/);
        assert.equal(customer.to, "anita@example.com");
        assert.match(company.text, /Mobile Number: \+919876543210/);
    });

    it("accepts a PDF and attaches it under a fixed name", async () => {
        const res = await submit(validFeedback(), {
            buffer: PDF_BUFFER,
            filename: "My <private> report.pdf",
            contentType: "application/pdf",
        });

        assert.equal(res.status, 200);
        const [company, customer] = emailOutbox.all();

        assert.equal(company.attachments.length, 1);
        assert.equal(company.attachments[0].filename, "feedback-attachment.pdf");
        assert.ok(Buffer.compare(company.attachments[0].content, PDF_BUFFER) === 0, "content is the uploaded bytes");
        assert.equal("path" in company.attachments[0], false, "nothing is read from disk");
        assert.deepEqual(customer.attachments ?? [], [], "customer confirmation has no attachment");

        // The user's file name appears in the body only, escaped in HTML.
        assert.match(company.text, /Attachment: My <private> report\.pdf/);
        assert.match(company.html, /My &lt;private&gt; report\.pdf/);
        assert.doesNotMatch(company.html, /<private>/);
    });

    it("accepts a PNG", async () => {
        const res = await submit(validFeedback(), {
            buffer: PNG_BUFFER,
            filename: "screenshot.png",
            contentType: "image/png",
        });

        assert.equal(res.status, 200);
        const [company] = emailOutbox.all();
        assert.equal(company.attachments[0].filename, "feedback-attachment.png");
    });

    it("rejects a disallowed mimetype", async () => {
        const res = await submit(validFeedback(), {
            buffer: Buffer.from("just some text"),
            filename: "notes.txt",
            contentType: "text/plain",
        });

        assert.equal(res.status, 400);
        assert.equal(res.body.success, false);
        assert.equal(res.body.code, "INVALID_FILE_TYPE");
        assert.equal(emailOutbox.all().length, 0);
    });

    it("rejects a file whose real type does not match the declared type", async () => {
        const spoofs = [
            { label: "executable declared as PNG", buffer: Buffer.from("MZ\x90\x00\x03\x00\x00\x00 not an image"), filename: "x.png", contentType: "image/png" },
            { label: "plain text declared as PDF", buffer: Buffer.from("this is not a pdf"), filename: "x.pdf", contentType: "application/pdf" },
            { label: "PDF declared as PNG", buffer: PDF_BUFFER, filename: "x.png", contentType: "image/png" },
            { label: "empty file declared as PDF", buffer: Buffer.alloc(0), filename: "empty.pdf", contentType: "application/pdf" },
        ];

        for (const spoof of spoofs) {
            const res = await submit(validFeedback(), spoof);

            assert.equal(res.status, 400, spoof.label);
            assert.equal(res.body.code, "INVALID_FILE_TYPE", spoof.label);
        }
        assert.equal(emailOutbox.all().length, 0);
    });

    it("rejects a file over 5 MB", async () => {
        const tooBig = Buffer.concat([PDF_BUFFER, Buffer.alloc(5 * MB)]);

        const res = await submit(validFeedback(), {
            buffer: tooBig,
            filename: "big.pdf",
            contentType: "application/pdf",
        });

        assert.equal(res.status, 413);
        assert.equal(res.body.code, "FILE_TOO_LARGE");
        assert.equal(emailOutbox.all().length, 0);
    });

    it("rejects missing fields with VALIDATION_FAILED and per-field errors", async () => {
        const res = await submit({ name: "A" });

        assert.equal(res.status, 400);
        assert.equal(res.body.success, false);
        assert.equal(res.body.code, "VALIDATION_FAILED");
        for (const field of ["type", "name", "email", "subject", "message"]) {
            assert.ok(Array.isArray(res.body.errors[field]), `errors.${field} is an array`);
        }
        assert.equal(res.body.errors.mobileNumber, undefined, "mobileNumber stays optional");
        assert.equal(emailOutbox.all().length, 0);
    });

    it("rejects invalid fields even when a valid file is attached", async () => {
        const res = await submit(validFeedback({ subject: "short" }), {
            buffer: PDF_BUFFER,
            filename: "report.pdf",
            contentType: "application/pdf",
        });

        assert.equal(res.status, 400);
        assert.equal(res.body.code, "VALIDATION_FAILED");
        assert.ok(res.body.errors.subject);
        assert.equal(emailOutbox.all().length, 0);
    });
});
