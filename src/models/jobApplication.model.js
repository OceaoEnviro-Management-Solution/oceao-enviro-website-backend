import mongoose, { Schema } from "mongoose";
import { CAREERS } from "../config/careers.js";
import { APPLICATION_ID_PATTERN } from "../utils/ids.js";
import { emailField } from "./shared.js";

const limits = CAREERS.applicationLimits;

// Normalized phone: an optional "+" and 7-15 digits (spaces and hyphens are removed by the validator).
export const PHONE_PATTERN = /^\+?\d{7,15}$/;

const optionalText = (max) => ({ type: String, trim: true, maxlength: max });

// One application to one job. Kept CAREERS_RETENTION_DAYS (default 365) after it was made, then the
// daily retention job deletes it and its resume (services/careers/retention.service.js).
//
//   jobSnapshot  the job's title, department, location and slug when the candidate applied, so old
//                emails, lists and CSVs stay correct after the job is edited
//   resume       the PRIVATE Cloudinary file (raw, type private). publicId is never sent to a browser:
//                admins get a signed link that works for 5 minutes.
const resumeSchema = new Schema({
    publicId: { type: String, required: true, trim: true },
    originalName: { type: String, required: true, trim: true, maxlength: CAREERS.resume.originalNameMax },
    sizeBytes: { type: Number, required: true, min: 1, max: CAREERS.resume.maxBytes },
    ext: { type: String, required: true, enum: Object.values(CAREERS.resume.allowedTypes) },
}, { _id: false, strict: true });

const jobApplicationSchema = new Schema({
    applicationId: {
        type: String,
        required: true,
        trim: true,
        match: [APPLICATION_ID_PATTERN, "applicationId must look like OE-JA-YYMMDD-XXXX"],
    },
    jobId: { type: Schema.Types.ObjectId, ref: "Job", required: true },
    jobSnapshot: {
        title: { type: String, required: true, trim: true },
        department: { type: String, required: true, trim: true },
        location: { type: String, required: true, trim: true },
        slug: { type: String, required: true, trim: true },
    },
    fullName: { type: String, required: true, trim: true, minlength: limits.fullName.min, maxlength: limits.fullName.max },
    email: emailField({ maxlength: limits.email.max }),
    phone: { type: String, required: true, trim: true, match: [PHONE_PATTERN, "{PATH} must be 7-15 digits, optionally starting with +"] },
    currentLocation: { type: String, required: true, trim: true, minlength: limits.currentLocation.min, maxlength: limits.currentLocation.max },
    totalExperienceYears: {
        type: Number,
        required: true,
        min: limits.totalExperienceYears.min,
        max: limits.totalExperienceYears.max,
        validate: { validator: (value) => Number.isInteger(value * 2), message: "{PATH} must be in steps of 0.5" },
    },
    currentOrganisation: optionalText(limits.currentOrganisation.max),
    currentDesignation: optionalText(limits.currentDesignation.max),
    highestQualification: {
        type: String, required: true, trim: true, minlength: limits.highestQualification.min, maxlength: limits.highestQualification.max,
    },
    noticePeriod: { type: String, enum: CAREERS.noticePeriods },
    expectedCtc: optionalText(limits.expectedCtc.max),
    profileUrl: {
        ...optionalText(limits.profileUrl.max),
        validate: { validator: (value) => !value || /^https:\/\/[^\s]+$/i.test(value), message: "{PATH} must be an https link" },
    },
    coverNote: optionalText(limits.coverNote.max),
    consentAt: { type: Date, required: true },
    resume: { type: resumeSchema, required: true },
    status: { type: String, required: true, enum: CAREERS.applicationStatuses, default: "new" },
    statusUpdatedBy: { type: String, trim: true, maxlength: 60 },
}, {
    strict: true,
    timestamps: true,
    collection: "jobapplications",
});

jobApplicationSchema.index({ applicationId: 1 }, { unique: true });
jobApplicationSchema.index({ jobId: 1, email: 1 }, { unique: true });
jobApplicationSchema.index({ jobId: 1, createdAt: -1 });
jobApplicationSchema.index({ createdAt: 1 });

export const JobApplication = mongoose.model("JobApplication", jobApplicationSchema);
