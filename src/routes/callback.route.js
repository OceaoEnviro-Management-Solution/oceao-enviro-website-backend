import { Router } from "express";
import {
    handleGetCalendar,
    handleGetAvailability,
    handleCreateRequest,
} from "../controllers/callback.controller.js";
import { validateBody } from "../middlewares/validateBody.middleware.js";
import { validateQuery } from "../middlewares/validateQuery.middleware.js";
import { publicFormLimiter } from "../middlewares/rateLimit.js";
import { requireTurnstile } from "../middlewares/requireTurnstile.js";
import { calendarQuerySchema, availabilityQuerySchema } from "../validators/vmAvailability.validator.js";
import { createCallbackRequestSchema } from "../validators/callback.validator.js";

const router = Router();

// The date and range rules are identical to the VM endpoints, so the same query schemas apply.
router.get("/calendar", validateQuery(calendarQuerySchema), handleGetCalendar);
router.get("/availability", validateQuery(availabilityQuerySchema), handleGetAvailability);

router.post(
    "/requests",
    publicFormLimiter,
    requireTurnstile,
    validateBody(createCallbackRequestSchema),
    handleCreateRequest
);

export { router as callbackRouter };
