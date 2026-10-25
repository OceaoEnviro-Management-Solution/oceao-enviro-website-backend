import { z } from "zod";
import { CAREERS } from "../config/careers.js";
import { isValidDateKey, isValidTime } from "../utils/time.js";

const { limits } = CAREERS;

// Who did it (the employee name typed in the admin UI). Kept in the audit log.
const performedBy = z
    .string({ error: "Your name is required" })
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(60, "Name cannot exceed 60 characters");

// Line breaks are kept (one point per line) and stored as "\n".
const text = (label, { min = 1, max }) =>
    z
        .string({ error: `${label} is required` })
        .transform((value) => value.replace(/\r\n?/g, "\n").trim())
        .pipe(
            z
                .string()
                .min(min, min > 1 ? `${label} must be at least ${min} characters` : `${label} is required`)
                .max(max, `${label} cannot exceed ${max} characters`)
        );

// Optional text: "" means none. On an edit, "" or null removes it.
const optionalText = (label, { max }) =>
    z
        .string({ error: `${label} must be text` })
        .transform((value) => value.replace(/\r\n?/g, "\n").trim())
        .pipe(z.string().max(max, `${label} cannot exceed ${max} characters`));

const wholeNumber = (label, { min, max }) =>
    z
        .number({ error: `${label} must be a number` })
        .int(`${label} must be a whole number`)
        .min(min, `${label} must be from ${min} to ${max}`)
        .max(max, `${label} must be from ${min} to ${max}`);

const dateKey = (label) =>
    z.string({ error: `${label} must be a date (YYYY-MM-DD)` }).trim().refine(isValidDateKey, "Must be a valid date in the form YYYY-MM-DD");

// IST wall-clock date and time of publishing.
const publishAt = z
    .object({
        date: dateKey("The publish date"),
        time: z.string({ error: "The publish time is required (HH:mm)" }).trim().refine(isValidTime, "Must be a time in the form HH:mm (24-hour)"),
    }, { error: "publishAt must be { date, time }" })
    .strict();

const fields = {
    title: text("Title", limits.title),
    department: text("Department", limits.department),
    location: text("Location", limits.location),
    employmentType: z.enum(CAREERS.employmentTypes, { error: `Must be one of: ${CAREERS.employmentTypes.join(", ")}` }),
    workMode: z.enum(CAREERS.workModes, { error: `Must be one of: ${CAREERS.workModes.join(", ")}` }),
    experienceMin: wholeNumber("Minimum experience", limits.experience),
    experienceMax: wholeNumber("Maximum experience", limits.experience),
    openings: wholeNumber("Openings", limits.openings),
    salaryText: optionalText("Salary", limits.salaryText),
    summary: text("Summary", limits.summary),
    responsibilities: text("Responsibilities", limits.responsibilities),
    requirements: text("Requirements", limits.requirements),
    niceToHave: optionalText("Nice to have", limits.niceToHave),
    visible: z.boolean({ error: "visible must be true or false" }),
    acceptingApplications: z.boolean({ error: "acceptingApplications must be true or false" }),
    publishAt,
    closesAt: dateKey("The deadline"),
};

const EDITABLE = Object.keys(fields);

// POST /admin/careers/jobs. publishAt defaults to now; closesAt (the last day to apply) is optional.
// The two rules that compare fields (experienceMax >= experienceMin, closesAt on or after the publish
// date) are checked by the service, which also knows "now" and the stored values on an edit.
const createJobSchema = z
    .object({
        title: fields.title,
        department: fields.department,
        location: fields.location,
        employmentType: fields.employmentType,
        workMode: fields.workMode,
        experienceMin: fields.experienceMin,
        experienceMax: fields.experienceMax,
        openings: fields.openings.nullable().optional(),
        salaryText: fields.salaryText.nullable().optional(),
        summary: fields.summary,
        responsibilities: fields.responsibilities,
        requirements: fields.requirements,
        niceToHave: fields.niceToHave.nullable().optional(),
        visible: fields.visible.optional(),
        acceptingApplications: fields.acceptingApplications.optional(),
        publishAt: fields.publishAt.optional(),
        closesAt: fields.closesAt.nullable().optional(),
        performedBy,
    })
    .strict();

