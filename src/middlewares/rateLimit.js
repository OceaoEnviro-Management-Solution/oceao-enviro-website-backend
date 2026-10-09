import { rateLimit } from "express-rate-limit";
import { ApiError } from "../utils/ApiError.js";
import { config } from "../config/env.js";

const FIFTEEN_MINUTES = 15 * 60 * 1000;

const createLimiter = (limit) =>
    rateLimit({
        windowMs: FIFTEEN_MINUTES,
        limit,
        standardHeaders: true,   // also sets Retry-After when the limit is hit
        legacyHeaders: false,
        skip: () => config.NODE_ENV === "test",
        handler: (req, res, next) => {
            next(new ApiError(429, "RATE_LIMITED", "Too many requests. Please try again later."));
        },
    });

// Query and feedback forms: 5 requests / 15 min / IP
const publicFormLimiter = createLimiter(5);

// Everything under /api: 300 requests / 15 min / IP
const globalLimiter = createLimiter(300);

export { publicFormLimiter, globalLimiter };
