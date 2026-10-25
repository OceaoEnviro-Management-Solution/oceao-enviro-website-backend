import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import { isCountableUserAgent } from "../services/visits.service.js";
import { getPublicJob, listPublicJobs, recordJobView } from "../services/careers/publicJobs.service.js";
import { applyToJob } from "../services/careers/applications.service.js";
import { sendGeneralApplication } from "../services/careers/generalApplication.service.js";

// GET /careers/jobs: cacheable for a minute.
const handleListJobs = asyncHandler(async (req, res) => {
    const jobs = await listPublicJobs();

    res.set("Cache-Control", "public, max-age=60");
    return res.status(200).json(new ApiResponse(200, { jobs }, "Jobs loaded"));
});

const handleGetJob = asyncHandler(async (req, res) => {
    const job = await getPublicJob(req.validatedParams.slug);

    return res.status(200).json(new ApiResponse(200, { job }, "Job loaded"));
});

// POST /careers/jobs/:slug/view: counts the view unless the caller is a bot (or has no User-Agent).
// 200 either way for a visible job, so the job page never shows an error for it.
const handleRecordView = asyncHandler(async (req, res) => {
    const counted = await recordJobView(req.validatedParams.slug, { countable: isCountableUserAgent(req.get("user-agent")) });

    return res.status(200).json(new ApiResponse(200, { counted }, "View recorded"));
});

// POST /careers/jobs/:slug/apply (multipart): the resume is req.file, checked by careersUpload.
const handleApply = asyncHandler(async (req, res) => {
    const data = await applyToJob(req.validatedParams.slug, req.body, req.file);

    return res.status(201).json(new ApiResponse(201, data, "Application submitted"));
});

// POST /careers/general-apply (multipart): a resume without a job, emailed to HR (nothing stored).
const handleGeneralApply = asyncHandler(async (req, res) => {
    const data = await sendGeneralApplication(req.body, req.file);

    return res.status(201).json(new ApiResponse(201, data, "Resume sent"));
});

export { handleListJobs, handleGetJob, handleRecordView, handleApply, handleGeneralApply };
