import mongoose, { Schema } from "mongoose";
import { CAREERS } from "../config/careers.js";

const { limits } = CAREERS;

const wholeNumber = { validator: Number.isInteger, message: "{PATH} must be a whole number" };

// One job opening. Only the switches and dates staff set are stored; the status (archived,
// hidden, scheduled, closed, live) is worked out from them and the current time by
// services/careers/jobStatus.js, so scheduling and deadlines need no background job.
//
//   slug        made from the title when the job is created (utils/ids.js) and never changed
//   publishAt   the moment the job goes up (sent by the admin screen as an IST date and time)
//   closesAt    optional deadline: the last millisecond of the chosen IST day (23:59:59.999 IST)
//
// Long texts (summary, responsibilities, requirements, niceToHave) are plain text, one point per
// line. HTML is never stored or rendered.
const jobSchema = new Schema({
    slug: { type: String, required: true, trim: true, maxlength: 80 },
    title: { type: String, required: true, trim: true, minlength: limits.title.min, maxlength: limits.title.max },
    department: { type: String, required: true, trim: true, minlength: limits.department.min, maxlength: limits.department.max },
    location: { type: String, required: true, trim: true, minlength: limits.location.min, maxlength: limits.location.max },
    employmentType: { type: String, required: true, enum: CAREERS.employmentTypes },
    workMode: { type: String, required: true, enum: CAREERS.workModes },
    experienceMin: { type: Number, required: true, min: limits.experience.min, max: limits.experience.max, validate: wholeNumber },
    experienceMax: {
        type: Number,
        required: true,
        min: limits.experience.min,
        max: limits.experience.max,
        validate: [
            wholeNumber,
            {
                validator(value) { return typeof this.experienceMin !== "number" || value >= this.experienceMin; },
                message: "experienceMax must be at least experienceMin",
            },
        ],
    },
    openings: { type: Number, min: limits.openings.min, max: limits.openings.max, validate: wholeNumber },
    salaryText: { type: String, trim: true, maxlength: limits.salaryText.max },
    summary: { type: String, required: true, trim: true, maxlength: limits.summary.max },
    responsibilities: { type: String, required: true, trim: true, maxlength: limits.responsibilities.max },
    requirements: { type: String, required: true, trim: true, maxlength: limits.requirements.max },
    niceToHave: { type: String, trim: true, maxlength: limits.niceToHave.max },
    visible: { type: Boolean, default: false },
    acceptingApplications: { type: Boolean, default: true },
    publishAt: { type: Date, required: true },
    closesAt: {
        type: Date,
        validate: {
            validator(value) { return !value || !this.publishAt || value >= this.publishAt; },
            message: "closesAt must be on or after publishAt",
        },
    },
    archived: { type: Boolean, default: false },
}, {
    strict: true,
    timestamps: true,
    collection: "jobs",
});

jobSchema.index({ slug: 1 }, { unique: true });
jobSchema.index({ archived: 1, createdAt: -1 });

export const Job = mongoose.model("Job", jobSchema);
