import jwt from "jsonwebtoken";
import { config } from "../config/env.js";
import { ApiError } from "../utils/ApiError.js";
import { BOOKING_TOKEN_PURPOSE } from "../services/otp.service.js";

const reject = () =>
    new ApiError(401, "BOOKING_TOKEN_INVALID", "Your verification has expired or is invalid. Please verify your email again.");

/**
 * Requires "Authorization: Bearer <bookingToken>" issued by POST /vm/otp/verify.
 * Checks the HS256 signature, expiry and purpose, then sets req.verifiedEmail.
 * Any problem is 401 BOOKING_TOKEN_INVALID, with no detail about which check failed.
 */
const requireBookingToken = (req, res, next) => {
    const header = req.get("authorization") || "";
    const [scheme, token, ...rest] = header.trim().split(/\s+/);

    if (!/^bearer$/i.test(scheme) || !token || rest.length > 0) {
        return next(reject());
    }

    let payload;
    try {
        payload = jwt.verify(token, config.BOOKING_TOKEN_SECRET, { algorithms: ["HS256"] });
    } catch {
        return next(reject());
    }

    if (
        !payload ||
        typeof payload !== "object" ||
        payload.purpose !== BOOKING_TOKEN_PURPOSE ||
        typeof payload.sub !== "string" ||
        payload.sub.length === 0
    ) {
        return next(reject());
    }

    req.verifiedEmail = payload.sub;
    next();
};

export { requireBookingToken };
