// Admin side of careers: create, edit, switch, duplicate, archive and delete job openings, and the
// per-job stats. Every write records one audit entry ("career.job.<verb>") AFTER the change is saved.
//
// Edits load the job, apply the changes and save the document, so the model's checks that compare
// two fields (experienceMax >= experienceMin, closesAt >= publishAt) see the values that will be
// stored. The service checks the same two rules first, to answer with a field error.

import { CAREERS } from "../../config/careers.js";
import { Job } from "../../models/job.model.js";
import { JobStat } from "../../models/jobStat.model.js";
import { ApiError } from "../../utils/ApiError.js";
import { generateJobSlug } from "../../utils/ids.js";
import { addDays, nowIST } from "../../utils/time.js";
import { recordAudit } from "../audit.service.js";
import { applicationTotalsFor, jobHasApplications } from "./applications.service.js";
import { closesAtFrom, istDateKey, publishAtFrom, toAdminJob } from "./jobFormat.js";

const DUPLICATE_KEY = 11000;
const MAX_SLUG_ATTEMPTS = 3;
const COPY_SUFFIX = " (copy)";

// Optional texts and numbers: "" or null removes them.
const CLEARABLE = new Set(["openings", "salaryText", "niceToHave"]);

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

const notFound = () => new ApiError(404, "JOB_NOT_FOUND", "Job not found.");

const fieldError = (field, message) => new ApiError(400, "VALIDATION_FAILED", "Validation failed", { [field]: [message] });

/** The job, or 404 JOB_NOT_FOUND for an unknown or malformed id. */
export const findJob = async (id) => {
    if (!OBJECT_ID.test(id)) throw notFound();
    const job = await Job.findById(id);
    if (!job) throw notFound();
    return job;
};

// The two rules that compare fields, checked on the values that will be stored.
const checkConsistency = (job) => {
    if (job.experienceMax < job.experienceMin) {
        throw fieldError("experienceMax", "Maximum experience must be at least the minimum experience");
    }
    if (job.closesAt && istDateKey(job.closesAt) < istDateKey(job.publishAt)) {
        throw fieldError("closesAt", "The deadline must be on or after the publish date");
    }
};

// Body fields -> model fields. publishAt and closesAt arrive in their IST form.
const toModelFields = (fields) => {
    const set = {};
    const unset = [];
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        if (key === "publishAt") set.publishAt = publishAtFrom(value);
        else if (key === "closesAt") value ? (set.closesAt = closesAtFrom(value)) : unset.push("closesAt");
        else if (CLEARABLE.has(key) && (value === null || value === "")) unset.push(key);
        else set[key] = value;
    }
    return { set, unset };
};

// All-time totals per job: views from the daily stats, applications counted in the applications
// themselves (so an application deleted by the retention job no longer counts).
const totalsFor = async (jobIds) => {
    if (jobIds.length === 0) return new Map();
    const [views, applications] = await Promise.all([
        JobStat.aggregate([
            { $match: { jobId: { $in: jobIds } } },
            { $group: { _id: "$jobId", views: { $sum: "$views" } } },
        ]),
        applicationTotalsFor(jobIds),
    ]);
    const byJob = new Map(views.map((row) => [String(row._id), row.views]));
    return new Map(jobIds.map((id) => [String(id), { views: byJob.get(String(id)) ?? 0, applications: applications.get(String(id)) ?? 0 }]));
};

// A new job, retried with a fresh slug suffix if the slug happens to exist already.
const createWithSlug = async (title, fields) => {
    for (let attempt = 1; ; attempt++) {
        try {
            return await Job.create({ ...fields, title, slug: generateJobSlug(title) });
        } catch (error) {
            const slugTaken = error?.code === DUPLICATE_KEY && error?.keyPattern?.slug;
            if (!slugTaken || attempt >= MAX_SLUG_ATTEMPTS) throw error;
        }
    }
};

const audit = (verb, job, performedBy, detail = {}, now = new Date()) =>
    recordAudit({
        action: `career.job.${verb}`,
        targetType: "job",
        targetId: String(job._id),
        detail: { slug: job.slug, ...detail },
        performedBy,
    }, { now });

/** Non-archived jobs (or all with includeArchived), newest first, each with status and totals. */
export const listJobs = async ({ includeArchived = false } = {}, now = new Date()) => {
    const jobs = await Job.find(includeArchived ? {} : { archived: false }).sort({ createdAt: -1, _id: -1 }).lean();
    const totals = await totalsFor(jobs.map((job) => job._id));

    return jobs.map((job) => {
        const total = totals.get(String(job._id));
        return { ...toAdminJob(job, now), totalViews: total?.views ?? 0, totalApplications: total?.applications ?? 0 };
    });
};

