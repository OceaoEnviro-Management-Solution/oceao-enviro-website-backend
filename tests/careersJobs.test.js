// Careers B1: the job model, the status function, the admin job endpoints, the public job API and
// the page view counter with its daily stats. No network: nothing here calls an outside service.

import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import request from "supertest";
import {
    startTestEnv, stopTestEnv, resetState, getApp, rateLimiting,
    TEST_ORIGIN, TEST_ADMIN_PASSWORD_HASH, TEST_ADMIN_JWT_SECRET,
} from "./helpers/setup.js";

const ADMIN = "/api/v1/admin/careers/jobs";
const PUBLIC = "/api/v1/careers/jobs";
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let Job;
let JobStat;
let AuditLog;
let incrementJobStat;
let getJobStatus;
let isPubliclyVisible;
let format;
let generateJobSlug;
let JOB_SLUG_PATTERN;
let nowIST;
let addDays;

const passwordVersion = crypto.createHash("sha256").update(TEST_ADMIN_PASSWORD_HASH).digest("hex").slice(0, 12);
const sessionCookie = () =>
    `oe_admin=${jwt.sign({ sub: "admin", pwv: passwordVersion }, TEST_ADMIN_JWT_SECRET, { algorithm: "HS256", expiresIn: 3600 })}`;

// Admin JSON writes, as the admin screen sends them
const send = (method, path, body = {}, { cookie = true } = {}) => {
    const req = request(getApp())[method](`${ADMIN}${path}`).set("Content-Type", "application/json").set("Origin", TEST_ORIGIN);
    if (cookie) req.set("Cookie", sessionCookie());
    return req.send(body);
};
const adminGet = (path = "", { cookie = true } = {}) => {
    const req = request(getApp()).get(`${ADMIN}${path}`);
    return cookie ? req.set("Cookie", sessionCookie()) : req;
};
const publicGet = (path = "") => request(getApp()).get(`${PUBLIC}${path}`);
const view = (slug, userAgent = BROWSER) => {
    const req = request(getApp()).post(`${PUBLIC}/${slug}/view`);
    return userAgent === null ? req.unset("User-Agent") : req.set("User-Agent", userAgent);
};

// What the admin form sends for a new job
const FORM = {
    title: "Senior EIA Consultant",
    department: "Environmental Clearance",
    location: "New Delhi",
    employmentType: "Full-time",
    workMode: "Hybrid",
    experienceMin: 3,
    experienceMax: 6,
    openings: 2,
    salaryText: "Rs 8-12 LPA",
    summary: "Lead EIA studies for infrastructure projects.",
    responsibilities: "Prepare EIA reports\nCoordinate baseline monitoring\nPresent at EAC meetings",
    requirements: "M.Sc. or M.Tech in Environmental Science\n3+ years of EIA work",
    niceToHave: "NABET accredited EIA coordinator",
    visible: true,
    performedBy: "Anita",
};

// A job stored directly, with dates relative to now
const job = (overrides = {}) => ({
    slug: `job-${crypto.randomBytes(3).toString("hex")}-k7q2`,
    title: "Field Monitoring Officer",
    department: "Monitoring",
    location: "Gurugram",
    employmentType: "Full-time",
    workMode: "On-site",
    experienceMin: 0,
    experienceMax: 2,
    summary: "Ambient air and noise monitoring.",
    responsibilities: "Run samplers\nLog readings",
    requirements: "B.Sc. in any science",
    visible: true,
    acceptingApplications: true,
    publishAt: new Date(Date.now() - DAY),
    archived: false,
    ...overrides,
});
const seed = async (...overrides) => Job.insertMany(overrides.map((value) => job(value)));
const audits = (action) => AuditLog.find({ action }).lean();
const applications = () => mongoose.connection.db.collection("jobapplications");
// A bare application document, written straight to the collection (B2 owns the real model)
const fakeApplication = (jobId, n = 1) => ({ jobId, applicationId: `OE-JA-261025-AA${"ABCDEFGH"[n]}2`, email: `c${n}@example.com` });
const today = () => nowIST(new Date()).dateKey;

const CARD_FIELDS = [
    "slug", "title", "department", "location", "employmentType", "workMode", "experienceMin", "experienceMax",
    "openings", "salaryText", "summary", "postedOn", "closesOn", "acceptingApplications",
].sort();

