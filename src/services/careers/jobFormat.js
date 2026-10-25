// Careers dates and the shapes jobs are sent in.
//
// The admin screen sends and receives dates in IST:
//   publishAt  { date: "YYYY-MM-DD", time: "HH:mm" }  -> the real instant of that IST wall-clock time
//   closesAt   "YYYY-MM-DD"                           -> the last millisecond of that IST day (23:59:59.999)
// Stored values are real instants (Date), so the status check is a plain comparison with "now".

import { addDays, istToDate, nowIST } from "../../utils/time.js";
import { getJobStatus } from "./jobStatus.js";

const pad = (value) => String(value).padStart(2, "0");

/** { date, time } in IST -> Date */
export const publishAtFrom = ({ date, time }) => istToDate(date, time);

/** "2026-11-30" -> 2026-11-30T18:29:59.999Z (23:59:59.999 IST) */
export const closesAtFrom = (dateKey) => new Date(istToDate(addDays(dateKey, 1), "00:00").getTime() - 1);

/** Date -> its IST day "YYYY-MM-DD" */
export const istDateKey = (date) => nowIST(new Date(date)).dateKey;

/** Date -> its IST time of day "HH:mm" */
export const istTime = (date) => {
    const { minutes } = nowIST(new Date(date));
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
};

// What the public job list shows on each card.
export const toPublicCard = (job, now = new Date()) => ({
    slug: job.slug,
    title: job.title,
    department: job.department,
    location: job.location,
    employmentType: job.employmentType,
    workMode: job.workMode,
    experienceMin: job.experienceMin,
    experienceMax: job.experienceMax,
    openings: job.openings ?? null,
    salaryText: job.salaryText ?? null,
    summary: job.summary,
    postedOn: istDateKey(job.publishAt),
    closesOn: job.closesAt ? istDateKey(job.closesAt) : null,
    acceptingApplications: getJobStatus(job, now) === "live",
});

// The public job page: the card plus the long texts.
export const toPublicJob = (job, now = new Date()) => ({
    ...toPublicCard(job, now),
    responsibilities: job.responsibilities,
    requirements: job.requirements,
    niceToHave: job.niceToHave ?? null,
});

// Everything the admin screens need, with the dates both as instants and as IST parts for the form.
export const toAdminJob = (job, now = new Date()) => ({
    id: String(job._id),
    slug: job.slug,
    title: job.title,
    department: job.department,
    location: job.location,
    employmentType: job.employmentType,
    workMode: job.workMode,
    experienceMin: job.experienceMin,
    experienceMax: job.experienceMax,
    openings: job.openings ?? null,
    salaryText: job.salaryText ?? null,
    summary: job.summary,
    responsibilities: job.responsibilities,
    requirements: job.requirements,
    niceToHave: job.niceToHave ?? null,
    visible: job.visible,
    acceptingApplications: job.acceptingApplications,
    archived: job.archived,
    publishAt: new Date(job.publishAt).toISOString(),
    publishDate: istDateKey(job.publishAt),
    publishTime: istTime(job.publishAt),
    closesAt: job.closesAt ? new Date(job.closesAt).toISOString() : null,
    closesOn: job.closesAt ? istDateKey(job.closesAt) : null,
    status: getJobStatus(job, now),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
});