export const getJob = async (id, now = new Date()) => toAdminJob(await findJob(id), now);

/** Creates a job. publishAt defaults to now; the slug is made from the title. */
export const createJob = async ({ performedBy, title, ...fields }, now = new Date()) => {
    const { set } = toModelFields(fields);
    const values = { publishAt: now, ...set };
    checkConsistency(values);

    const job = await createWithSlug(title, values);
    await audit("create", job, performedBy, { title: job.title }, now);
    return toAdminJob(job, now);
};

/** Edits any field except the slug (and archived, which has its own endpoints). */
export const updateJob = async (id, { performedBy, ...fields }, now = new Date()) => {
    const job = await findJob(id);
    const { set, unset } = toModelFields(fields);

    job.set(set);
    for (const key of unset) job.set(key, undefined);
    checkConsistency(job);
    await job.save();

    await audit("edit", job, performedBy, { fields: Object.keys(fields).filter((key) => fields[key] !== undefined) }, now);
    return toAdminJob(job, now);
};

const setSwitch = (verb, field) => async (id, { performedBy, [field]: value }, now = new Date()) => {
    const job = await findJob(id);
    job.set(field, value);
    await job.save();

    await audit(verb, job, performedBy, { [field]: value }, now);
    return toAdminJob(job, now);
};

export const setVisibility = setSwitch("visibility", "visible");
export const setIntake = setSwitch("intake", "acceptingApplications");
export const archiveJob = (id, { performedBy }, now) => setSwitch("archive", "archived")(id, { performedBy, archived: true }, now);
export const unarchiveJob = (id, { performedBy }, now) => setSwitch("unarchive", "archived")(id, { performedBy, archived: false }, now);

/**
 * A copy to re-post a role: same texts, title "<title> (copy)", new slug, hidden, intake on,
 * publish now, no deadline, not archived and no stats of its own.
 */
export const duplicateJob = async (id, { performedBy }, now = new Date()) => {
    const source = await findJob(id);
    const keep = CAREERS.limits.title.max - COPY_SUFFIX.length;
    const title = `${source.title.slice(0, keep).trimEnd()}${COPY_SUFFIX}`;

    const fields = {};
    for (const key of [
        "department", "location", "employmentType", "workMode", "experienceMin", "experienceMax", "openings",
        "salaryText", "summary", "responsibilities", "requirements", "niceToHave",
    ]) {
        if (source[key] !== undefined) fields[key] = source[key];
    }

    const job = await createWithSlug(title, {
        ...fields,
        visible: false,
        acceptingApplications: true,
        archived: false,
        publishAt: now,
    });
    await audit("duplicate", job, performedBy, { fromJobId: String(source._id), fromSlug: source.slug }, now);
    return toAdminJob(job, now);
};

/** Deletes a job with no applications, and its stats. A job with applications must be archived instead. */
export const deleteJob = async (id, { performedBy }, now = new Date()) => {
    const job = await findJob(id);
    if (await jobHasApplications(job._id)) {
        throw new ApiError(409, "JOB_HAS_APPLICATIONS", "This job has applications. Archive it instead.");
    }

    await Job.deleteOne({ _id: job._id });
    await JobStat.deleteMany({ jobId: job._id });

    await audit("delete", job, performedBy, { title: job.title }, now);
    return { id: String(job._id), deleted: true };
};

/**
 * The job's all-time totals and one entry per IST day for the last `days` days (today included),
 * oldest first, 0 for a day with nothing.
 */
export const getJobStats = async (id, days = CAREERS.statsDefaultDays, now = new Date()) => {
    const job = await findJob(id);
    const today = nowIST(now).dateKey;
    const from = addDays(today, -(days - 1));

    const [stored, totals] = await Promise.all([
        JobStat.find({ jobId: job._id, date: { $gte: from, $lte: today } }).select({ date: 1, views: 1, applications: 1, _id: 0 }).lean(),
        totalsFor([job._id]),
    ]);
    const byDate = new Map(stored.map((entry) => [entry.date, entry]));
    const total = totals.get(String(job._id)) ?? { views: 0, applications: 0 };

    return {
        totalViews: total.views,
        totalApplications: total.applications,
        conversionPercent: total.views > 0 ? Math.round((total.applications / total.views) * 1000) / 10 : 0,
        daily: Array.from({ length: days }, (_, index) => {
            const date = addDays(from, index);
            const entry = byDate.get(date);
            return { date, views: entry?.views ?? 0, applications: entry?.applications ?? 0 };
        }),
    };
};
