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
import { validateBody } from "../middlewares/validateBody.middleware.js";
import { validateQuery } from "../middlewares/validateQuery.middleware.js";
import { adminLoginLimiter } from "../middlewares/rateLimit.js";
import { requireAdmin } from "../middlewares/requireAdmin.js";
import { adminCsrf } from "../middlewares/adminCsrf.js";
import { loginSchema } from "../validators/adminAuth.validator.js";
import {
    dashboardQuerySchema,
    bookingsQuerySchema,
    monthQuerySchema,
    dateQuerySchema,
    callbackRequestsQuerySchema,
    holidaysQuerySchema,
} from "../validators/adminRead.validator.js";

const router = Router();

// ── Public ────────────────────────────────────────────────────────────────────
// The only admin route that works without a session.
router.post("/auth/login", adminLoginLimiter, validateBody(loginSchema), handleLogin);

// ── Everything below needs a session, and every write must pass the CSRF check ──
router.use(requireAdmin, adminCsrf);

router.post("/auth/logout", handleLogout);
router.get("/auth/me", handleMe);

// ── Read endpoints ────────────────────────────────────────────────────────────
router.get("/dashboard", validateQuery(dashboardQuerySchema), handleDashboard);
router.get("/bookings", validateQuery(bookingsQuerySchema), handleBookings);
router.get("/vm/calendar", validateQuery(monthQuerySchema), handleVmCalendar);
router.get("/vm/availability", validateQuery(dateQuerySchema), handleVmAvailability);
router.get("/callback/availability", validateQuery(dateQuerySchema), handleCallbackAvailability);
router.get("/callback/requests", validateQuery(callbackRequestsQuerySchema), handleCallbackRequests);
router.get("/settings", handleSettings);
router.get("/holidays", validateQuery(holidaysQuerySchema), handleHolidays);

// Phase 5 adds the admin write routes below.

export { router as adminRouter };
