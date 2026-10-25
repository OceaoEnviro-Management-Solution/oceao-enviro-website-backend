// General applications (a resume sent without a job): POST /careers/general-apply. Nothing is
// stored or uploaded: the HR email with the resume attached is the application. Turnstile and email
// are fakes; Cloudinary is a fake that fails the test if it is ever called.

import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import request from "supertest";
import {
    startTestEnv, stopTestEnv, resetState, getApp, emailOutbox, rateLimiting, PDF_BUFFER, PNG_BUFFER,
    TEST_COMPANY_MAIL, TEST_CAPTCHA_TOKEN,
} from "./helpers/setup.js";

const URL_PATH = "/api/v1/careers/general-apply";
const MB = 1024 * 1024;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

let cloudinary;
let nowIST;
let cloudinaryCalls;

const crc32 = (buffer) => {
    let crc = ~0;
    for (const byte of buffer) {
        crc ^= byte;
        for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return ~crc >>> 0;
};

// A stored (uncompressed) zip archive of [name, text] entries
const zip = (entries) => {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, text] of entries) {
        const nameBuf = Buffer.from(name);
        const data = Buffer.from(text);
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuf, data);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
};

const DOCX_BUFFER = zip([
    ["[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${DOCX_MIME}.main+xml"/></Types>`],
    ["word/document.xml", "<w:document/>"],
]);

const FIELDS = {
    desiredRole: "Environmental Engineer",
    fullName: "Priya Nair",
    email: "Priya.Nair@Example.com",
    phone: "+91 99887-76655",
    currentLocation: "Kochi",
    totalExperienceYears: "2.5",
    currentOrganisation: "Blue Water Labs",
    currentDesignation: "Junior Engineer",
    highestQualification: "B.Tech Environmental Engineering",
    noticePeriod: "60 days",
    expectedCtc: "Rs 6 LPA",
    profileUrl: "https://www.linkedin.com/in/priya-nair",
    coverNote: "I would like to work on water projects.\nOpen to relocation.",
    consent: "true",
    turnstileToken: TEST_CAPTCHA_TOKEN,
};

const send = ({ fields = {}, file = PDF_BUFFER, filename = "Priya Resume.pdf", type = "application/pdf" } = {}) => {
    const req = request(getApp()).post(URL_PATH);
    for (const [key, value] of Object.entries({ ...FIELDS, ...fields })) if (value !== undefined) req.field(key, value);
    if (file) req.attach("resume", file, { filename, contentType: type });
    return req;
};

const waitForEmails = async (count) => {
    for (let i = 0; i < 100 && emailOutbox.all().length < count; i++) await new Promise((done) => setTimeout(done, 10));
    return emailOutbox.all();
};
const settle = () => new Promise((done) => setTimeout(done, 100));
const quiet = () => { for (const method of ["log", "warn", "error"]) mock.method(console, method, () => {}); };
const storedDocuments = async () => {
    let total = 0;
    for (const collection of Object.values(mongoose.connection.collections)) total += await collection.countDocuments();
    return total;
};

describe("Careers general applications", () => {
    before(async () => {
        await startTestEnv();
        cloudinary = await import("../src/services/cloudinary.service.js");
        ({ nowIST } = await import("../src/utils/time.js"));
    });
    after(stopTestEnv);
    beforeEach(async () => {
        await resetState();
        cloudinaryCalls = 0;
        const refuse = () => { cloudinaryCalls++; throw new Error("Cloudinary must not be used for general applications"); };
        cloudinary.setCloudinaryClient({ uploader: { upload_stream: refuse, destroy: refuse }, utils: { private_download_url: refuse } });
    });
    afterEach(() => {
        mock.restoreAll();
        cloudinary.setCloudinaryClient(null);
    });

    it("emails HR every detail with the resume attached, thanks the candidate, and stores nothing", async () => {
        const res = await send();

        assert.equal(res.status, 201, JSON.stringify(res.body));
        const { referenceId } = res.body.data;
        assert.match(referenceId, new RegExp(`^OE-GA-${nowIST(new Date()).dateKey.slice(2).replaceAll("-", "")}-[${ALPHABET}]{4}$`));
        assert.deepEqual(Object.keys(res.body.data), ["referenceId"]);

        const mails = await waitForEmails(2);
        assert.equal(mails.length, 2);
        const [hr, candidate] = mails;

        assert.equal(hr.to, TEST_COMPANY_MAIL);
        assert.equal(hr.replyTo, "priya.nair@example.com");
        assert.equal(hr.subject, "General application: Environmental Engineer - Priya Nair");
        assert.equal(hr.attachments.length, 1);
        assert.equal(hr.attachments[0].filename, "Priya_Nair_Environmental_Engineer_Resume.pdf");
        assert.equal(hr.attachments[0].contentType, "application/pdf");
        assert.ok(hr.attachments[0].content.equals(PDF_BUFFER));
        for (const value of [referenceId, "Environmental Engineer", "Priya Nair", "priya.nair@example.com", "+919988776655", "Kochi", "2.5 years",
            "Blue Water Labs", "Junior Engineer", "B.Tech Environmental Engineering", "60 days", "Rs 6 LPA", "https://www.linkedin.com/in/priya-nair",
            "Open to relocation.", "Priya Resume.pdf (attached)", "IST", "this email is the only copy"]) {
            assert.ok(hr.text.includes(value), `HR text has ${value}`);
        }

        assert.equal(candidate.to, "priya.nair@example.com");
        assert.equal(candidate.subject, "We've received your resume for Environmental Engineer");
        assert.equal(candidate.attachments, undefined);
        assert.ok(candidate.text.startsWith("Dear Priya Nair,"));
        assert.ok(candidate.text.includes(`Your reference ID is ${referenceId}.`));
        assert.ok(candidate.text.includes("up to 12 months"));
        assert.ok(candidate.text.includes("Oceao Enviro HR Team"));
        assert.doesNotMatch(candidate.text, /within \d|\d+ (working )?days/i, "no promised timeline");

        assert.equal(await storedDocuments(), 0);
        assert.equal(cloudinaryCalls, 0);
    });

    it("accepts a Word .docx resume and blank optional fields", async () => {
        const blank = { currentOrganisation: "", currentDesignation: "", noticePeriod: "", expectedCtc: "", profileUrl: "", coverNote: "" };
        const res = await send({ fields: blank, file: DOCX_BUFFER, filename: "cv.docx", type: "application/octet-stream" });

        assert.equal(res.status, 201, JSON.stringify(res.body));
        const [hr] = await waitForEmails(1);
        assert.equal(hr.attachments[0].filename, "Priya_Nair_Environmental_Engineer_Resume.docx");
        assert.equal(hr.attachments[0].contentType, DOCX_MIME);
        assert.ok(hr.text.includes("Current organisation: -"));
    });

    it("if the HR email cannot be sent: 502 APPLICATION_SEND_FAILED, and the candidate is not thanked", async () => {
        quiet();
        emailOutbox.failNext("company");

        const res = await send();

        assert.equal(res.status, 502);
        assert.equal(res.body.code, "APPLICATION_SEND_FAILED");
        assert.equal(res.body.message, "We could not send your resume right now. Please try again in a few minutes.");
        await settle();
        assert.equal(emailOutbox.all().length, 0);
    });

    it("if only the thank-you email fails, the resume still went to HR: 201", async () => {
        quiet();
        emailOutbox.failNext("customer");

        const res = await send();

        assert.equal(res.status, 201);
        await settle();
        assert.deepEqual(emailOutbox.all().map((mail) => mail.to), [TEST_COMPANY_MAIL]);
    });

    it("the role is required (2-120 characters)", async () => {
        for (const desiredRole of [undefined, "", "a", "a".repeat(121)]) {
            const res = await send({ fields: { desiredRole } });
            assert.equal(res.status, 400, String(desiredRole));
            assert.ok(res.body.errors.desiredRole, String(desiredRole));
        }
        assert.equal(emailOutbox.all().length, 0);
    });

    it("validates the other fields like a job application", async () => {
        const cases = [
            [{ fullName: "A" }, "fullName"],
            [{ email: "nope" }, "email"],
            [{ phone: "123" }, "phone"],
            [{ totalExperienceYears: "2.2" }, "totalExperienceYears"],
            [{ highestQualification: "x" }, "highestQualification"],
            [{ noticePeriod: "Tomorrow" }, "noticePeriod"],
            [{ profileUrl: "http://linkedin.com/in/x" }, "profileUrl"],
            [{ coverNote: "a".repeat(2001) }, "coverNote"],
            [{ consent: undefined }, "consent"],
            [{ consent: "false" }, "consent"],
            [{ jobSlug: "senior-eia-consultant-k7q2" }, "jobSlug"],
        ];
        for (const [change, field] of cases) {
            const res = await send({ fields: change });
            assert.equal(res.status, 400, JSON.stringify(change));
            assert.ok(res.body.errors?.[field], `${JSON.stringify(change)} -> ${JSON.stringify(res.body)}`);
        }
        assert.equal(emailOutbox.all().length, 0);
    });

    it("a missing or wrong CAPTCHA is 400 CAPTCHA_FAILED", async () => {
        for (const turnstileToken of [undefined, "wrong"]) {
            const res = await send({ fields: { turnstileToken } });
            assert.equal(res.status, 400);
            assert.equal(res.body.code, "CAPTCHA_FAILED");
        }
        assert.equal(emailOutbox.all().length, 0);
    });

    it("the resume: real type PDF or DOCX, at most 5 MB, and required", async () => {
        for (const [file, filename] of [[Buffer.from("plain text"), "cv.pdf"], [PNG_BUFFER, "cv.pdf"], [zip([["a.txt", "x"]]), "cv.docx"]]) {
            const res = await send({ file, filename });
            assert.equal(res.status, 400, filename);
            assert.equal(res.body.code, "INVALID_FILE_TYPE");
        }

        const big = await send({ file: Buffer.concat([PDF_BUFFER, Buffer.alloc(6 * MB)]) });
        assert.equal(big.status, 413);
        assert.equal(big.body.message, "Resume is too large. Maximum size is 5 MB.");

        const missing = await send({ file: null });
        assert.equal(missing.status, 400);
        assert.ok(missing.body.errors.resume);
        assert.equal(emailOutbox.all().length, 0);
    });

    it("5 per hour per IP, on a counter of its own (job applications do not use it up)", async () => {
        rateLimiting.enable();
        for (let i = 0; i < 5; i++) {
            assert.equal((await send({ fields: { email: `c${i}@example.com` } })).status, 201);
        }
        const over = await send({ fields: { email: "c9@example.com" } });
        assert.equal(over.status, 429);
        assert.equal(over.body.code, "RATE_LIMITED");

        // the job Apply limiter is separate: its first request is not refused for being over the limit
        const jobApply = await request(getApp()).post("/api/v1/careers/jobs/no-such-job/apply")
            .field("fullName", "x").attach("resume", PDF_BUFFER, { filename: "cv.pdf", contentType: "application/pdf" });
        assert.notEqual(jobApply.status, 429);
    });
});
