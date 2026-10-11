import { ApiError } from "../utils/ApiError.js";
import { ADMIN_COOKIE_NAME, verifySessionToken } from "../services/adminAuth.service.js";

/**
 * Requires a valid admin session: the "oe_admin" cookie must hold an unexpired HS256 JWT for
 * the admin whose `pwv` matches the current ADMIN_PASSWORD_HASH. On success sets
 * req.admin = { expiresAt }. Any problem is 401 ADMIN_UNAUTHORIZED, with no detail about why.
 */
const requireAdmin = (req, res, next) => {
    const token = req.cookies?.[ADMIN_COOKIE_NAME];
    const session = typeof token === "string" && token !== "" ? verifySessionToken(token) : null;

    if (!session) {
        return next(new ApiError(401, "ADMIN_UNAUTHORIZED", "Please sign in to continue."));
    }

    req.admin = session;
    next();
};

export { requireAdmin };
