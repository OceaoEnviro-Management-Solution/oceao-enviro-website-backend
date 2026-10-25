// Careers B2: applying with a resume, the two emails, the admin applicant list, status, resume link
// and CSV export, and the retention clean-up. Cloudinary, Turnstile and email are fakes: no network.

import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import request from "supertest";
import {
    startTestEnv, stopTestEnv, resetState, getApp, emailOutbox, rateLimiting, PDF_BUFFER, PNG_BUFFER,
    TEST_ORIGIN, TEST_COMPANY_MAIL, TEST_CAPTCHA_TOKEN, TEST_ADMIN_ENV, TEST_ADMIN_PASSWORD_HASH, TEST_ADMIN_JWT_SECRET,
} from "./helpers/setup.js";

const PUBLIC = "/api/v1/careers/jobs";
const ADMIN = "/api/v1/admin/careers";
const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let cloudinary;
let Job;
let JobStat;
let JobApplication;
let AuditLog;
let nowIST;
let cleanupOldApplications;
let startJobs;
let fake;

// ── Fakes and fixtures ───────────────────────────────────────────────────────

// A stand-in for the Cloudinary SDK: records every upload, delete and signed link. For each delete
// it notes whether that resume's application still existed in the database at that moment.
const makeFake = () => {
    const state = { uploads: [], destroys: [], links: [], failUpload: false, rowStillThereAtDestroy: [] };
    return {
        state,
        uploader: {
            upload_stream(options, done) {
                const entry = { options };
                state.uploads.push(entry);
                return {
                    end(buffer) {
                        entry.buffer = buffer;
                        queueMicrotask(() => {
                            if (state.failUpload) return done(new Error("cloudinary is down"));
                            done(null, { public_id: `${options.folder}/${options.public_id}`, bytes: buffer.length });
                        });
                    },
                };
            },
            async destroy(publicId, options) {
                state.destroys.push({ publicId, options });
                state.rowStillThereAtDestroy.push(Boolean(await JobApplication.exists({ "resume.publicId": publicId })));
                return { result: "ok" };
            },
        },
        utils: {
            private_download_url(publicId, format, options) {
                state.links.push({ publicId, format, options });
                return `https://api.cloudinary.com/v1_1/test-cloud/raw/download?public_id=${encodeURIComponent(publicId)}&expires_at=${options.expires_at}&signature=fake`;
            },
        },
    };
};

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

