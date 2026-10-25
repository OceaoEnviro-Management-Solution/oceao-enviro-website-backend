import { Router } from "express";
import { handleLogin, handleLogout, handleMe } from "../controllers/adminAuth.controller.js";
import {
    handleDashboard,
    handleBookings,
    handleVmCalendar,
    handleVmAvailability,
    handleCallbackAvailability,
    handleCallbackRequests,
    handleSettings,
    handleHolidays,
} from "../controllers/adminRead.controller.js";
import { handleAdminVisits } from "../controllers/visits.controller.js";
import { handleSyncStatus, handleSyncNow } from "../controllers/updates.controller.js";
import {
    handleHeroGet,
    handleSlideAdd,
    handleSlideUpdate,
    handleSlideDelete,
    handleOrder,
    handleScheduleSet,
    handleScheduleClear,
} from "../controllers/adminHero.controller.js";
import {
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
    handleApplicationList,
    handleResumeLink,
    handleApplicationStatus,
    handleApplicantsCsv,
} from "../controllers/adminCareers.controller.js";
import {
    handleVmBlock,
    handleVmUnblock,
    handleVmCancel,
    handleVmRetryMeet,
} from "../controllers/adminVm.controller.js";
import {
    handleCallbackBlock,
    handleCallbackUnblock,
    handleCallbackCancel,
    handleCallbackStatus,
} from "../controllers/adminCallback.controller.js";
import {
    handleCapacity,
    handleHolidayAdd,
    handleHolidayBulk,
    handleHolidayRename,
    handleHolidayDelete,
} from "../controllers/adminSettings.controller.js";
import { validateBody } from "../middlewares/validateBody.middleware.js";
import { validateQuery } from "../middlewares/validateQuery.middleware.js";
import { validateParams } from "../middlewares/validateParams.middleware.js";
import { adminLoginLimiter, adminSyncLimiter } from "../middlewares/rateLimit.js";
import { requireAdmin } from "../middlewares/requireAdmin.js";
import { adminCsrf } from "../middlewares/adminCsrf.js";
import { heroUpload, verifyHeroImage } from "../middlewares/heroUpload.middleware.js";
import { noInputSchema } from "../validators/common.js";
import { loginSchema } from "../validators/adminAuth.validator.js";
import { adminVisitsQuerySchema } from "../validators/visits.validator.js";
import {
    createSlideSchema,
    updateSlideSchema,
    slideIdParamsSchema,
    performedBySchema,
    orderSchema,
    scheduleSchema,
} from "../validators/adminHero.validator.js";
import {
    createJobSchema,
    updateJobSchema,
    jobIdParamsSchema,
    visibilitySchema,
    intakeSchema,
    performedBySchema as jobPerformedBySchema,
    jobsQuerySchema,
    statsQuerySchema,
    applicationIdParamsSchema,
    applicationsQuerySchema,
    applicationStatusSchema,
    auditedDownloadQuerySchema,
} from "../validators/adminCareers.validator.js";
import {
    dashboardQuerySchema,
    bookingsQuerySchema,
    monthQuerySchema,
    dateQuerySchema,
    callbackRequestsQuerySchema,
    holidaysQuerySchema,
} from "../validators/adminRead.validator.js";
import {
    slotTargetSchema,
    cancelBookingSchema,
    retryMeetSchema,
    bookingIdParamsSchema,
} from "../validators/adminVm.validator.js";
import {
    callbackBlockSchema,
    cancelRequestsSchema,
    requestStatusSchema,
    requestIdParamsSchema,
    capacitySchema,
    holidayCreateSchema,
    holidayBulkSchema,
    holidayRenameSchema,
    holidayDeleteSchema,
    dateParamsSchema,
} from "../validators/adminCallback.validator.js";

const router = Router();

// ── Public ────────────────────────────────────────────────────────────────────
// The only admin route that works without a session.
router.post("/auth/login", adminLoginLimiter, validateBody(loginSchema), handleLogin);

// ── Everything below needs a session, and every write must pass the CSRF check ──
router.use(requireAdmin, adminCsrf);

// These take no input: any body or query key is a 400.
router.post("/auth/logout", validateBody(noInputSchema), handleLogout);
router.get("/auth/me", validateQuery(noInputSchema), handleMe);

// ── Read endpoints ────────────────────────────────────────────────────────────
router.get("/dashboard", validateQuery(dashboardQuerySchema), handleDashboard);
router.get("/bookings", validateQuery(bookingsQuerySchema), handleBookings);
router.get("/vm/calendar", validateQuery(monthQuerySchema), handleVmCalendar);
router.get("/vm/availability", validateQuery(dateQuerySchema), handleVmAvailability);
router.get("/callback/availability", validateQuery(dateQuerySchema), handleCallbackAvailability);
router.get("/callback/requests", validateQuery(callbackRequestsQuerySchema), handleCallbackRequests);
router.get("/settings", validateQuery(noInputSchema), handleSettings);
router.get("/holidays", validateQuery(holidaysQuerySchema), handleHolidays);
router.get("/visits", validateQuery(adminVisitsQuerySchema), handleAdminVisits);
router.get("/updates/sync-status", validateQuery(noInputSchema), handleSyncStatus);
router.get("/hero", validateQuery(noInputSchema), handleHeroGet);

