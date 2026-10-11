import { Router } from "express";
import { handleLogin, handleLogout, handleMe } from "../controllers/adminAuth.controller.js";
import { validateBody } from "../middlewares/validateBody.middleware.js";
import { adminLoginLimiter } from "../middlewares/rateLimit.js";
import { requireAdmin } from "../middlewares/requireAdmin.js";
import { adminCsrf } from "../middlewares/adminCsrf.js";
import { loginSchema } from "../validators/adminAuth.validator.js";

const router = Router();

// ── Public ────────────────────────────────────────────────────────────────────
// The only admin route that works without a session.
router.post("/auth/login", adminLoginLimiter, validateBody(loginSchema), handleLogin);

// ── Everything below needs a session, and every write must pass the CSRF check ──
router.use(requireAdmin, adminCsrf);

router.post("/auth/logout", handleLogout);
router.get("/auth/me", handleMe);

// Phase 5 adds the admin read and write routes here.

export { router as adminRouter };
