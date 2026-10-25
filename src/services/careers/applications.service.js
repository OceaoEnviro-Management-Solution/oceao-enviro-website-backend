// Job applications: the public Apply endpoint, and the admin applicant list, status, resume link and
// CSV export.
//
// Apply runs without transactions, ordered to fail safely:
//   1. the job must be live, and this email must not have applied to it before (checked first)
//   2. the resume is uploaded PRIVATELY to Cloudinary, named after the new application ID
//   3. the application is saved; if that fails, the uploaded resume is deleted again. Two requests for
//      the same job and email at the same moment are stopped by the unique { jobId, email } index and
//      answer ALREADY_APPLIED like the check in step 1.
//   4. the job's daily applications count goes up, and the two emails go out in the background

import { CAREERS } from "../../config/careers.js";
import { Job } from "../../models/job.model.js";
import { JobApplication } from "../../models/jobApplication.model.js";
import { incrementJobStat } from "../../models/jobStat.model.js";
import { ApiError } from "../../utils/ApiError.js";
import { generateApplicationId } from "../../utils/ids.js";
import { logger } from "../../utils/logger.js";
import { nowIST } from "../../utils/time.js";
import { recordAudit } from "../audit.service.js";
import { deleteResume, getResumeDownloadUrl, uploadResume } from "../cloudinary.service.js";
import { notifyJobApplication } from "../notify.service.js";
import { getJobStatus, isPubliclyVisible } from "./jobStatus.js";

const DUPLICATE_KEY = 11000;
const MAX_ID_ATTEMPTS = 3;

const jobNotFound = () => new ApiError(404, "JOB_NOT_FOUND", "Job not found.");
const applicationNotFound = () => new ApiError(404, "APPLICATION_NOT_FOUND", "Application not found.");
const alreadyApplied = () => new ApiError(409, "ALREADY_APPLIED", "You have already applied for this job.");

/** The file name as the candidate had it: no folders, no control characters, at most 120 characters. */
export const sanitizeFileName = (name, ext) => {
    const base = String(name ?? "")
        .split(/[\\/]/)
        .pop()
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    if (!base) return `resume.${ext}`;
    if (base.length <= CAREERS.resume.originalNameMax) return base;
    const dot = base.lastIndexOf(".");
    const suffix = dot > 0 && base.length - dot <= 6 ? base.slice(dot) : "";
    return `${base.slice(0, CAREERS.resume.originalNameMax - suffix.length).trimEnd()}${suffix}`;
};

const isDuplicateOf = (error, field) => error?.code === DUPLICATE_KEY && Boolean(error?.keyPattern?.[field]);

/**
 * Saves an application to a live job. `fields` are the validated form fields (consent included),
 * `file` is multer's memory file with detectedExt set by careersUpload.
 * @returns {Promise<{ applicationId: string, jobTitle: string }>}
 */
export const applyToJob = async (slug, { consent, ...fields }, file, now = new Date()) => {
    const job = await Job.findOne({ slug }).lean();
    if (!job || !isPubliclyVisible(job, now)) throw jobNotFound();
    if (getJobStatus(job, now) !== "live") {
        throw new ApiError(409, "APPLICATIONS_CLOSED", "Applications for this job are closed.");
    }
    if (await JobApplication.exists({ jobId: job._id, email: fields.email })) throw alreadyApplied();

    const ext = file.detectedExt;
    const base = {
        ...fields,
        jobId: job._id,
        jobSnapshot: { title: job.title, department: job.department, location: job.location, slug: job.slug },
        consentAt: now,
        status: "new",
    };

    let application;
    for (let attempt = 1; !application; attempt++) {
        const applicationId = generateApplicationId(nowIST(now).dateKey);

        let uploaded;
        try {
            uploaded = await uploadResume(file.buffer, applicationId, ext);
        } catch {
            throw new ApiError(502, "RESUME_UPLOAD_FAILED", "Your resume could not be uploaded. Please try again.");
        }

        try {
            application = await JobApplication.create({
                ...base,
                applicationId,
                resume: {
                    publicId: uploaded.publicId,
                    originalName: sanitizeFileName(file.originalname, ext),
                    sizeBytes: file.size,
                    ext,
                },
            });
        } catch (error) {
            // Whatever went wrong, the uploaded resume must not stay behind.
            await deleteResume(uploaded.publicId);
            if (isDuplicateOf(error, "email")) throw alreadyApplied();
            if (!isDuplicateOf(error, "applicationId") || attempt >= MAX_ID_ATTEMPTS) throw error;
        }
    }

    try {
        await incrementJobStat(job._id, "applications", now);
    } catch (error) {
        logger.error("Job application count not updated", { applicationId: application.applicationId, reason: error?.code ?? error?.name });
    }

    // In the background: an email that fails is logged and never fails the application.
    notifyJobApplication(application, job, file.buffer);

    return { applicationId: application.applicationId, jobTitle: job.title };
};