// PATCH /admin/careers/jobs/:id: any field except the slug (never changes) and archived (its own
// endpoints). openings, salaryText, niceToHave and closesAt can be removed with null ("" too for texts).
// At least one field is needed.
const updateJobSchema = z
    .object({
        ...Object.fromEntries(EDITABLE.map((key) => [key, fields[key].optional()])),
        openings: fields.openings.nullable().optional(),
        salaryText: fields.salaryText.nullable().optional(),
        niceToHave: fields.niceToHave.nullable().optional(),
        closesAt: fields.closesAt.nullable().optional(),
        performedBy,
    })
    .strict()
    .refine((body) => EDITABLE.some((key) => body[key] !== undefined), {
        message: `Send at least one of: ${EDITABLE.join(", ")}`,
        path: ["title"],
    });

// Unknown and malformed ids both answer 404 JOB_NOT_FOUND (checked by the service).
const jobIdParamsSchema = z.object({ id: z.string().max(64) }).strict();

const visibilitySchema = z.object({ visible: fields.visible, performedBy }).strict();
const intakeSchema = z.object({ acceptingApplications: fields.acceptingApplications, performedBy }).strict();

// duplicate, archive, unarchive and delete
const performedBySchema = z.object({ performedBy }).strict();

// GET /admin/careers/jobs?includeArchived=true
const jobsQuerySchema = z
    .object({
        includeArchived: z
            .enum(["true", "false"], { error: "Must be true or false" })
            .transform((value) => value === "true")
            .optional(),
    })
    .strict();

const DAYS_MESSAGE = `Must be a whole number from 1 to ${CAREERS.statsMaxDays}`;

// GET /admin/careers/jobs/:id/stats?days   (default 30, at most 90)
const statsQuerySchema = z
    .object({
        days: z
            .string({ error: DAYS_MESSAGE })
            .trim()
            .regex(/^\d{1,3}$/, DAYS_MESSAGE)
            .transform(Number)
            .pipe(z.number().min(1, DAYS_MESSAGE).max(CAREERS.statsMaxDays, DAYS_MESSAGE))
            .optional(),
    })
    .strict();

// /admin/careers/applications/:applicationId. An unknown id answers 404 APPLICATION_NOT_FOUND.
const applicationIdParamsSchema = z.object({ applicationId: z.string().max(40) }).strict();

const PAGE_MESSAGE = "Must be a whole number from 1 to 99999";
const STATUS_FILTERS = ["all", ...CAREERS.applicationStatuses];

// GET /admin/careers/jobs/:id/applications?page&status   (page default 1, status default all)
const applicationsQuerySchema = z
    .object({
        page: z
            .string({ error: PAGE_MESSAGE })
            .trim()
            .regex(/^\d{1,5}$/, PAGE_MESSAGE)
            .transform(Number)
            .pipe(z.number().min(1, PAGE_MESSAGE))
            .optional(),
        status: z.enum(STATUS_FILTERS, { error: `Must be one of: ${STATUS_FILTERS.join(", ")}` }).optional(),
    })
    .strict();

// PATCH /admin/careers/applications/:applicationId
const applicationStatusSchema = z
    .object({
        status: z.enum(CAREERS.applicationStatuses, { error: `Must be one of: ${CAREERS.applicationStatuses.join(", ")}` }),
        performedBy,
    })
    .strict();

// GET /admin/careers/applications/:applicationId/resume and GET /admin/careers/jobs/:id/applications.csv:
// optional ?performedBy=<name> for the audit entry (the shared admin account when it is left out).
const auditedDownloadQuerySchema = z.object({ performedBy: performedBy.optional() }).strict();

export {
    applicationIdParamsSchema,
    applicationsQuerySchema,
    applicationStatusSchema,
    auditedDownloadQuerySchema,
    createJobSchema,
    updateJobSchema,
    jobIdParamsSchema,
    visibilitySchema,
    intakeSchema,
    performedBySchema,
    jobsQuerySchema,
    statsQuerySchema,
};
