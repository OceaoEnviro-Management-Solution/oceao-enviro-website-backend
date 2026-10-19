import { rateLimit, MemoryStore } from "express-rate-limit";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiRes.js";
import { getTotal } from "../services/visits.service.js";
import { config } from "../config/env.js";
import { SECURITY } from "../config/security.js";
import { PARIVESH } from "../config/parivesh.js";

const { rateLimits } = SECURITY;
const FIFTEEN_MINUTES = rateLimits.windowMinutes * 60 * 1000;

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

const createLimiter = (limit, overrides = {}) => {
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
        ...overrides,
    });
};

// Query and feedback forms: 5 requests / 15 min / IP
const publicFormLimiter = createLimiter(rateLimits.publicForms);

// Everything under /api: 300 requests / 15 min / IP
const globalLimiter = createLimiter(rateLimits.globalApi);

// Virtual meeting OTP: 10 sends and 10 verifications / 15 min / IP (separate counters)
const otpSendLimiter = createLimiter(rateLimits.otpSend);
const otpVerifyLimiter = createLimiter(rateLimits.otpVerify);

// Visit counter: 10 / hour / IP. Over the limit the visit is not counted but the answer is still
// 200 with the current total, so the footer never shows an error.
const visitLimiter = createLimiter(SECURITY.visitRateLimit.limit, {
    windowMs: SECURITY.visitRateLimit.windowMinutes * 60 * 1000,
    standardHeaders: false,
    handler: async (req, res, next) => {
        try {
            const total = await getTotal();
            res.status(200).json(new ApiResponse(200, { total }, "Visit recorded"));
        } catch (error) {
            next(error);
        }
    },
});

// Admin login: 5 attempts / 15 min / IP
const adminLoginLimiter = createLimiter(rateLimits.adminLogin);

// Admin "sync PARIVESH now": one run per 5 minutes in total (one shared admin account, and the
// source should not be hammered), so every request shares one counter instead of one per IP.
const adminSyncLimiter = createLimiter(1, {
    windowMs: PARIVESH.manualSyncCooldownMinutes * 60 * 1000,
    keyGenerator: () => "parivesh-sync",
    handler: (req, res, next) => {
        next(new ApiError(
            429,
            "RATE_LIMITED",
            `A sync was started less than ${PARIVESH.manualSyncCooldownMinutes} minutes ago. Please try again later.`
        ));
    },
});

export {
    publicFormLimiter, globalLimiter, otpSendLimiter, otpVerifyLimiter, adminLoginLimiter, visitLimiter,
    adminSyncLimiter, rateLimitControl,
};