// ── Admin ─────────────────────────────────────────────────────────────────────

/** An application as the admin screens see it. The resume's Cloudinary id is never included. */
export const toAdminApplication = (application) => ({
    applicationId: application.applicationId,
    jobId: String(application.jobId),
    jobTitle: application.jobSnapshot?.title ?? null,
    fullName: application.fullName,
    email: application.email,
    phone: application.phone,
    currentLocation: application.currentLocation,
    totalExperienceYears: application.totalExperienceYears,
    currentOrganisation: application.currentOrganisation ?? null,
    currentDesignation: application.currentDesignation ?? null,
    highestQualification: application.highestQualification,
    noticePeriod: application.noticePeriod ?? null,
    expectedCtc: application.expectedCtc ?? null,
    profileUrl: application.profileUrl ?? null,
    coverNote: application.coverNote ?? null,
    consentAt: application.consentAt,
    status: application.status,
    statusUpdatedBy: application.statusUpdatedBy ?? null,
    appliedAt: application.createdAt,
    resume: {
        originalName: application.resume.originalName,
        sizeBytes: application.resume.sizeBytes,
        ext: application.resume.ext,
    },
});

const ADMIN_PROJECTION = { "resume.publicId": 0 };

/** Applications per status for one job: { new, shortlisted, rejected, hired }. */
const countsFor = async (jobId) => {
    const rows = await JobApplication.aggregate([
        { $match: { jobId } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const counts = Object.fromEntries(CAREERS.applicationStatuses.map((status) => [status, 0]));
    for (const row of rows) counts[row._id] = row.count;
    return counts;
};

/** One page (20) of a job's applications, newest first, with the counts per status. */
export const listApplications = async (jobId, { page = 1, status = "all" } = {}) => {
    const filter = status === "all" ? { jobId } : { jobId, status };
    const pageSize = CAREERS.applicationsPageSize;

    const [items, total, counts] = await Promise.all([
        JobApplication.find(filter, ADMIN_PROJECTION).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        JobApplication.countDocuments(filter),
        countsFor(jobId),
    ]);

    return { items: items.map(toAdminApplication), page, pageSize, total, totalPages: Math.ceil(total / pageSize), counts };
};

const findApplication = async (applicationId) => {
    const application = await JobApplication.findOne({ applicationId }).lean();
    if (!application) throw applicationNotFound();
    return application;
};

/** A signed link to the private resume, valid for 5 minutes. Each one handed out is audited. */
export const getResumeLink = async (applicationId, { performedBy = "Admin" } = {}, now = new Date()) => {
    const application = await findApplication(applicationId);
    const url = getResumeDownloadUrl(application.resume.publicId, now);

    await recordAudit({
        action: "career.resume.download",
        targetType: "job_application",
        targetId: application.applicationId,
        detail: { jobId: String(application.jobId) },
        performedBy,
    }, { now });

    return { url, expiresInSeconds: CAREERS.resume.downloadLinkMinutes * 60 };
};

/** Sets an applicant's status (new, shortlisted, rejected, hired). */
export const setApplicationStatus = async (applicationId, { status, performedBy }, now = new Date()) => {
    const application = await JobApplication.findOneAndUpdate(
        { applicationId },
        { $set: { status, statusUpdatedBy: performedBy } },
        { new: true, runValidators: true, projection: ADMIN_PROJECTION }
    ).lean();
    if (!application) throw applicationNotFound();

    await recordAudit({
        action: "career.application.status",
        targetType: "job_application",
        targetId: application.applicationId,
        detail: { jobId: String(application.jobId), status },
        performedBy,
    }, { now });

    return toAdminApplication(application);
};

/** Real application counts per job id (string) for the given job ids. */
export const applicationTotalsFor = async (jobIds) => {
    if (jobIds.length === 0) return new Map();
    const rows = await JobApplication.aggregate([
        { $match: { jobId: { $in: jobIds } } },
        { $group: { _id: "$jobId", count: { $sum: 1 } } },
    ]);
    return new Map(rows.map((row) => [String(row._id), row.count]));
};

/** True when the job has at least one application. */
export const jobHasApplications = async (jobId) => Boolean(await JobApplication.exists({ jobId }));
