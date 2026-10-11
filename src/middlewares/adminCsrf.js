import { config } from "../config/env.js";
import { ApiError } from "../utils/ApiError.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF guard for admin writes. The session cookie is SameSite=Lax, and on top of that every
 * non-GET admin request must come from an allowed frontend and be JSON:
 *   - Origin header present and listed in CORS_ORIGINS
 *   - Content-Type application/json (a cross-site HTML form cannot send it)
 * Anything else is 403 CSRF_REJECTED.
 */
const adminCsrf = (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.get("origin");
    const contentType = (req.get("content-type") || "").split(";")[0].trim().toLowerCase();

    if (!origin || !config.CORS_ORIGINS.includes(origin) || contentType !== "application/json") {
        return next(new ApiError(403, "CSRF_REJECTED", "Request rejected."));
    }

    next();
};

export { adminCsrf };
