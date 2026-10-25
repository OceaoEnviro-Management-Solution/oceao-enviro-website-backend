import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import { CAREERS } from "../config/careers.js";
import { exportApplicantsCsv } from "../services/careers/applicantsCsv.js";
import { getResumeLink, listApplications, setApplicationStatus } from "../services/careers/applications.service.js";
import {
    archiveJob,
    createJob,
    deleteJob,
    duplicateJob,
    findJob,
    getJob,
    getJobStats,
    listJobs,
    setIntake,
    setVisibility,
    unarchiveJob,
    updateJob,
} from "../services/careers/adminJobs.service.js";

const handleJobList = asyncHandler(async (req, res) => {
    const jobs = await listJobs({ includeArchived: req.validatedQuery.includeArchived ?? false });

    return res.status(200).json(new ApiResponse(200, { jobs }, "Jobs loaded"));
});

const handleJobCreate = asyncHandler(async (req, res) => {
    const job = await createJob(req.body);

    return res.status(201).json(new ApiResponse(201, { job }, "Job created"));
});

const handleJobGet = asyncHandler(async (req, res) => {
    const job = await getJob(req.validatedParams.id);

    return res.status(200).json(new ApiResponse(200, { job }, "Job loaded"));
});

const handleJobUpdate = asyncHandler(async (req, res) => {
    const job = await updateJob(req.validatedParams.id, req.body);

    return res.status(200).json(new ApiResponse(200, { job }, "Job updated"));
});

const handleJobVisibility = asyncHandler(async (req, res) => {
    const job = await setVisibility(req.validatedParams.id, req.body);

    return res.status(200).json(new ApiResponse(200, { job }, job.visible ? "Job is visible" : "Job is hidden"));
});

const handleJobIntake = asyncHandler(async (req, res) => {
    const job = await setIntake(req.validatedParams.id, req.body);

    return res.status(200).json(new ApiResponse(200, { job }, job.acceptingApplications ? "Applications opened" : "Applications stopped"));
});

const handleJobDuplicate = asyncHandler(async (req, res) => {
    const job = await duplicateJob(req.validatedParams.id, req.body);

    return res.status(201).json(new ApiResponse(201, { job }, "Job duplicated"));
});

const handleJobArchive = asyncHandler(async (req, res) => {
    const job = await archiveJob(req.validatedParams.id, req.body);

    return res.status(200).json(new ApiResponse(200, { job }, "Job archived"));
});

const handleJobUnarchive = asyncHandler(async (req, res) => {
    const job = await unarchiveJob(req.validatedParams.id, req.body);

    return res.status(200).json(new ApiResponse(200, { job }, "Job unarchived"));
});

const handleJobDelete = asyncHandler(async (req, res) => {
    const data = await deleteJob(req.validatedParams.id, req.body);

    return res.status(200).json(new ApiResponse(200, data, "Job deleted"));
});

const handleJobStats = asyncHandler(async (req, res) => {
    const data = await getJobStats(req.validatedParams.id, req.validatedQuery.days ?? CAREERS.statsDefaultDays);

    return res.status(200).json(new ApiResponse(200, data, "Job stats loaded"));
});

const handleApplicationList = asyncHandler(async (req, res) => {
    const job = await findJob(req.validatedParams.id);
    const data = await listApplications(job._id, req.validatedQuery);

    return res.status(200).json(new ApiResponse(200, data, "Applications loaded"));
});

// A signed link that works for 5 minutes: never cached.
const handleResumeLink = asyncHandler(async (req, res) => {
    const data = await getResumeLink(req.validatedParams.applicationId, req.validatedQuery);

    res.set("Cache-Control", "no-store");
    return res.status(200).json(new ApiResponse(200, data, "Resume link created"));
});

const handleApplicationStatus = asyncHandler(async (req, res) => {
    const application = await setApplicationStatus(req.validatedParams.applicationId, req.body);

    return res.status(200).json(new ApiResponse(200, { application }, "Status updated"));
});

// The CSV itself (not the JSON envelope). The file name is in Content-Disposition, which the
// browser may read across origins because it is listed in Access-Control-Expose-Headers.
const handleApplicantsCsv = asyncHandler(async (req, res) => {
    const job = await findJob(req.validatedParams.id);
    const { filename, csv } = await exportApplicantsCsv(job, req.validatedQuery);

    res.set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Access-Control-Expose-Headers": "Content-Disposition",
        "Cache-Control": "no-store",
    });
    return res.status(200).send(csv);
});

export {
    handleApplicationList,
    handleResumeLink,
    handleApplicationStatus,
    handleApplicantsCsv,
    handleJobList,
    handleJobCreate,
    handleJobGet,
    handleJobUpdate,
    handleJobVisibility,
    handleJobIntake,
    handleJobDuplicate,
    handleJobArchive,
    handleJobUnarchive,
    handleJobDelete,
    handleJobStats,
};
