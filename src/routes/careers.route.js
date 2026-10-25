import { Router } from "express";
import { handleListJobs, handleGetJob, handleRecordView, handleApply, handleGeneralApply } from "../controllers/careers.controller.js";
import { validateBody } from "../middlewares/validateBody.middleware.js";
import { validateQuery } from "../middlewares/validateQuery.middleware.js";
import { validateParams } from "../middlewares/validateParams.middleware.js";
import { careersApplyLimiter, careersGeneralLimiter, jobViewLimiter } from "../middlewares/rateLimit.js";
import { careersUpload, requireResume } from "../middlewares/careersUpload.middleware.js";
import { requireTurnstile } from "../middlewares/requireTurnstile.js";
import { noInputSchema } from "../validators/common.js";
import { applySchema, generalApplySchema, jobSlugParamsSchema } from "../validators/careers.validator.js";

const router = Router();

// None of these take a query or a body: any key is a 400.
router.get("/jobs", validateQuery(noInputSchema), handleListJobs);
router.get("/jobs/:slug", validateParams(jobSlugParamsSchema), validateQuery(noInputSchema), handleGetJob);
router.post("/jobs/:slug/view", jobViewLimiter, validateParams(jobSlugParamsSchema), validateBody(noInputSchema), handleRecordView);

// Apply (multipart/form-data: the resume in the file field "resume", the rest as text fields).
// Rate limit first, then the upload (5 MB, PDF or DOCX by its real type), the CAPTCHA, the fields.
router.post(
    "/jobs/:slug/apply",
    careersApplyLimiter,
    validateParams(jobSlugParamsSchema),
    careersUpload,
    requireTurnstile,
    validateBody(applySchema),
    requireResume,
    handleApply
);

// A resume without a job ("Don't see the right role?"), same checks, plus the role wanted.
// Emailed to HR with the resume attached; nothing is stored.
router.post(
    "/general-apply",
    careersGeneralLimiter,
    careersUpload,
    requireTurnstile,
    validateBody(generalApplySchema),
    requireResume,
    handleGeneralApply
);

export { router as careersRouter };
