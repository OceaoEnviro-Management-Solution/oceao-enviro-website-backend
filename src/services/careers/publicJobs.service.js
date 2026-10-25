// Public side of careers: the job list, a job page and the page view counter.
// Only "live" and "closed" jobs exist here. A hidden, scheduled or archived job gives exactly the
// same 404 as a slug that was never used, so nothing about it can be learned from outside.

import { Job } from "../../models/job.model.js";
import { incrementJobStat } from "../../models/jobStat.model.js";
import { ApiError } from "../../utils/ApiError.js";
import { getJobStatus, isPubliclyVisible } from "./jobStatus.js";
import { toPublicCard, toPublicJob } from "./jobFormat.js";

const notFound = () => new ApiError(404, "JOB_NOT_FOUND", "Job not found.");

const newestFirst = (a, b) => new Date(b.publishAt) - new Date(a.publishAt);

/** The job behind a slug when it is publicly visible, else 404 JOB_NOT_FOUND. */
export const findPublicJob = async (slug, now = new Date()) => {
    const job = await Job.findOne({ slug }).lean();
    if (!job || !isPubliclyVisible(job, now)) throw notFound();
    return job;
};

/** Live jobs first, then closed ones, each newest first. Card fields only. */
export const listPublicJobs = async (now = new Date()) => {
    const jobs = await Job.find({ archived: false, visible: true, publishAt: { $lte: now } }).lean();
    const live = jobs.filter((job) => getJobStatus(job, now) === "live").sort(newestFirst);
    const closed = jobs.filter((job) => getJobStatus(job, now) === "closed").sort(newestFirst);
    return [...live, ...closed].map((job) => toPublicCard(job, now));
};

export const getPublicJob = async (slug, now = new Date()) => toPublicJob(await findPublicJob(slug, now), now);

/**
 * One page view for today (IST): 404 when the job is not publicly visible, otherwise counted unless
 * `countable` is false (a bot, or no User-Agent). Returns whether it was counted.
 */
export const recordJobView = async (slug, { countable }, now = new Date()) => {
    const job = await findPublicJob(slug, now);
    if (!countable) return false;
    await incrementJobStat(job._id, "views", now);
    return true;
};
