import { rateLimit, MemoryStore } from "express-rate-limit";
import { ApiError } from "../utils/ApiError.js";
import { config } from "../config/env.js";

const FIFTEEN_MINUTES = 15 * 60 * 1000;

// Test hook: limiters are off when NODE_ENV=test unless a test switches them on.
// In every other environment they are always on and this state is never touched.
const rateLimitControl = {
    enabled: config.NODE_ENV !== "test",
    stores: [],
    setEnabled(value) {
        if (config.NODE_ENV !== "test") return;
        this.enabled = Boolean(value);
    },
    reset() {
        this.stores.forEach((store) => store.resetAll());
    },
};

const createLimiter = (limit) => {
    const store = new MemoryStore();
    rateLimitControl.stores.push(store);

    return rateLimit({
        windowMs: FIFTEEN_MINUTES,
        limit,
        store,
        standardHeaders: true,   // also sets Retry-After when the limit is hit
        legacyHeaders: false,
        skip: () => !rateLimitControl.enabled,
        handler: (req, res, next) => {
            next(new ApiError(429, "RATE_LIMITED", "Too many requests. Please try again later."));
        },
    });
};

// Query and feedback forms: 5 requests / 15 min / IP
const publicFormLimiter = createLimiter(5);

// Everything under /api: 300 requests / 15 min / IP
const globalLimiter = createLimiter(300);

// Virtual meeting OTP: 10 sends and 10 verifications / 15 min / IP (separate counters)
const otpSendLimiter = createLimiter(10);
const otpVerifyLimiter = createLimiter(10);

// Admin login: 5 attempts / 15 min / IP
const adminLoginLimiter = createLimiter(5);

export { publicFormLimiter, globalLimiter, otpSendLimiter, otpVerifyLimiter, adminLoginLimiter, rateLimitControl };