// ── PARIVESH updates: sync now (no input; one per 5 minutes) ──────────────────
router.post("/updates/sync", validateBody(noInputSchema), adminSyncLimiter, handleSyncNow);

// ── Homepage hero (each write creates an audit entry) ─────────────────────────
// Adding a slide is multipart (the picture is the "image" file); the rest take JSON.
router.post("/hero/slides", heroUpload, verifyHeroImage, validateBody(createSlideSchema), handleSlideAdd);
router.patch("/hero/slides/:id", validateParams(slideIdParamsSchema), validateBody(updateSlideSchema), handleSlideUpdate);
router.delete("/hero/slides/:id", validateParams(slideIdParamsSchema), validateBody(performedBySchema), handleSlideDelete);
router.put("/hero/order", validateBody(orderSchema), handleOrder);
router.put("/hero/schedule", validateBody(scheduleSchema), handleScheduleSet);
router.delete("/hero/schedule", validateBody(performedBySchema), handleScheduleClear);

// ── Careers: job openings (each write creates an audit entry "career.job.<verb>") ──
// An unknown or malformed :id answers 404 JOB_NOT_FOUND.
router.get("/careers/jobs", validateQuery(jobsQuerySchema), handleJobList);
router.post("/careers/jobs", validateBody(createJobSchema), handleJobCreate);
router.get("/careers/jobs/:id", validateParams(jobIdParamsSchema), validateQuery(noInputSchema), handleJobGet);
router.patch("/careers/jobs/:id", validateParams(jobIdParamsSchema), validateBody(updateJobSchema), handleJobUpdate);
router.delete("/careers/jobs/:id", validateParams(jobIdParamsSchema), validateBody(jobPerformedBySchema), handleJobDelete);
router.patch("/careers/jobs/:id/visibility", validateParams(jobIdParamsSchema), validateBody(visibilitySchema), handleJobVisibility);
router.patch("/careers/jobs/:id/intake", validateParams(jobIdParamsSchema), validateBody(intakeSchema), handleJobIntake);
router.post("/careers/jobs/:id/duplicate", validateParams(jobIdParamsSchema), validateBody(jobPerformedBySchema), handleJobDuplicate);
router.post("/careers/jobs/:id/archive", validateParams(jobIdParamsSchema), validateBody(jobPerformedBySchema), handleJobArchive);
router.post("/careers/jobs/:id/unarchive", validateParams(jobIdParamsSchema), validateBody(jobPerformedBySchema), handleJobUnarchive);
router.get("/careers/jobs/:id/stats", validateParams(jobIdParamsSchema), validateQuery(statsQuerySchema), handleJobStats);

// ── Careers: applicants (the resume's Cloudinary id is never sent; a download is a 5-minute signed link) ──
router.get("/careers/jobs/:id/applications", validateParams(jobIdParamsSchema), validateQuery(applicationsQuerySchema), handleApplicationList);
router.get("/careers/jobs/:id/applications.csv", validateParams(jobIdParamsSchema), validateQuery(auditedDownloadQuerySchema), handleApplicantsCsv);
router.get(
    "/careers/applications/:applicationId/resume",
    validateParams(applicationIdParamsSchema),
    validateQuery(auditedDownloadQuerySchema),
    handleResumeLink
);
router.patch(
    "/careers/applications/:applicationId",
    validateParams(applicationIdParamsSchema),
    validateBody(applicationStatusSchema),
    handleApplicationStatus
);

// ── VM actions (each writes one audit entry) ──────────────────────────────────
router.post("/vm/blocks", validateBody(slotTargetSchema), handleVmBlock);
router.post("/vm/blocks/remove", validateBody(slotTargetSchema), handleVmUnblock);
router.post(
    "/vm/bookings/:bookingId/cancel",
    validateParams(bookingIdParamsSchema),
    validateBody(cancelBookingSchema),
    handleVmCancel
);
router.post(
    "/vm/bookings/:bookingId/retry-meet",
    validateParams(bookingIdParamsSchema),
    validateBody(retryMeetSchema),
    handleVmRetryMeet
);

// ── Callback actions (each change writes an audit entry) ──────────────────────
router.post("/callback/blocks", validateBody(callbackBlockSchema), handleCallbackBlock);
router.post("/callback/blocks/remove", validateBody(callbackBlockSchema), handleCallbackUnblock);
router.post("/callback/requests/cancel", validateBody(cancelRequestsSchema), handleCallbackCancel);
router.patch(
    "/callback/requests/:requestId",
    validateParams(requestIdParamsSchema),
    validateBody(requestStatusSchema),
    handleCallbackStatus
);

// ── Settings: callback capacity and holidays ──────────────────────────────────
router.put("/settings/callback-capacity", validateBody(capacitySchema), handleCapacity);
router.post("/holidays", validateBody(holidayCreateSchema), handleHolidayAdd);
router.post("/holidays/bulk", validateBody(holidayBulkSchema), handleHolidayBulk);
router.patch("/holidays/:date", validateParams(dateParamsSchema), validateBody(holidayRenameSchema), handleHolidayRename);
router.delete("/holidays/:date", validateParams(dateParamsSchema), validateBody(holidayDeleteSchema), handleHolidayDelete);

export { router as adminRouter };
