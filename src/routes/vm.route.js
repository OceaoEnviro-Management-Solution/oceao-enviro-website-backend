import { Router } from "express";
import { handleSendOtp, handleVerifyOtp } from "../controllers/vm.controller.js";
import { validateBody } from "../middlewares/validateBody.middleware.js";
import { otpSendLimiter, otpVerifyLimiter } from "../middlewares/rateLimit.js";
import { sendOtpSchema, verifyOtpSchema } from "../validators/otp.validator.js";

const router = Router();

router.post("/otp/send", otpSendLimiter, validateBody(sendOtpSchema), handleSendOtp);
router.post("/otp/verify", otpVerifyLimiter, validateBody(verifyOtpSchema), handleVerifyOtp);

export { router as vmRouter };
