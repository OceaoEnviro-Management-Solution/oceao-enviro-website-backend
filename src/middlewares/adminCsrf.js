import { config } from "../config/env.js";
import { ApiError } from "../utils/ApiError.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// The one admin write that carries a file: it is sent as multipart/form-data instead of JSON.
// (The key is the method and the path inside the admin router.) The Origin check still applies.
const MULTIPART_ROUTES = new Set(["POST /hero/slides"]);

/**
 * CSRF guard for admin writes. The session cookie is SameSite=Lax, and on top of that every
 * non-GET admin request must come from an allowed frontend and be JSON:
 *   - Origin header present and listed in CORS_ORIGINS
 *   - Content-Type application/json (a cross-site HTML form cannot send it), or multipart/form-data
 *     for the routes in MULTIPART_ROUTES only; there the Origin check and the SameSite cookie are the guard
 * Anything else is 403 CSRF_REJECTED.
 */
const adminCsrf = (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.get("origin");
    const contentType = (req.get("content-type") || "").split(";")[0].trim().toLowerCase();

    const expectedType = MULTIPART_ROUTES.has(`${req.method} ${req.path}`) ? "multipart/form-data" : "application/json";

    if (!origin || !config.CORS_ORIGINS.includes(origin) || contentType !== expectedType) {
        return next(new ApiError(403, "CSRF_REJECTED", "Request rejected."));
    }

    next();
};

export { adminCsrf };