describe("Careers jobs", () => {
    before(async () => {
        await startTestEnv();
        ({ Job } = await import("../src/models/job.model.js"));
        ({ JobStat, incrementJobStat } = await import("../src/models/jobStat.model.js"));
        ({ AuditLog } = await import("../src/models/auditLog.model.js"));
        ({ getJobStatus, isPubliclyVisible } = await import("../src/services/careers/jobStatus.js"));
        format = await import("../src/services/careers/jobFormat.js");
        ({ generateJobSlug, JOB_SLUG_PATTERN } = await import("../src/utils/ids.js"));
        ({ nowIST, addDays } = await import("../src/utils/time.js"));
        await Job.init();
        await JobStat.init();
    });
    after(stopTestEnv);
    beforeEach(async () => {
        await resetState();
        await applications().deleteMany({});
    });
    afterEach(() => mock.restoreAll());

    // ── C4: status ───────────────────────────────────────────────────────────
    describe("status function", () => {
        const NOW = new Date("2026-10-25T06:00:00.000Z");
        const base = { archived: false, visible: true, acceptingApplications: true, publishAt: new Date(NOW.getTime() - HOUR), closesAt: null };
        const status = (overrides) => getJobStatus({ ...base, ...overrides }, NOW);

        it("gives each of the 5 states", () => {
            assert.equal(status({}), "live");
            assert.equal(status({ archived: true }), "archived");
            assert.equal(status({ visible: false }), "hidden");
            assert.equal(status({ publishAt: new Date(NOW.getTime() + HOUR) }), "scheduled");
            assert.equal(status({ acceptingApplications: false }), "closed");
            assert.equal(status({ closesAt: new Date(NOW.getTime() - 1) }), "closed");
        });

        it("checks in the order archived, hidden, scheduled, closed", () => {
            const everything = { archived: true, visible: false, publishAt: new Date(NOW.getTime() + HOUR), acceptingApplications: false };
            assert.equal(status(everything), "archived");
            assert.equal(status({ ...everything, archived: false }), "hidden");
            assert.equal(status({ ...everything, archived: false, visible: true }), "scheduled");
            assert.equal(status({ ...everything, archived: false, visible: true, publishAt: NOW }), "closed");
        });

        it("boundaries: publishAt equal to now is live, now equal to closesAt is closed", () => {
            assert.equal(status({ publishAt: NOW }), "live");
            assert.equal(status({ publishAt: new Date(NOW.getTime() + 1) }), "scheduled");
            assert.equal(status({ closesAt: NOW }), "closed");
            assert.equal(status({ closesAt: new Date(NOW.getTime() + 1) }), "live");
        });

        it("accepts dates as strings too (lean documents, JSON)", () => {
            assert.equal(status({ publishAt: NOW.toISOString(), closesAt: NOW.toISOString() }), "closed");
        });

        it("isPubliclyVisible is true for live and closed only", () => {
            assert.equal(isPubliclyVisible({ ...base }, NOW), true);
            assert.equal(isPubliclyVisible({ ...base, acceptingApplications: false }, NOW), true);
            assert.equal(isPubliclyVisible({ ...base, archived: true }, NOW), false);
            assert.equal(isPubliclyVisible({ ...base, visible: false }, NOW), false);
            assert.equal(isPubliclyVisible({ ...base, publishAt: new Date(NOW.getTime() + 1) }, NOW), false);
        });
    });

    // ── IST dates ────────────────────────────────────────────────────────────
    describe("IST dates", () => {
        it("publishAt { date, time } is that IST wall-clock moment", () => {
            assert.equal(format.publishAtFrom({ date: "2026-11-01", time: "10:00" }).toISOString(), "2026-11-01T04:30:00.000Z");
            assert.equal(format.publishAtFrom({ date: "2026-11-01", time: "00:15" }).toISOString(), "2026-10-31T18:45:00.000Z");
        });

        it("closesAt is the last millisecond of the chosen IST day", () => {
            const closesAt = format.closesAtFrom("2026-11-30");
            assert.equal(closesAt.toISOString(), "2026-11-30T18:29:59.999Z");
            assert.equal(format.istDateKey(closesAt), "2026-11-30");
            assert.equal(format.istDateKey(new Date(closesAt.getTime() + 1)), "2026-12-01");
        });

        it("istDateKey and istTime read a moment in IST (not the server's zone)", () => {
            const lateUtc = new Date("2026-10-25T19:05:00.000Z");   // 00:35 on the 26th in IST
            assert.equal(format.istDateKey(lateUtc), "2026-10-26");
            assert.equal(format.istTime(lateUtc), "00:35");
            assert.equal(format.istTime(new Date("2026-10-25T08:30:00.000Z")), "14:00");
        });
    });

    // ── C3: slug ─────────────────────────────────────────────────────────────
    describe("slug", () => {
        it("is the kebab-case title + '-' + 4 lowercase characters of the id alphabet", () => {
            const slug = generateJobSlug("Senior EIA Consultant (Delhi NCR)");
            assert.match(slug, /^senior-eia-consultant-delhi-ncr-[23456789abcdefghjkmnpqrstvwxyz]{4}$/);
            assert.match(slug, JOB_SLUG_PATTERN);
        });

        it("cuts the title part to 60 characters, drops accents and never ends a part with '-'", () => {
            const slug = generateJobSlug(`Ingénieur ${"a".repeat(80)}`);
            const [titlePart] = slug.split(/-(?=[^-]+$)/);
            assert.ok(titlePart.length <= 60, titlePart);
            assert.ok(titlePart.startsWith("ingenieur-a"));
            assert.match(generateJobSlug("Lab -- Analyst --"), /^lab-analyst-[a-z0-9]{4}$/);
        });

        it("a title with no Latin letters or digits still gets a slug", () => {
            assert.match(generateJobSlug("पर्यावरण सलाहकार"), /^job-[a-z0-9]{4}$/);
        });

        it("never changes when the title is edited", async () => {
            const created = (await send("post", "", FORM)).body.data.job;
            const edited = (await send("patch", `/${created.id}`, { title: "Principal EIA Consultant", performedBy: "Anita" })).body.data.job;

            assert.equal(edited.title, "Principal EIA Consultant");
            assert.equal(edited.slug, created.slug);
        });
    });

    // ── C5: daily stats counter ──────────────────────────────────────────────
    describe("incrementJobStat", () => {
        it("adds one per call to today's IST document, with no lost counts in parallel", async () => {
            const [stored] = await seed({});
            await Promise.all(Array.from({ length: 25 }, () => incrementJobStat(stored._id, "views")));
            await incrementJobStat(stored._id, "applications");

            const docs = await JobStat.find({ jobId: stored._id }).lean();
            assert.equal(docs.length, 1);
            assert.equal(docs[0].date, today());
            assert.equal(docs[0].views, 25);
            assert.equal(docs[0].applications, 1);
        });

        it("uses the IST date of `now`", async () => {
            const [stored] = await seed({});
            await incrementJobStat(stored._id, "views", new Date("2026-10-25T19:00:00.000Z"));
            assert.equal((await JobStat.findOne({ jobId: stored._id }).lean()).date, "2026-10-26");
        });

        it("refuses an unknown field", async () => {
            await assert.rejects(incrementJobStat(new mongoose.Types.ObjectId(), "likes"), RangeError);
        });
    });

    // ── Access ───────────────────────────────────────────────────────────────
    describe("access", () => {
        const ID = "0123456789abcdef01234567";
        const ROUTES = [
            ["get", ""], ["post", ""], ["get", `/${ID}`], ["patch", `/${ID}`], ["delete", `/${ID}`],
            ["patch", `/${ID}/visibility`], ["patch", `/${ID}/intake`], ["post", `/${ID}/duplicate`],
            ["post", `/${ID}/archive`], ["post", `/${ID}/unarchive`], ["get", `/${ID}/stats`],
        ];

        for (const [method, path] of ROUTES) {
            it(`${method.toUpperCase()} /admin/careers/jobs${path.replace(ID, ":id")} without a session is 401`, async () => {
                const res = method === "get" ? await adminGet(path, { cookie: false }) : await send(method, path, FORM, { cookie: false });

                assert.equal(res.status, 401);
                assert.equal(res.body.code, "ADMIN_UNAUTHORIZED");
                assert.equal(await Job.countDocuments(), 0);
            });
        }

        it("writes without the frontend Origin are refused (CSRF)", async () => {
            const res = await request(getApp()).post(ADMIN).set("Cookie", sessionCookie()).set("Content-Type", "application/json").send(FORM);

            assert.equal(res.status, 403);
            assert.equal(res.body.code, "CSRF_REJECTED");
        });
    });

    // ── C6: create ───────────────────────────────────────────────────────────
    describe("POST /admin/careers/jobs", () => {
        it("creates a job: 201, status, slug, publishAt defaults to now, audit entry", async () => {
            const before = Date.now();
            const res = await send("post", "", FORM);

            assert.equal(res.status, 201);
            const created = res.body.data.job;
            assert.equal(created.status, "live");
            assert.match(created.slug, /^senior-eia-consultant-[a-z0-9]{4}$/);
            assert.ok(Date.parse(created.publishAt) >= before - 1000 && Date.parse(created.publishAt) <= Date.now());
            assert.equal(created.publishDate, today());
            assert.equal(created.closesAt, null);
            assert.equal(created.closesOn, null);
            assert.equal(created.acceptingApplications, true);
            assert.equal(created.archived, false);
            assert.equal(created.responsibilities, FORM.responsibilities);

            const [entry] = await audits("career.job.create");
            assert.equal(entry.targetType, "job");
            assert.equal(entry.targetId, created.id);
            assert.equal(entry.performedBy, "Anita");
        });

        it("a new job is hidden unless visible is sent", async () => {
            const { visible, ...form } = FORM;
            const created = (await send("post", "", form)).body.data.job;

            assert.equal(visible, true);
            assert.equal(created.visible, false);
            assert.equal(created.status, "hidden");
        });

        it("stores publishAt { date, time } as IST and closesAt as the end of that IST day", async () => {
            const res = await send("post", "", { ...FORM, publishAt: { date: "2030-01-15", time: "09:30" }, closesAt: "2030-02-28" });

            assert.equal(res.status, 201);
            const created = res.body.data.job;
            assert.equal(created.publishAt, "2030-01-15T04:00:00.000Z");
            assert.equal(created.publishDate, "2030-01-15");
            assert.equal(created.publishTime, "09:30");
            assert.equal(created.closesAt, "2030-02-28T18:29:59.999Z");
            assert.equal(created.closesOn, "2030-02-28");
            assert.equal(created.status, "scheduled");

            const stored = await Job.findById(created.id).lean();
            assert.equal(stored.publishAt.toISOString(), "2030-01-15T04:00:00.000Z");
            assert.equal(stored.closesAt.toISOString(), "2030-02-28T18:29:59.999Z");
        });

        it("the deadline may be the publish day itself, but not before it", async () => {
            const sameDay = await send("post", "", { ...FORM, publishAt: { date: "2030-01-15", time: "23:00" }, closesAt: "2030-01-15" });
            assert.equal(sameDay.status, 201);

            const before = await send("post", "", { ...FORM, publishAt: { date: "2030-01-15", time: "09:30" }, closesAt: "2030-01-14" });
            assert.equal(before.status, 400);
            assert.equal(before.body.code, "VALIDATION_FAILED");
            assert.ok(before.body.errors.closesAt);

            const beforeToday = await send("post", "", { ...FORM, closesAt: addDays(today(), -1) });
            assert.equal(beforeToday.status, 400);
            assert.ok(beforeToday.body.errors.closesAt);
            assert.equal(await Job.countDocuments(), 1);
        });

        it("refuses experienceMin above experienceMax with a field error", async () => {
            const res = await send("post", "", { ...FORM, experienceMin: 7, experienceMax: 3 });

            assert.equal(res.status, 400);
            assert.ok(res.body.errors.experienceMax);
            assert.equal(await Job.countDocuments(), 0);
        });

        it("validates every field (limits, enums, whole numbers, dates)", async () => {
            const cases = [
                [{ title: "ab" }, "title"],
                [{ title: "a".repeat(121) }, "title"],
                [{ department: "a" }, "department"],
                [{ location: "a".repeat(121) }, "location"],
                [{ employmentType: "Freelance" }, "employmentType"],
                [{ workMode: "Anywhere" }, "workMode"],
                [{ experienceMin: -1 }, "experienceMin"],
                [{ experienceMax: 41 }, "experienceMax"],
                [{ experienceMin: 1.5 }, "experienceMin"],
                [{ openings: 0 }, "openings"],
                [{ openings: 101 }, "openings"],
                [{ salaryText: "a".repeat(81) }, "salaryText"],
                [{ summary: "" }, "summary"],
                [{ summary: "a".repeat(301) }, "summary"],
                [{ responsibilities: "a".repeat(5001) }, "responsibilities"],
                [{ requirements: "   " }, "requirements"],
                [{ niceToHave: "a".repeat(3001) }, "niceToHave"],
                [{ visible: "yes" }, "visible"],
                [{ publishAt: { date: "2030-02-30", time: "10:00" } }, "publishAt"],
                [{ publishAt: { date: "2030-02-01", time: "24:00" } }, "publishAt"],
                [{ publishAt: "2030-02-01T10:00" }, "publishAt"],
                [{ closesAt: "30/11/2030" }, "closesAt"],
                [{ performedBy: "A" }, "performedBy"],
            ];
            for (const [change, field] of cases) {
                const res = await send("post", "", { ...FORM, ...change });
                assert.equal(res.status, 400, JSON.stringify(change));
                assert.ok(res.body.errors[field], `${JSON.stringify(change)} -> ${JSON.stringify(res.body.errors)}`);
            }
            assert.equal(await Job.countDocuments(), 0);
        });

        it("is strict: slug, archived and unknown fields are refused", async () => {
            for (const extra of [{ slug: "my-own-slug" }, { archived: true }, { status: "live" }, { publishAt: { date: "2030-01-01", time: "10:00", zone: "UTC" } }]) {
                const res = await send("post", "", { ...FORM, ...extra });
                assert.equal(res.status, 400, JSON.stringify(extra));
            }
        });

        it("keeps line breaks as \\n and trims the texts; blank optional texts are left out", async () => {
            const created = (await send("post", "", {
                ...FORM, title: "  Lab Analyst  ", responsibilities: "  Run tests\r\nWrite reports\r\n", salaryText: "", niceToHave: "  ",
            })).body.data.job;

            assert.equal(created.title, "Lab Analyst");
            assert.equal(created.responsibilities, "Run tests\nWrite reports");
            assert.equal(created.salaryText, null);
            assert.equal(created.niceToHave, null);
            const stored = await Job.findById(created.id).lean();
            assert.equal("salaryText" in stored, false);
        });

        it("text is stored exactly as typed (never interpreted as HTML)", async () => {
            const created = (await send("post", "", { ...FORM, summary: "<b>Bold</b> & <script>x</script>" })).body.data.job;
            assert.equal(created.summary, "<b>Bold</b> & <script>x</script>");
        });
    });

    // ── C6: list and read ────────────────────────────────────────────────────
    describe("GET /admin/careers/jobs and /:id", () => {
        it("lists non-archived jobs newest first with status and all-time totals (applications counted from the applications)", async () => {
            const [older] = await Job.create([job({ title: "Older" })]);
            await new Promise((resolve) => setTimeout(resolve, 5));
            const [newer] = await Job.create([job({ title: "Newer", visible: false })]);
            await Job.create([job({ title: "Archived", archived: true })]);
            await JobStat.create([
                { jobId: older._id, date: "2026-09-01", views: 10, applications: 2 },
                { jobId: older._id, date: today(), views: 5, applications: 1 },
            ]);
            await applications().insertMany([1, 2, 3, 4].map((n) => fakeApplication(older._id, n)));

            const res = await adminGet();

            assert.equal(res.status, 200);
            const { jobs } = res.body.data;
            assert.deepEqual(jobs.map((item) => item.title), ["Newer", "Older"]);
            assert.equal(jobs[0].status, "hidden");
            assert.equal(jobs[0].totalViews, 0);
            assert.equal(jobs[0].totalApplications, 0);
            assert.equal(jobs[1].status, "live");
            assert.equal(jobs[1].totalViews, 15);
            assert.equal(jobs[1].totalApplications, 4);
            assert.equal(jobs[1].id, String(older._id));
            assert.equal(newer.slug, jobs[0].slug);
        });

        it("?includeArchived=true adds archived jobs", async () => {
            await seed({ title: "Open" }, { title: "Archived", archived: true });

            const all = (await adminGet("?includeArchived=true")).body.data.jobs;
            assert.deepEqual(all.map((item) => item.status).sort(), ["archived", "live"]);
            assert.equal((await adminGet("?includeArchived=false")).body.data.jobs.length, 1);
            assert.equal((await adminGet("?includeArchived=yes")).status, 400);
            assert.equal((await adminGet("?archived=true")).status, 400);
        });

        it("GET /:id gives the full job with its status", async () => {
            const [stored] = await seed({ closesAt: new Date(Date.now() - HOUR), publishAt: new Date(Date.now() - DAY) });

            const res = await adminGet(`/${stored._id}`);

            assert.equal(res.status, 200);
            assert.equal(res.body.data.job.status, "closed");
            assert.equal(res.body.data.job.requirements, stored.requirements);
        });

        it("an unknown or malformed id is 404 JOB_NOT_FOUND on every :id route", async () => {
            for (const id of ["0123456789abcdef01234567", "not-an-id", "123456789012", "0123456789abcdef0123456z"]) {
                const responses = [
                    await adminGet(`/${id}`),
                    await adminGet(`/${id}/stats`),
                    await send("patch", `/${id}`, { title: "New title", performedBy: "Anita" }),
                    await send("patch", `/${id}/visibility`, { visible: true, performedBy: "Anita" }),
                    await send("patch", `/${id}/intake`, { acceptingApplications: true, performedBy: "Anita" }),
                    await send("post", `/${id}/duplicate`, { performedBy: "Anita" }),
                    await send("post", `/${id}/archive`, { performedBy: "Anita" }),
                    await send("post", `/${id}/unarchive`, { performedBy: "Anita" }),
                    await send("delete", `/${id}`, { performedBy: "Anita" }),
                ];
                for (const res of responses) {
                    assert.equal(res.status, 404, `${id}: ${res.req.method} ${res.req.path}`);
                    assert.equal(res.body.code, "JOB_NOT_FOUND");
                }
            }
            assert.equal(await AuditLog.countDocuments(), 0);
        });
    });

    // ── C6: edit ─────────────────────────────────────────────────────────────
    describe("PATCH /admin/careers/jobs/:id", () => {
        let created;
        beforeEach(async () => {
            created = (await send("post", "", { ...FORM, publishAt: { date: "2026-10-01", time: "10:00" } })).body.data.job;
        });

        it("edits any field and writes an audit entry naming the fields", async () => {
            const res = await send("patch", `/${created.id}`, {
                department: "Air Quality", workMode: "Remote", experienceMax: 8, summary: "New summary.", performedBy: "Ravi",
            });

            assert.equal(res.status, 200);
            const edited = res.body.data.job;
            assert.equal(edited.department, "Air Quality");
            assert.equal(edited.workMode, "Remote");
            assert.equal(edited.experienceMax, 8);
            assert.equal(edited.title, FORM.title);

            const [entry] = await audits("career.job.edit");
            assert.equal(entry.performedBy, "Ravi");
            assert.deepEqual(entry.detail.fields.sort(), ["department", "experienceMax", "summary", "workMode"]);
        });

        it("moves publishAt and sets or clears the deadline, both in IST", async () => {
            const moved = (await send("patch", `/${created.id}`, { publishAt: { date: "2031-03-10", time: "18:45" }, closesAt: "2031-03-31", performedBy: "Anita" })).body.data.job;
            assert.equal(moved.publishAt, "2031-03-10T13:15:00.000Z");
            assert.equal(moved.closesAt, "2031-03-31T18:29:59.999Z");
            assert.equal(moved.status, "scheduled");

            const cleared = (await send("patch", `/${created.id}`, { closesAt: null, performedBy: "Anita" })).body.data.job;
            assert.equal(cleared.closesAt, null);
            assert.equal("closesAt" in (await Job.findById(created.id).lean()), false);
        });

        it("null or '' removes openings, salary text and nice to have", async () => {
            const edited = (await send("patch", `/${created.id}`, { openings: null, salaryText: "", niceToHave: null, performedBy: "Anita" })).body.data.job;
            assert.equal(edited.openings, null);
            assert.equal(edited.salaryText, null);
            assert.equal(edited.niceToHave, null);

            const stored = await Job.findById(created.id).lean();
            for (const key of ["openings", "salaryText", "niceToHave"]) assert.equal(key in stored, false, key);
        });

        it("checks the two cross-field rules against the stored values", async () => {
            const tooLow = await send("patch", `/${created.id}`, { experienceMax: 2, performedBy: "Anita" });   // stored min is 3
            assert.equal(tooLow.status, 400);
            assert.ok(tooLow.body.errors.experienceMax);

            const early = await send("patch", `/${created.id}`, { closesAt: "2026-09-30", performedBy: "Anita" });   // published 1 Oct
            assert.equal(early.status, 400);
            assert.ok(early.body.errors.closesAt);

            await send("patch", `/${created.id}`, { closesAt: "2026-12-31", performedBy: "Anita" });
            const late = await send("patch", `/${created.id}`, { publishAt: { date: "2027-01-01", time: "09:00" }, performedBy: "Anita" });
            assert.equal(late.status, 400);
            assert.ok(late.body.errors.closesAt);

            const stored = await Job.findById(created.id).lean();
            assert.equal(stored.experienceMax, 6);
            assert.equal(stored.publishAt.toISOString(), "2026-10-01T04:30:00.000Z");
            assert.equal((await audits("career.job.edit")).length, 1);
        });

        it("needs at least one field, and slug or archived cannot be sent", async () => {
            assert.equal((await send("patch", `/${created.id}`, { performedBy: "Anita" })).status, 400);
            assert.equal((await send("patch", `/${created.id}`, { slug: "new-slug", performedBy: "Anita" })).status, 400);
            assert.equal((await send("patch", `/${created.id}`, { archived: true, performedBy: "Anita" })).status, 400);
            assert.equal((await send("patch", `/${created.id}`, { title: "New title" })).status, 400);
            assert.equal((await audits("career.job.edit")).length, 0);
        });
    });

    // ── C6: switches ─────────────────────────────────────────────────────────
    describe("visibility, intake, archive", () => {
        let created;
        beforeEach(async () => {
            created = (await send("post", "", FORM)).body.data.job;
        });

        it("PATCH /visibility hides and shows the job", async () => {
            const hidden = await send("patch", `/${created.id}/visibility`, { visible: false, performedBy: "Anita" });
            assert.equal(hidden.status, 200);
            assert.equal(hidden.body.data.job.status, "hidden");
            assert.equal((await publicGet()).body.data.jobs.length, 0);

            const shown = await send("patch", `/${created.id}/visibility`, { visible: true, performedBy: "Anita" });
            assert.equal(shown.body.data.job.status, "live");
            assert.equal((await publicGet()).body.data.jobs.length, 1);

            const entries = await audits("career.job.visibility");
            assert.deepEqual(entries.map((entry) => entry.detail.visible), [false, true]);
            assert.equal((await send("patch", `/${created.id}/visibility`, { performedBy: "Anita" })).status, 400);
            assert.equal((await send("patch", `/${created.id}/visibility`, { visible: "false", performedBy: "Anita" })).status, 400);
        });

        it("PATCH /intake closes and reopens applications; the job stays on the site", async () => {
            const closed = await send("patch", `/${created.id}/intake`, { acceptingApplications: false, performedBy: "Anita" });
            assert.equal(closed.status, 200);
            assert.equal(closed.body.data.job.status, "closed");
            const [card] = (await publicGet()).body.data.jobs;
            assert.equal(card.acceptingApplications, false);

            const reopened = await send("patch", `/${created.id}/intake`, { acceptingApplications: true, performedBy: "Anita" });
            assert.equal(reopened.body.data.job.status, "live");
            assert.equal((await audits("career.job.intake")).length, 2);
        });

        it("archive and unarchive", async () => {
            const archived = await send("post", `/${created.id}/archive`, { performedBy: "Anita" });
            assert.equal(archived.status, 200);
            assert.equal(archived.body.data.job.status, "archived");
            assert.equal((await adminGet()).body.data.jobs.length, 0);
            assert.equal((await publicGet()).body.data.jobs.length, 0);

            const restored = await send("post", `/${created.id}/unarchive`, { performedBy: "Anita" });
            assert.equal(restored.body.data.job.status, "live");
            assert.equal((await adminGet()).body.data.jobs.length, 1);
            assert.equal((await audits("career.job.archive")).length, 1);
            assert.equal((await audits("career.job.unarchive")).length, 1);
            assert.equal((await send("post", `/${created.id}/archive`, { performedBy: "Anita", reason: "old" })).status, 400);
        });
    });

    // ── C6: duplicate ────────────────────────────────────────────────────────
    describe("POST /:id/duplicate", () => {
        it("copies the job: '(copy)' title, new slug, hidden, publish now, no deadline, no stats", async () => {
            const source = (await send("post", "", { ...FORM, publishAt: { date: "2026-01-05", time: "10:00" }, closesAt: "2026-02-01" })).body.data.job;
            await send("patch", `/${source.id}/intake`, { acceptingApplications: false, performedBy: "Anita" });
            await send("post", `/${source.id}/archive`, { performedBy: "Anita" });
            await JobStat.create({ jobId: source.id, date: "2026-01-10", views: 40, applications: 4 });

            const before = Date.now();
            const res = await send("post", `/${source.id}/duplicate`, { performedBy: "Ravi" });

            assert.equal(res.status, 201);
            const copy = res.body.data.job;
            assert.notEqual(copy.id, source.id);
            assert.equal(copy.title, `${FORM.title} (copy)`);
            assert.notEqual(copy.slug, source.slug);
            assert.match(copy.slug, /^senior-eia-consultant-copy-[a-z0-9]{4}$/);
            assert.equal(copy.visible, false);
            assert.equal(copy.acceptingApplications, true);
            assert.equal(copy.archived, false);
            assert.equal(copy.status, "hidden");
            assert.ok(Date.parse(copy.publishAt) >= before - 1000);
            assert.equal(copy.closesAt, null);
            for (const key of ["department", "location", "employmentType", "workMode", "experienceMin", "experienceMax", "openings", "salaryText", "summary", "responsibilities", "requirements", "niceToHave"]) {
                assert.deepEqual(copy[key], source[key], key);
            }
            assert.equal(await JobStat.countDocuments({ jobId: copy.id }), 0);
            assert.equal((await adminGet(`/${copy.id}/stats`)).body.data.totalViews, 0);

            const [entry] = await audits("career.job.duplicate");
            assert.equal(entry.targetId, copy.id);
            assert.equal(entry.detail.fromJobId, source.id);
            assert.equal(entry.performedBy, "Ravi");
        });

        it("keeps a long title within 120 characters", async () => {
            const source = (await send("post", "", { ...FORM, title: "T".repeat(120) })).body.data.job;
            const copy = (await send("post", `/${source.id}/duplicate`, { performedBy: "Anita" })).body.data.job;

            assert.equal(copy.title.length, 120);
            assert.ok(copy.title.endsWith(" (copy)"));
        });
    });

    // ── C6: delete ───────────────────────────────────────────────────────────
    describe("DELETE /:id", () => {
        it("is refused with 409 JOB_HAS_APPLICATIONS when the job has an application", async () => {
            const created = (await send("post", "", FORM)).body.data.job;
            await applications().insertOne(fakeApplication(new mongoose.Types.ObjectId(created.id)));

            const res = await send("delete", `/${created.id}`, { performedBy: "Anita" });

            assert.equal(res.status, 409);
            assert.equal(res.body.code, "JOB_HAS_APPLICATIONS");
            assert.equal(res.body.message, "This job has applications. Archive it instead.");
            assert.equal(await Job.countDocuments(), 1);
            assert.equal((await audits("career.job.delete")).length, 0);
        });

        it("deletes a job with no applications, and its stats", async () => {
            const [keep, remove] = await seed({ title: "Keep" }, { title: "Remove" });
            await JobStat.create([
                { jobId: remove._id, date: "2026-10-01", views: 3 },
                { jobId: remove._id, date: "2026-10-02", views: 4 },
                { jobId: keep._id, date: "2026-10-02", views: 9 },
            ]);
            await applications().insertOne(fakeApplication(keep._id));

            const res = await send("delete", `/${remove._id}`, { performedBy: "Anita" });

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { id: String(remove._id), deleted: true });
            assert.equal(await Job.exists({ _id: remove._id }), null);
            assert.equal(await JobStat.countDocuments({ jobId: remove._id }), 0);
            assert.equal(await JobStat.countDocuments({ jobId: keep._id }), 1);
            const [entry] = await audits("career.job.delete");
            assert.equal(entry.targetId, String(remove._id));
            assert.equal(entry.detail.title, "Remove");
        });

        it("needs performedBy", async () => {
            const [stored] = await seed({});
            assert.equal((await send("delete", `/${stored._id}`, {})).status, 400);
            assert.equal(await Job.countDocuments(), 1);
        });
    });

    // ── C6: stats ────────────────────────────────────────────────────────────
    describe("GET /:id/stats", () => {
        it("fills every day of the range (oldest first) and gives all-time totals and conversion", async () => {
            const [stored] = await seed({});
            const now = today();
            await JobStat.create([
                { jobId: stored._id, date: now, views: 7, applications: 1 },
                { jobId: stored._id, date: addDays(now, -2), views: 5, applications: 1 },
                { jobId: stored._id, date: addDays(now, -200), views: 3, applications: 0 },
            ]);
            await applications().insertMany([1, 2].map((n) => fakeApplication(stored._id, n)));

            const res = await adminGet(`/${stored._id}/stats?days=7`);

            assert.equal(res.status, 200);
            const stats = res.body.data;
            assert.equal(stats.totalViews, 15);
            assert.equal(stats.totalApplications, 2);
            assert.equal(stats.conversionPercent, 13.3);
            assert.equal(stats.daily.length, 7);
            assert.equal(stats.daily[0].date, addDays(now, -6));
            assert.deepEqual(stats.daily.at(-1), { date: now, views: 7, applications: 1 });
            assert.deepEqual(stats.daily.at(-3), { date: addDays(now, -2), views: 5, applications: 1 });
            assert.deepEqual(stats.daily[1], { date: addDays(now, -5), views: 0, applications: 0 });
        });

        it("defaults to 30 days, allows 90, refuses more; conversion is 0 with no views", async () => {
            const [stored] = await seed({});

            const fallback = (await adminGet(`/${stored._id}/stats`)).body.data;
            assert.equal(fallback.daily.length, 30);
            assert.equal(fallback.conversionPercent, 0);
            assert.equal(fallback.totalViews, 0);
            assert.equal((await adminGet(`/${stored._id}/stats?days=90`)).body.data.daily.length, 90);
            for (const days of ["91", "0", "abc", "7.5"]) {
                assert.equal((await adminGet(`/${stored._id}/stats?days=${days}`)).status, 400, days);
            }
        });
    });

    // ── C7 + C8: public endpoints ────────────────────────────────────────────
    describe("public job list and job page", () => {
        let jobs;
        beforeEach(async () => {
            const now = Date.now();
            jobs = Object.fromEntries((await seed(
                { title: "Live old", publishAt: new Date(now - 3 * DAY) },
                { title: "Live new", publishAt: new Date(now - DAY), closesAt: new Date(now + 5 * DAY), openings: 3, salaryText: "Rs 4-6 LPA" },
                { title: "Closed by switch", publishAt: new Date(now - 2 * DAY), acceptingApplications: false },
                { title: "Closed by deadline", publishAt: new Date(now - 10 * DAY), closesAt: new Date(now - HOUR) },
                { title: "Hidden", visible: false },
                { title: "Scheduled", publishAt: new Date(now + HOUR) },
                { title: "Archived", archived: true },
            )).map((stored) => [stored.title, stored]));
        });

        it("lists live jobs first, then closed ones, each newest first, with card fields only", async () => {
            const res = await publicGet();

            assert.equal(res.status, 200);
            assert.equal(res.headers["cache-control"], "public, max-age=60");
            const cards = res.body.data.jobs;
            assert.deepEqual(cards.map((card) => card.title), ["Live new", "Live old", "Closed by switch", "Closed by deadline"]);
            assert.deepEqual(cards.map((card) => card.acceptingApplications), [true, true, false, false]);
            for (const card of cards) assert.deepEqual(Object.keys(card).sort(), CARD_FIELDS);

            const [first] = cards;
            assert.equal(first.slug, jobs["Live new"].slug);
            assert.equal(first.postedOn, nowIST(jobs["Live new"].publishAt).dateKey);
            assert.equal(first.closesOn, nowIST(jobs["Live new"].closesAt).dateKey);
            assert.equal(first.openings, 3);
            assert.equal(first.salaryText, "Rs 4-6 LPA");
            assert.equal(cards[1].closesOn, null);
            assert.equal(cards[1].openings, null);
            assert.equal(cards[1].salaryText, null);
        });

        it("a job page has the card fields and the long texts", async () => {
            const res = await publicGet(`/${jobs["Live new"].slug}`);

            assert.equal(res.status, 200);
            const page = res.body.data.job;
            assert.deepEqual(Object.keys(page).sort(), [...CARD_FIELDS, "niceToHave", "requirements", "responsibilities"].sort());
            assert.equal(page.responsibilities, "Run samplers\nLog readings");
            assert.equal(page.niceToHave, null);
            assert.equal((await publicGet(`/${jobs["Closed by deadline"].slug}`)).body.data.job.acceptingApplications, false);
        });

        it("hidden, scheduled and archived jobs look exactly like a slug that does not exist", async () => {
            const missing = await publicGet("/no-such-job-k7q2");
            assert.equal(missing.status, 404);
            assert.equal(missing.body.code, "JOB_NOT_FOUND");
            const missingView = await view("no-such-job-k7q2");

            for (const title of ["Hidden", "Scheduled", "Archived"]) {
                const { slug, _id } = jobs[title];
                const page = await publicGet(`/${slug}`);
                assert.equal(page.status, 404, title);
                assert.deepEqual(page.body, missing.body, title);

                const counted = await view(slug);
                assert.equal(counted.status, 404, title);
                assert.deepEqual(counted.body, missingView.body, title);

                // and neither the id nor the slug works in place of the other
                assert.equal((await publicGet(`/${_id}`)).status, 404);
            }
            assert.equal(await JobStat.countDocuments(), 0);
            const listed = (await publicGet()).body.data.jobs.map((card) => card.slug);
            for (const title of ["Hidden", "Scheduled", "Archived"]) assert.equal(listed.includes(jobs[title].slug), false);
            assert.equal(JSON.stringify((await publicGet()).body).includes("Scheduled"), false);
        });

        it("a scheduled job appears on its own once its moment has passed", async () => {
            await Job.updateOne({ _id: jobs.Scheduled._id }, { publishAt: new Date(Date.now() - 1000) });
            assert.equal((await publicGet(`/${jobs.Scheduled.slug}`)).status, 200);
        });

        it("the public endpoints take no query or body", async () => {
            assert.equal((await publicGet("?all=true")).status, 400);
            assert.equal((await publicGet(`/${jobs["Live new"].slug}?admin=1`)).status, 400);
            const withBody = await request(getApp()).post(`${PUBLIC}/${jobs["Live new"].slug}/view`).set("User-Agent", BROWSER).send({ count: 5 });
            assert.equal(withBody.status, 400);
        });
    });

    // ── C7: view counting ────────────────────────────────────────────────────
    describe("POST /careers/jobs/:slug/view", () => {
        let live;
        let closed;
        beforeEach(async () => {
            [live, closed] = await seed({ title: "Live" }, { title: "Closed", acceptingApplications: false });
        });

        it("counts a view for today on live and closed jobs", async () => {
            const first = await view(live.slug);
            assert.equal(first.status, 200);
            assert.deepEqual(first.body.data, { counted: true });
            await view(live.slug);
            await view(closed.slug);

            const docs = await JobStat.find().lean();
            assert.equal(docs.find((doc) => String(doc.jobId) === String(live._id)).views, 2);
            assert.equal(docs.find((doc) => String(doc.jobId) === String(closed._id)).views, 1);
            assert.ok(docs.every((doc) => doc.date === today() && doc.applications === 0));
        });

        it("bots and requests with no User-Agent get 200 { counted: false } and are not counted", async () => {
            for (const userAgent of ["Googlebot/2.1 (+http://www.google.com/bot.html)", "facebookexternalhit/1.1 preview", "HeadlessChrome/120", null, ""]) {
                const res = await view(live.slug, userAgent);
                assert.equal(res.status, 200, String(userAgent));
                assert.deepEqual(res.body.data, { counted: false });
            }
            assert.equal(await JobStat.countDocuments(), 0);
        });

        it("30 per hour per IP: over the limit it answers 200 { counted: false } without counting", async () => {
            rateLimiting.enable();
            for (let i = 0; i < 30; i++) assert.equal((await view(live.slug)).body.data.counted, true);

            const over = await view(live.slug);
            assert.equal(over.status, 200);
            assert.deepEqual(over.body.data, { counted: false });
            assert.equal((await JobStat.findOne({ jobId: live._id }).lean()).views, 30);
        });

        it("the stats endpoint shows the counted views", async () => {
            await view(live.slug);
            await view(live.slug);
            const stats = (await adminGet(`/${live._id}/stats?days=1`)).body.data;
            assert.equal(stats.totalViews, 2);
            assert.deepEqual(stats.daily, [{ date: today(), views: 2, applications: 0 }]);
        });
    });
});
