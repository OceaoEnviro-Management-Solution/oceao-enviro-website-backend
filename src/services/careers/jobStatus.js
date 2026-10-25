// A job's status is worked out, never stored: from the switches and dates staff set and the
// current time, checked in exactly this order:
//
//   archived    archived is on
//   hidden      visible is off
//   scheduled   publishAt is still in the future
//   closed      intake is off, or the deadline has passed (now >= closesAt)
//   live        everything else
//
// "live" and "closed" jobs are on the public site ("closed" without the Apply form). The other
// three must look exactly like a job that does not exist.

export const JOB_STATUSES = Object.freeze(["archived", "hidden", "scheduled", "closed", "live"]);

const time = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

/** @returns {"archived" | "hidden" | "scheduled" | "closed" | "live"} */
export const getJobStatus = (job, now = new Date()) => {
    const at = now.getTime();
    if (job.archived) return "archived";
    if (!job.visible) return "hidden";
    if (time(job.publishAt) > at) return "scheduled";
    if (!job.acceptingApplications || (job.closesAt && at >= time(job.closesAt))) return "closed";
    return "live";
};

/** True when the job is on the public site (live, or closed with an "Applications closed" badge). */
export const isPubliclyVisible = (job, now = new Date()) => {
    const status = getJobStatus(job, now);
    return status === "live" || status === "closed";
};
