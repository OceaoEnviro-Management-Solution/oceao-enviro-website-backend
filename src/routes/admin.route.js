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
import { adminLoginLimiter } from "../middlewares/rateLimit.js";
import { requireAdmin } from "../middlewares/requireAdmin.js";
import { adminCsrf } from "../middlewares/adminCsrf.js";
import { noInputSchema } from "../validators/common.js";
import { loginSchema } from "../validators/adminAuth.validator.js";
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
