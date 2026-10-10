import { Router } from "express";
import {
    handleSendOtp,
    handleVerifyOtp,
    handleGetCalendar,
    handleGetAvailability,
    handleCreateBooking,
} from "../controllers/vm.controller.js";
import { validateBody } from "../middlewares/validateBody.middleware.js";
import { validateQuery } from "../middlewares/validateQuery.middleware.js";
import { requireBookingToken } from "../middlewares/requireBookingToken.js";
import { otpSendLimiter, otpVerifyLimiter } from "../middlewares/rateLimit.js";
import { sendOtpSchema, verifyOtpSchema } from "../validators/otp.validator.js";
import { calendarQuerySchema, availabilityQuerySchema } from "../validators/vmAvailability.validator.js";
import { createVmBookingSchema } from "../validators/vmBooking.validator.js";

const router = Router();

router.post("/otp/send", otpSendLimiter, validateBody(sendOtpSchema), handleSendOtp);
router.post("/otp/verify", otpVerifyLimiter, validateBody(verifyOtpSchema), handleVerifyOtp);

router.get("/calendar", validateQuery(calendarQuerySchema), handleGetCalendar);
router.get("/availability", validateQuery(availabilityQuerySchema), handleGetAvailability);

router.post("/bookings", requireBookingToken, validateBody(createVmBookingSchema), handleCreateBooking);

export { router as vmRouter };