// The smallest file whose real type is Word .docx
const DOCX_BUFFER = zip([
    ["[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${DOCX_MIME}.main+xml"/></Types>`],
    ["word/document.xml", "<w:document/>"],
]);
const ZIP_BUFFER = zip([["notes.txt", "not a resume"]]);
const TEXT_BUFFER = Buffer.from("I am a text file pretending to be a PDF");

const passwordVersion = crypto.createHash("sha256").update(TEST_ADMIN_PASSWORD_HASH).digest("hex").slice(0, 12);
const sessionCookie = () =>
    `oe_admin=${jwt.sign({ sub: "admin", pwv: passwordVersion }, TEST_ADMIN_JWT_SECRET, { algorithm: "HS256", expiresIn: 3600 })}`;

const FIELDS = {
    fullName: "Rahul Sharma",
    email: "Rahul.Sharma@Example.com",
    phone: "+91 98765-43210",
    currentLocation: "Noida",
    totalExperienceYears: "3.5",
    currentOrganisation: "Green Earth Labs",
    currentDesignation: "EIA Analyst",
    highestQualification: "M.Sc. Environmental Science",
    noticePeriod: "30 days",
    expectedCtc: "Rs 9 LPA",
    profileUrl: "https://www.linkedin.com/in/rahul-sharma",
    coverNote: "I have prepared 12 EIA reports.\nI know Form 1 and Form 2 well.",
    consent: "true",
    turnstileToken: TEST_CAPTCHA_TOKEN,
};

// POST /careers/jobs/:slug/apply as the website sends it
const apply = (slug, { fields = {}, file = PDF_BUFFER, filename = "Rahul CV.pdf", type = "application/pdf", fileField = "resume" } = {}) => {
    const req = request(getApp()).post(`${PUBLIC}/${slug}/apply`);
    for (const [key, value] of Object.entries({ ...FIELDS, ...fields })) if (value !== undefined) req.field(key, value);
    if (file) req.attach(fileField, file, { filename, contentType: type });
    return req;
};

const adminGet = (path, { cookie = true } = {}) => {
    const req = request(getApp()).get(`${ADMIN}${path}`);
    return cookie ? req.set("Cookie", sessionCookie()) : req;
};
const adminSend = (method, path, body, { cookie = true } = {}) => {
    const req = request(getApp())[method](`${ADMIN}${path}`).set("Origin", TEST_ORIGIN).set("Content-Type", "application/json");
    if (cookie) req.set("Cookie", sessionCookie());
    return req.send(body);
};

const job = (overrides = {}) => ({
    slug: `senior-eia-consultant-${crypto.randomBytes(2).toString("hex")}`,
    title: "Senior EIA Consultant",
    department: "Environmental Clearance",
    location: "New Delhi",
    employmentType: "Full-time",
    workMode: "Hybrid",
    experienceMin: 3,
    experienceMax: 6,
    summary: "Lead EIA studies for infrastructure projects.",
    responsibilities: "Prepare EIA reports",
    requirements: "M.Sc. Environmental Science",
    visible: true,
    acceptingApplications: true,
    publishAt: new Date(Date.now() - DAY),
    archived: false,
    ...overrides,
});
const seedJob = async (overrides) => (await Job.create(job(overrides))).toObject();

let idCounter = 0;
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const nextId = () => {
    const n = idCounter++;
    return `OE-JA-261025-${ALPHABET[Math.floor(n / 900) % 30]}${ALPHABET[Math.floor(n / 30) % 30]}${ALPHABET[n % 30]}2`;
};

// An application stored directly (createdAt as given), as the Apply endpoint would have saved it
const application = (jobDoc, overrides = {}) => {
    const applicationId = overrides.applicationId ?? nextId();
    const createdAt = overrides.createdAt ?? new Date();
    return {
        applicationId,
        jobId: jobDoc._id,
        jobSnapshot: { title: jobDoc.title, department: jobDoc.department, location: jobDoc.location, slug: jobDoc.slug },
        fullName: "Asha Verma",
        email: `${applicationId.toLowerCase()}@example.com`,
        phone: "9876543210",
        currentLocation: "Pune",
        totalExperienceYears: 2,
        highestQualification: "B.Tech",
        consentAt: createdAt,
        resume: { publicId: `oceao/resumes/${applicationId}.pdf`, originalName: "cv.pdf", sizeBytes: 1200, ext: "pdf" },
        status: "new",
        ...overrides,
        createdAt,
        updatedAt: createdAt,
    };
};
const seedApplications = (docs) => JobApplication.collection.insertMany(docs);

const waitForEmails = async (count) => {
    for (let i = 0; i < 100 && emailOutbox.all().length < count; i++) await new Promise((done) => setTimeout(done, 10));
    return emailOutbox.all();
};
const audits = (action) => AuditLog.find({ action }).lean();
const quiet = () => { for (const method of ["log", "warn", "error"]) mock.method(console, method, () => {}); };
const today = () => nowIST(new Date()).dateKey;

describe("Careers applications", () => {
    before(async () => {
        await startTestEnv();
        cloudinary = await import("../src/services/cloudinary.service.js");
        ({ Job } = await import("../src/models/job.model.js"));
        ({ JobStat } = await import("../src/models/jobStat.model.js"));
        ({ JobApplication } = await import("../src/models/jobApplication.model.js"));
        ({ AuditLog } = await import("../src/models/auditLog.model.js"));
        ({ nowIST } = await import("../src/utils/time.js"));
        ({ cleanupOldApplications } = await import("../src/services/careers/retention.service.js"));
        ({ startJobs } = await import("../src/jobs/scheduler.js"));
        await Promise.all([Job.init(), JobStat.init(), JobApplication.init()]);
    });
    after(stopTestEnv);
    beforeEach(async () => {
        await resetState();
        fake = makeFake();
        cloudinary.setCloudinaryClient(fake);
    });
    afterEach(() => {
        mock.restoreAll();
        cloudinary.setCloudinaryClient(null);
    });

    // ── C6 + C7: the happy path ───────────────────────────────────────────────
    describe("POST /careers/jobs/:slug/apply", () => {
        it("saves the application, uploads the resume privately, counts it and sends both emails", async () => {
            const target = await seedJob();
            const res = await apply(target.slug);

            assert.equal(res.status, 201, JSON.stringify(res.body));
            const { applicationId, jobTitle } = res.body.data;
            assert.match(applicationId, new RegExp(`^OE-JA-${today().slice(2).replaceAll("-", "")}-[${ALPHABET}]{4}$`));
            assert.equal(jobTitle, "Senior EIA Consultant");

            // the upload: private, raw, in oceao/resumes, named after the application
            assert.equal(fake.state.uploads.length, 1);
            assert.deepEqual(fake.state.uploads[0].options, {
                resource_type: "raw", type: "private", folder: "oceao/resumes", public_id: `${applicationId}.pdf`, overwrite: false,
            });
            assert.ok(fake.state.uploads[0].buffer.equals(PDF_BUFFER));

            // the saved application, normalized
            const saved = await JobApplication.findOne({ applicationId }).lean();
            assert.equal(String(saved.jobId), String(target._id));
            assert.deepEqual(saved.jobSnapshot, { title: target.title, department: target.department, location: target.location, slug: target.slug });
            assert.equal(saved.email, "rahul.sharma@example.com");
            assert.equal(saved.phone, "+919876543210");
            assert.equal(saved.totalExperienceYears, 3.5);
            assert.equal(saved.noticePeriod, "30 days");
            assert.equal(saved.coverNote, FIELDS.coverNote);
            assert.equal(saved.status, "new");
            assert.ok(saved.consentAt instanceof Date);
            assert.deepEqual(saved.resume, { publicId: `oceao/resumes/${applicationId}.pdf`, originalName: "Rahul CV.pdf", sizeBytes: PDF_BUFFER.length, ext: "pdf" });
            assert.equal("consent" in saved, false);
            assert.equal("turnstileToken" in saved, false);

            // the daily stat
            const stat = await JobStat.findOne({ jobId: target._id }).lean();
            assert.equal(stat.date, today());
            assert.equal(stat.applications, 1);

            // the two emails
            const mails = await waitForEmails(2);
            assert.equal(mails.length, 2);
            const company = mails.find((mail) => mail.to === TEST_COMPANY_MAIL);
            const candidate = mails.find((mail) => mail.to === "rahul.sharma@example.com");

            assert.equal(company.subject, "New application: Senior EIA Consultant - Rahul Sharma");
            assert.equal(company.replyTo, "rahul.sharma@example.com");
            assert.equal(company.attachments.length, 1);
            assert.equal(company.attachments[0].filename, "Rahul_Sharma_Senior_EIA_Consultant_Resume.pdf");
            assert.equal(company.attachments[0].contentType, "application/pdf");
            assert.ok(company.attachments[0].content.equals(PDF_BUFFER));
            for (const value of [applicationId, "Rahul Sharma", "+919876543210", "Noida", "3.5 years", "Green Earth Labs", "EIA Analyst",
                "M.Sc. Environmental Science", "30 days", "Rs 9 LPA", "https://www.linkedin.com/in/rahul-sharma", "I know Form 1",
                "Environmental Clearance", "New Delhi", "Full-time", "Hybrid", "3-6 years", "IST"]) {
                assert.ok(company.text.includes(value), `company text has ${value}`);
            }
            assert.ok(company.html.includes(`${TEST_ORIGIN}/admin/careers/${target._id}`));

            assert.equal(candidate.subject, "We've received your application for Senior EIA Consultant");
            assert.equal(candidate.attachments, undefined);
            assert.ok(candidate.text.startsWith("Dear Rahul Sharma,"));
            assert.ok(candidate.text.includes(`Your reference ID is ${applicationId}.`));
            assert.ok(candidate.text.includes("for up to 12 months"));
            assert.ok(candidate.text.includes("Oceao Enviro HR Team"));
            assert.doesNotMatch(candidate.text, /within \d|\d+ (working )?days/i, "no promised timeline");
        });

        it("accepts a Word .docx resume, whatever type the browser declares", async () => {
            const target = await seedJob();
            const res = await apply(target.slug, { file: DOCX_BUFFER, filename: "cv.docx", type: "application/octet-stream" });

            assert.equal(res.status, 201, JSON.stringify(res.body));
            const saved = await JobApplication.findOne().lean();
            assert.equal(saved.resume.ext, "docx");
            assert.equal(saved.resume.publicId, `oceao/resumes/${saved.applicationId}.docx`);
            const company = (await waitForEmails(2)).find((mail) => mail.to === TEST_COMPANY_MAIL);
            assert.equal(company.attachments[0].filename, "Rahul_Sharma_Senior_EIA_Consultant_Resume.docx");
            assert.equal(company.attachments[0].contentType, DOCX_MIME);
        });

        it("keeps a Hindi file name, drops any folder part, and escapes user values in the HTML email", async () => {
            const target = await seedJob({ title: "Lab <Analyst>" });
            const res = await apply(target.slug, { filename: "C:\\Users\\राहुल\\बायोडाटा.pdf", fields: { fullName: "<b>Rahul</b> & Co" } });

            assert.equal(res.status, 201);
            const saved = await JobApplication.findOne().lean();
            assert.equal(saved.resume.originalName, "बायोडाटा.pdf");
            const company = (await waitForEmails(2)).find((mail) => mail.to === TEST_COMPANY_MAIL);
            assert.ok(!company.html.includes("<b>Rahul</b>"));
            assert.ok(company.html.includes("&lt;b&gt;Rahul&lt;/b&gt; &amp; Co"));
            assert.equal(company.attachments[0].filename, "b_Rahul_b_Co_Lab_Analyst_Resume.pdf");
        });

        it("the attachment name has only letters, digits and underscores", async () => {
            const { resumeFileName } = await import("../src/services/email/templates/careers/index.js");

            assert.equal(resumeFileName("Dr. A.K. Singh", "Sr. EIA Consultant (Delhi/NCR)", "pdf"), "Dr_A_K_Singh_Sr_EIA_Consultant_Delhi_NCR_Resume.pdf");
            assert.equal(resumeFileName("José Müller", "Lab Analyst", "docx"), "Jose_Muller_Lab_Analyst_Resume.docx");
            assert.equal(resumeFileName("राहुल", "पर्यावरण", "pdf"), "Candidate_Job_Resume.pdf");
        });

        it("hidden, scheduled, archived and unknown jobs give 404 JOB_NOT_FOUND, and nothing is uploaded", async () => {
            const hidden = await seedJob({ visible: false });
            const scheduled = await seedJob({ publishAt: new Date(Date.now() + DAY) });
            const archived = await seedJob({ archived: true });

            for (const slug of [hidden.slug, scheduled.slug, archived.slug, "no-such-job-k7q2"]) {
                const res = await apply(slug);
                assert.equal(res.status, 404, slug);
                assert.equal(res.body.code, "JOB_NOT_FOUND");
            }
            assert.equal(fake.state.uploads.length, 0);
            assert.equal(await JobApplication.countDocuments(), 0);
        });

        it("a closed job (intake off, or past its deadline) gives 409 APPLICATIONS_CLOSED", async () => {
            const stopped = await seedJob({ acceptingApplications: false });
            const expired = await seedJob({ publishAt: new Date(Date.now() - 10 * DAY), closesAt: new Date(Date.now() - 1000) });

            for (const slug of [stopped.slug, expired.slug]) {
                const res = await apply(slug);
                assert.equal(res.status, 409, slug);
                assert.equal(res.body.code, "APPLICATIONS_CLOSED");
                assert.equal(res.body.message, "Applications for this job are closed.");
            }
            assert.equal(fake.state.uploads.length, 0);
            assert.equal(await JobApplication.countDocuments(), 0);
        });

        it("the same email (any case) for the same job gives 409 ALREADY_APPLIED; another job is fine", async () => {
            const first = await seedJob();
            const second = await seedJob({ title: "Lab Analyst" });

            assert.equal((await apply(first.slug)).status, 201);
            const again = await apply(first.slug, { fields: { email: "  RAHUL.SHARMA@example.COM " } });
            assert.equal(again.status, 409);
            assert.equal(again.body.code, "ALREADY_APPLIED");
            assert.equal(again.body.message, "You have already applied for this job.");
            assert.equal(fake.state.uploads.length, 1, "the second attempt uploads nothing");

            assert.equal((await apply(second.slug)).status, 201);
            assert.equal(await JobApplication.countDocuments(), 2);
        });

        it("two parallel applications with the same email: exactly one 201, the other ALREADY_APPLIED, no resume left behind", async () => {
            const target = await seedJob();
            const results = await Promise.all([apply(target.slug), apply(target.slug), apply(target.slug)]);

            const statuses = results.map((res) => res.status).sort();
            assert.deepEqual(statuses, [201, 409, 409]);
            assert.ok(results.filter((res) => res.status === 409).every((res) => res.body.code === "ALREADY_APPLIED"));
            assert.equal(await JobApplication.countDocuments(), 1);

            const kept = (await JobApplication.findOne().lean()).resume.publicId;
            const uploaded = fake.state.uploads.map((upload) => `oceao/resumes/${upload.options.public_id}`);
            const deleted = fake.state.destroys.map((entry) => entry.publicId);
            assert.deepEqual([...deleted].sort(), uploaded.filter((id) => id !== kept).sort());
            assert.equal((await JobStat.findOne({ jobId: target._id }).lean()).applications, 1);
        });

        it("a missing or wrong CAPTCHA gives 400 CAPTCHA_FAILED", async () => {
            const target = await seedJob();
            for (const token of [undefined, "wrong-token"]) {
                const res = await apply(target.slug, { fields: { turnstileToken: token } });
                assert.equal(res.status, 400);
                assert.equal(res.body.code, "CAPTCHA_FAILED");
            }
            assert.equal(fake.state.uploads.length, 0);
        });

        it("consent must be the string \"true\"", async () => {
            const target = await seedJob();
            for (const consent of [undefined, "false", "yes", "on"]) {
                const res = await apply(target.slug, { fields: { consent } });
                assert.equal(res.status, 400, String(consent));
                assert.ok(res.body.errors.consent, String(consent));
            }
            assert.equal(await JobApplication.countDocuments(), 0);
        });

        it("checks the real file type: a text file or a plain zip named .pdf/.docx is 400 INVALID_FILE_TYPE", async () => {
            const target = await seedJob();
            for (const [file, filename, type] of [[TEXT_BUFFER, "cv.pdf", "application/pdf"], [ZIP_BUFFER, "cv.docx", DOCX_MIME], [PNG_BUFFER, "cv.pdf", "application/pdf"]]) {
                const res = await apply(target.slug, { file, filename, type });
                assert.equal(res.status, 400, filename);
                assert.equal(res.body.code, "INVALID_FILE_TYPE");
                assert.equal(res.body.message, "Only PDF or Word (.docx) resumes are allowed.");
            }
            assert.equal(fake.state.uploads.length, 0);
        });

        it("a resume over 5 MB is 413 FILE_TOO_LARGE", async () => {
            const target = await seedJob();
            const big = Buffer.concat([PDF_BUFFER, Buffer.alloc(6 * MB)]);
            const res = await apply(target.slug, { file: big });

            assert.equal(res.status, 413);
            assert.equal(res.body.code, "FILE_TOO_LARGE");
            assert.equal(res.body.message, "Resume is too large. Maximum size is 5 MB.");
            assert.equal(fake.state.uploads.length, 0);
        });

        it("exactly 5 MB is accepted", async () => {
            const target = await seedJob();
            const res = await apply(target.slug, { file: Buffer.concat([PDF_BUFFER, Buffer.alloc(5 * MB - PDF_BUFFER.length)]) });
            assert.equal(res.status, 201);
        });

        it("a missing resume is a validation error on 'resume'; a file under another name is refused", async () => {
            const target = await seedJob();
            const missing = await apply(target.slug, { file: null });
            assert.equal(missing.status, 400);
            assert.equal(missing.body.code, "VALIDATION_FAILED");
            assert.ok(missing.body.errors.resume);

            const otherField = await apply(target.slug, { fileField: "attachment" });
            assert.equal(otherField.status, 400);
            assert.equal(await JobApplication.countDocuments(), 0);
        });

        it("validates every field", async () => {
            const target = await seedJob();
            const cases = [
                [{ fullName: "A" }, "fullName"],
                [{ fullName: "a".repeat(101) }, "fullName"],
                [{ email: "not-an-email" }, "email"],
                [{ phone: "12345" }, "phone"],
                [{ phone: "1".repeat(16) }, "phone"],
                [{ phone: "98765(43210)" }, "phone"],
                [{ currentLocation: "x" }, "currentLocation"],
                [{ totalExperienceYears: "3.3" }, "totalExperienceYears"],
                [{ totalExperienceYears: "50.5" }, "totalExperienceYears"],
                [{ totalExperienceYears: "-1" }, "totalExperienceYears"],
                [{ totalExperienceYears: "three" }, "totalExperienceYears"],
                [{ currentOrganisation: "a".repeat(121) }, "currentOrganisation"],
                [{ currentDesignation: "a".repeat(121) }, "currentDesignation"],
                [{ highestQualification: "x" }, "highestQualification"],
                [{ noticePeriod: "2 weeks" }, "noticePeriod"],
                [{ expectedCtc: "a".repeat(41) }, "expectedCtc"],
                [{ profileUrl: "http://www.linkedin.com/in/rahul" }, "profileUrl"],
                [{ profileUrl: "javascript:alert(1)" }, "profileUrl"],
                [{ profileUrl: `https://example.com/${"a".repeat(300)}` }, "profileUrl"],
                [{ coverNote: "a".repeat(2001) }, "coverNote"],
                [{ status: "hired" }, "status"],
            ];
            for (const [change, field] of cases) {
                const res = await apply(target.slug, { fields: change });
                assert.equal(res.status, 400, JSON.stringify(change));
                assert.ok(res.body.errors?.[field], `${JSON.stringify(change)} -> ${JSON.stringify(res.body)}`);
            }
            assert.equal(fake.state.uploads.length, 0);
            assert.equal(await JobApplication.countDocuments(), 0);
        });

        it("optional fields may be left blank; experience 0 and 50 are allowed", async () => {
            const target = await seedJob();
            const blank = { currentOrganisation: "", currentDesignation: "", noticePeriod: "", expectedCtc: "", profileUrl: "", coverNote: "" };
            assert.equal((await apply(target.slug, { fields: { ...blank, totalExperienceYears: "0" } })).status, 201);
            assert.equal((await apply(target.slug, { fields: { email: "b@example.com", totalExperienceYears: "50" } })).status, 201);

            const saved = await JobApplication.findOne({ email: "rahul.sharma@example.com" }).lean();
            for (const key of Object.keys(blank)) assert.equal(key in saved, false, key);
            assert.equal(saved.totalExperienceYears, 0);
        });

        it("if saving fails after the upload, the uploaded resume is deleted", async () => {
            quiet();
            const target = await seedJob();
            mock.method(JobApplication, "create", async () => { throw new Error("database gone"); });

            const res = await apply(target.slug);

            assert.equal(res.status, 500);
            assert.equal(fake.state.uploads.length, 1);
            assert.deepEqual(fake.state.destroys.map((entry) => entry.publicId), [`oceao/resumes/${fake.state.uploads[0].options.public_id}`]);
            assert.deepEqual(fake.state.destroys[0].options, { resource_type: "raw", type: "private", invalidate: true });
            assert.equal(await JobStat.countDocuments(), 0);
            assert.equal(emailOutbox.all().length, 0);
        });

        it("if Cloudinary is down: 502 RESUME_UPLOAD_FAILED and nothing is saved", async () => {
            quiet();
            const target = await seedJob();
            fake.state.failUpload = true;

            const res = await apply(target.slug);

            assert.equal(res.status, 502);
            assert.equal(res.body.code, "RESUME_UPLOAD_FAILED");
            assert.equal(await JobApplication.countDocuments(), 0);
        });

        it("an email that fails is logged and the application still succeeds", async () => {
            quiet();
            const target = await seedJob();
            emailOutbox.failNext("company");

            const res = await apply(target.slug);

            assert.equal(res.status, 201);
            assert.equal(await JobApplication.countDocuments(), 1);
            const mails = await waitForEmails(1);
            await new Promise((done) => setTimeout(done, 50));
            assert.deepEqual(mails.map((mail) => mail.to), ["rahul.sharma@example.com"]);
        });

        it("5 applications per hour per IP, then 429 RATE_LIMITED", async () => {
            const target = await seedJob();
            rateLimiting.enable();
            for (let i = 0; i < 5; i++) {
                assert.equal((await apply(target.slug, { fields: { email: `c${i}@example.com` } })).status, 201);
            }
            const over = await apply(target.slug, { fields: { email: "c9@example.com" } });
            assert.equal(over.status, 429);
            assert.equal(over.body.code, "RATE_LIMITED");
            assert.equal(await JobApplication.countDocuments(), 5);
        });

        it("the public job endpoints never show anything about applications or resumes", async () => {
            const target = await seedJob();
            await apply(target.slug);
            const list = JSON.stringify((await request(getApp()).get(PUBLIC)).body);
            const page = JSON.stringify((await request(getApp()).get(`${PUBLIC}/${target.slug}`)).body);
            for (const text of [list, page]) {
                assert.ok(!text.includes("oceao/resumes") && !text.includes("rahul"), text);
            }
        });
    });

    // ── C8: admin ────────────────────────────────────────────────────────────
    describe("admin applicant endpoints", () => {
        const ROUTES = (jobId) => [
            ["get", `/jobs/${jobId}/applications`],
            ["get", `/jobs/${jobId}/applications.csv`],
            ["get", "/applications/OE-JA-261025-AAA2/resume"],
            ["patch", "/applications/OE-JA-261025-AAA2"],
        ];

        it("every applicant route needs an admin session (401)", async () => {
            const target = await seedJob();
            for (const [method, path] of ROUTES(target._id)) {
                const res = method === "get" ? await adminGet(path, { cookie: false }) : await adminSend(method, path, { status: "hired", performedBy: "Anita" }, { cookie: false });
                assert.equal(res.status, 401, path);
                assert.equal(res.body.code, "ADMIN_UNAUTHORIZED");
            }
        });

        it("lists 20 per page, newest first, filtered by status, with the counts; never the resume's Cloudinary id", async () => {
            const target = await seedJob();
            const other = await seedJob({ title: "Other job" });
            const base = Date.now() - 60 * 60 * 1000;
            const statuses = ["new", "shortlisted", "rejected", "hired"];
            const docs = Array.from({ length: 25 }, (_, i) =>
                application(target, { createdAt: new Date(base + i * 1000), status: statuses[i % 4], fullName: `Applicant ${i}` }));
            await seedApplications([...docs, application(other)]);

            const first = await adminGet(`/jobs/${target._id}/applications`);
            assert.equal(first.status, 200);
            const data = first.body.data;
            assert.equal(data.items.length, 20);
            assert.equal(data.page, 1);
            assert.equal(data.pageSize, 20);
            assert.equal(data.total, 25);
            assert.equal(data.totalPages, 2);
            assert.deepEqual(data.counts, { new: 7, shortlisted: 6, rejected: 6, hired: 6 });
            assert.equal(data.items[0].fullName, "Applicant 24");
            assert.equal(data.items[19].fullName, "Applicant 5");
            assert.deepEqual(Object.keys(data.items[0].resume).sort(), ["ext", "originalName", "sizeBytes"]);
            assert.ok(data.items[0].appliedAt);
            assert.equal(JSON.stringify(first.body).includes("publicId"), false);
            assert.equal(JSON.stringify(first.body).includes("oceao/resumes"), false);

            const second = (await adminGet(`/jobs/${target._id}/applications?page=2`)).body.data;
            assert.deepEqual(second.items.map((item) => item.fullName), ["Applicant 4", "Applicant 3", "Applicant 2", "Applicant 1", "Applicant 0"]);

            const hired = (await adminGet(`/jobs/${target._id}/applications?status=hired`)).body.data;
            assert.equal(hired.total, 6);
            assert.ok(hired.items.every((item) => item.status === "hired"));
            assert.deepEqual(hired.counts, data.counts);

            assert.equal((await adminGet(`/jobs/${target._id}/applications?status=maybe`)).status, 400);
            assert.equal((await adminGet(`/jobs/${target._id}/applications?page=0`)).status, 400);
            assert.equal((await adminGet("/jobs/0123456789abcdef01234567/applications")).body.code, "JOB_NOT_FOUND");
        });

        it("an item has every form field", async () => {
            const target = await seedJob();
            await apply(target.slug);
            const [item] = (await adminGet(`/jobs/${target._id}/applications`)).body.data.items;

            for (const key of ["fullName", "email", "phone", "currentLocation", "totalExperienceYears", "currentOrganisation", "currentDesignation",
                "highestQualification", "noticePeriod", "expectedCtc", "profileUrl", "coverNote"]) {
                assert.ok(item[key] !== undefined && item[key] !== null, key);
            }
            assert.equal(item.email, "rahul.sharma@example.com");
            assert.equal(item.status, "new");
            assert.equal(item.jobTitle, "Senior EIA Consultant");
            assert.equal(item.resume.originalName, "Rahul CV.pdf");
        });

        it("PATCH /applications/:applicationId sets the status and writes an audit entry", async () => {
            const target = await seedJob();
            const [doc] = [application(target)];
            await seedApplications([doc]);

            const res = await adminSend("patch", `/applications/${doc.applicationId}`, { status: "shortlisted", performedBy: "Anita" });

            assert.equal(res.status, 200);
            assert.equal(res.body.data.application.status, "shortlisted");
            assert.equal(res.body.data.application.statusUpdatedBy, "Anita");
            assert.equal(JSON.stringify(res.body).includes("publicId"), false);
            assert.equal((await JobApplication.findOne({ applicationId: doc.applicationId }).lean()).status, "shortlisted");
            const [entry] = await audits("career.application.status");
            assert.equal(entry.targetType, "job_application");
            assert.equal(entry.targetId, doc.applicationId);
            assert.equal(entry.detail.status, "shortlisted");

            assert.equal((await adminSend("patch", `/applications/${doc.applicationId}`, { status: "maybe", performedBy: "Anita" })).status, 400);
            assert.equal((await adminSend("patch", `/applications/${doc.applicationId}`, { status: "hired" })).status, 400);
            const missing = await adminSend("patch", "/applications/OE-JA-261025-ZZZ2", { status: "hired", performedBy: "Anita" });
            assert.equal(missing.status, 404);
            assert.equal(missing.body.code, "APPLICATION_NOT_FOUND");
        });

        it("GET /applications/:applicationId/resume gives a signed 5-minute link and audits it", async () => {
            const target = await seedJob();
            const doc = application(target);
            await seedApplications([doc]);

            const before = Math.floor(Date.now() / 1000);
            const res = await adminGet(`/applications/${doc.applicationId}/resume?performedBy=Ravi`);

            assert.equal(res.status, 200);
            assert.equal(res.headers["cache-control"], "no-store");
            assert.match(res.body.data.url, /^https:\/\/api\.cloudinary\.com\//);
            assert.equal(res.body.data.expiresInSeconds, 300);
            const [link] = fake.state.links;
            assert.equal(link.publicId, doc.resume.publicId);
            assert.equal(link.options.resource_type, "raw");
            assert.equal(link.options.type, "private");
            assert.equal(link.options.attachment, true);
            assert.ok(link.options.expires_at >= before + 300 && link.options.expires_at <= before + 302);

            const [entry] = await audits("career.resume.download");
            assert.equal(entry.targetId, doc.applicationId);
            assert.equal(entry.performedBy, "Ravi");

            assert.equal((await adminGet(`/applications/${doc.applicationId}/resume`)).status, 200, "the name is optional");
            assert.equal((await audits("career.resume.download"))[1].performedBy, "Admin");
            assert.equal((await adminGet("/applications/OE-JA-261025-ZZZ2/resume")).body.code, "APPLICATION_NOT_FOUND");
            assert.equal((await adminGet(`/applications/${doc.applicationId}/resume?download=1`)).status, 400);
        });

        it("the CSV: headers, BOM, column order, quoting and the formula guard", async () => {
            const target = await seedJob({ slug: "senior-eia-consultant-k7q2" });
            const at = new Date("2026-10-25T09:00:00.000Z");   // 14:30 IST
            await seedApplications([
                application(target, {
                    applicationId: "OE-JA-261025-AAA2", createdAt: at, fullName: "राहुल \"Rocky\" Sharma, Jr.", email: "rahul@example.com",
                    phone: "+919876543210", totalExperienceYears: 3.5, currentOrganisation: "=HYPERLINK(\"http://evil\")",
                    currentDesignation: "-2+3", noticePeriod: "30 days", expectedCtc: "@SUM(1)", profileUrl: "https://linkedin.com/in/r",
                    coverNote: "Line one\nLine two", status: "shortlisted",
                    resume: { publicId: "oceao/resumes/OE-JA-261025-AAA2.pdf", originalName: "\tcv.pdf", sizeBytes: 100, ext: "pdf" },
                }),
                application(target, { applicationId: "OE-JA-261025-AAB2", createdAt: new Date(at.getTime() + 60000), fullName: "Asha Verma" }),
            ]);

            const res = await adminGet(`/jobs/${target._id}/applications.csv?performedBy=Anita`).buffer(true).parse((r, done) => {
                const chunks = [];
                r.on("data", (chunk) => chunks.push(chunk));
                r.on("end", () => done(null, Buffer.concat(chunks)));
            });

            assert.equal(res.status, 200);
            assert.equal(res.headers["content-type"], "text/csv; charset=utf-8");
            assert.equal(res.headers["content-disposition"], `attachment; filename="senior-eia-consultant-k7q2-applicants-${today()}.csv"`);
            assert.match(res.headers["access-control-expose-headers"], /Content-Disposition/);
            assert.equal(res.headers["cache-control"], "no-store");

            const bytes = res.body;
            assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM first");
            const text = bytes.subarray(3).toString("utf8");
            const lines = text.split("\r\n");
            assert.equal(lines[0], "Application ID,Applied At,Status,Full Name,Email,Phone,Current Location,Total Experience (years),"
                + "Current Organisation,Current Designation,Highest Qualification,Notice Period,Expected CTC,Profile URL,Cover Note,Resume File Name,Job Title");
            assert.ok(lines[1].startsWith("OE-JA-261025-AAB2,"), "newest first");
            assert.ok(text.endsWith("\r\n"));

            const rahul = text.slice(text.indexOf("OE-JA-261025-AAA2"));
            assert.ok(rahul.startsWith('OE-JA-261025-AAA2,25 Oct 2026 14:30,Shortlisted,"राहुल ""Rocky"" Sharma, Jr.",rahul@example.com,\'+919876543210,Pune,3.5,'));
            assert.ok(rahul.includes(`"'=HYPERLINK(""http://evil"")"`), "formula guarded and quoted");
            assert.ok(rahul.includes(",'-2+3,"));
            assert.ok(rahul.includes(",'@SUM(1),"));
            assert.ok(rahul.includes(',"Line one\nLine two",'));
            assert.ok(rahul.includes(",'\tcv.pdf,Senior EIA Consultant"));

            const [entry] = await audits("career.csv.export");
            assert.equal(entry.targetId, String(target._id));
            assert.equal(entry.performedBy, "Anita");
            assert.equal(entry.detail.rows, 2);
        });

        it("the CSV of a job with no applications is just the header row", async () => {
            const target = await seedJob();
            const res = await adminGet(`/jobs/${target._id}/applications.csv`);
            assert.equal(res.status, 200);
            assert.equal(res.text.replace(/^\uFEFF/, "").trim().split("\r\n").length, 1);
            assert.equal((await adminGet("/jobs/0123456789abcdef01234567/applications.csv")).status, 404);
        });

        it("C9: delete is refused while applications exist; list and stats count the real applications", async () => {
            const target = await seedJob();
            await apply(target.slug);
            await apply(target.slug, { fields: { email: "b@example.com" } });
            await JobStat.updateOne({ jobId: target._id }, { $inc: { views: 8 } });

            const refused = await adminSend("delete", `/jobs/${target._id}`, { performedBy: "Anita" });
            assert.equal(refused.status, 409);
            assert.equal(refused.body.code, "JOB_HAS_APPLICATIONS");

            const [listed] = (await adminGet("/jobs")).body.data.jobs;
            assert.equal(listed.totalApplications, 2);
            const stats = (await adminGet(`/jobs/${target._id}/stats?days=7`)).body.data;
            assert.equal(stats.totalApplications, 2);
            assert.equal(stats.totalViews, 8);
            assert.equal(stats.conversionPercent, 25);
            assert.deepEqual(stats.daily.at(-1), { date: today(), views: 8, applications: 2 });

            // a removed application no longer counts (for example after the retention clean-up)
            await JobApplication.deleteMany({ jobId: target._id });
            assert.equal((await adminGet("/jobs")).body.data.jobs[0].totalApplications, 0);
            assert.equal((await adminSend("delete", `/jobs/${target._id}`, { performedBy: "Anita" })).status, 200);
        });
    });

    // ── C10: retention ───────────────────────────────────────────────────────
    describe("retention", () => {
        it("deletes only applications older than the retention period, database first, then their resumes", async () => {
            quiet();
            const target = await seedJob();
            const now = new Date("2026-10-25T10:00:00.000Z");
            const old = [application(target, { createdAt: new Date(now.getTime() - 366 * DAY) }), application(target, { createdAt: new Date(now.getTime() - 365 * DAY - 1) })];
            const keep = [application(target, { createdAt: new Date(now.getTime() - 365 * DAY) }), application(target, { createdAt: new Date(now.getTime() - DAY) })];
            await seedApplications([...old, ...keep]);

            const { removed } = await cleanupOldApplications({ now });

            assert.equal(removed, 2);
            assert.deepEqual((await JobApplication.find().lean()).map((row) => row.applicationId).sort(), keep.map((row) => row.applicationId).sort());
            assert.deepEqual(fake.state.destroys.map((entry) => entry.publicId).sort(), old.map((row) => row.resume.publicId).sort());
            assert.deepEqual(fake.state.rowStillThereAtDestroy, [false, false], "rows deleted before the resumes");
        });

        it("uses CAREERS_RETENTION_DAYS (default 365) or the days given, and handles more than one batch", async () => {
            quiet();
            const target = await seedJob();
            const now = new Date();
            await seedApplications(Array.from({ length: 520 }, () => application(target, { createdAt: new Date(now.getTime() - 40 * DAY) })));

            assert.equal((await cleanupOldApplications({ now })).removed, 0, "365 days by default");
            assert.equal((await cleanupOldApplications({ now, retentionDays: 30 })).removed, 520);
            assert.equal(fake.state.destroys.length, 520);
            assert.equal(await JobApplication.countDocuments(), 0);
        });

        it("runs every day at 03:30 IST and once at start-up, guarded like the other jobs", async () => {
            quiet();
            const calls = [];
            const stop = mock.fn();
            const schedule = (expression, task, options) => { calls.push({ expression, task, options }); return { stop }; };
            const runCareersCleanup = mock.fn(async () => ({ removed: 0 }));

            const stopJobs = startJobs({ schedule, run: async () => {}, runParivesh: async () => {}, isPariveshDue: async () => false, runCareersCleanup });

            const job = calls.find((call) => call.expression === "30 3 * * *");
            assert.ok(job);
            assert.deepEqual(job.options, { timezone: "Asia/Kolkata" });
            assert.equal((await import("node-cron")).default.validate("30 3 * * *"), true);
            assert.equal(runCareersCleanup.mock.callCount(), 1, "at start-up");
            await new Promise((done) => setImmediate(done));
            await job.task();
            assert.equal(runCareersCleanup.mock.callCount(), 2);

            stopJobs();
            assert.equal(stop.mock.callCount(), 3);
        });

        it("a clean-up that throws is logged and the schedule carries on", async () => {
            quiet();
            const calls = [];
            const schedule = (expression, task) => { calls.push({ expression, task }); return { stop() {} }; };
            const runCareersCleanup = mock.fn(async () => { throw new Error("database gone"); });

            startJobs({ schedule, run: async () => {}, runParivesh: async () => {}, isPariveshDue: async () => false, runCareersCleanup });
            await new Promise((done) => setImmediate(done));
            await calls.find((call) => call.expression === "30 3 * * *").task();

            assert.equal(runCareersCleanup.mock.callCount(), 2);
        });
    });

    // ── C1: the two variables ────────────────────────────────────────────────
    describe("CAREERS_MAIL and CAREERS_RETENTION_DAYS", () => {
        const root = fileURLToPath(new URL("..", import.meta.url));
        const load = (extra = {}) => {
            const env = {
                PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: "test", EMAIL_MODE: "test",
                MONGODB_URI: "mongodb://127.0.0.1:27017", CORS_ORIGINS: TEST_ORIGIN, MAIL_FROM: "a@b.c", COMPANY_MAIL: "info@oceao.test",
                OTP_SECRET: "o".repeat(40), BOOKING_TOKEN_SECRET: "b".repeat(40), TURNSTILE_SECRET_KEY: "t", DATA_GOV_API_KEY: "d",
                CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s",
                ...TEST_ADMIN_ENV,
                ...extra,
            };
            const code = "const { config } = await import('./src/config/env.js'); console.log(JSON.stringify({ mail: config.CAREERS_MAIL, days: config.CAREERS_RETENTION_DAYS }))";
            const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, env, encoding: "utf8", timeout: 30000 });
            return { ...result, values: result.status === 0 ? JSON.parse(result.stdout.trim().split("\n").at(-1)) : null };
        };

        it("both are optional: applications go to COMPANY_MAIL and are kept 365 days", () => {
            assert.deepEqual(load().values, { mail: "info@oceao.test", days: 365 });
            assert.deepEqual(load({ CAREERS_MAIL: "", CAREERS_RETENTION_DAYS: " " }).values, { mail: "info@oceao.test", days: 365 });
        });

        it("set values are used", () => {
            assert.deepEqual(load({ CAREERS_MAIL: "hr@oceao.test", CAREERS_RETENTION_DAYS: "180" }).values, { mail: "hr@oceao.test", days: 180 });
        });

        it("invalid values stop the server, naming the variable", () => {
            for (const [name, value] of [["CAREERS_MAIL", "not-an-email"], ["CAREERS_RETENTION_DAYS", "0"], ["CAREERS_RETENTION_DAYS", "1.5"], ["CAREERS_RETENTION_DAYS", "forever"]]) {
                const result = load({ [name]: value });
                assert.equal(result.status, 1, `${name}=${value}`);
                assert.match(result.stderr, new RegExp(name));
            }
        });
    });
});
