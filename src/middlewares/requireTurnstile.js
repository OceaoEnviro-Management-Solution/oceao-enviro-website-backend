import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { verifyTurnstile } from "../services/turnstile.service.js";

/**
 * Requires a valid Turnstile token in req.body.turnstileToken.
 * Place it after the body is parsed (after multer on multipart routes) and before validation.
 * The token is removed from req.body so the validators and services never see it.
 * Missing or failed verification is 400 CAPTCHA_FAILED.
 */
const requireTurnstile = asyncHandler(async (req, res, next) => {
    const token = req.body?.turnstileToken;
    if (req.body && typeof req.body === "object") {
        delete req.body.turnstileToken;
    }

    const verified = await verifyTurnstile(token, req.ip);
    if (!verified) {
        throw new ApiError(400, "CAPTCHA_FAILED", "CAPTCHA verification failed. Please try again.");
    }

    next();
});

export { requireTurnstile };
