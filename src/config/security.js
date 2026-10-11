// Security settings that are fixed in code (everything an operator sets lives in env.js).
// App wiring, multer and the admin cookie all read from here, so there is one place to review.
//
// From the environment (src/config/env.js, documented in .env.example):
//   CORS_ORIGINS   allowlist for CORS and for the admin CSRF check
//   TRUST_PROXY    proxy hops to trust (what req.ip, and so the rate limiters, see)
//   NODE_ENV       "production" switches the admin cookie to Secure and hides 5xx details
//
// Fixed here:
//   bodyLimit      largest JSON or urlencoded request body
//   upload         multer limits for the feedback attachment
//   helmet         options for the helmet security headers (defaults)
//   adminCookie    flags of the admin session cookie
//   rateLimits     requests per 15 minutes per IP (the limiter objects live in middlewares/rateLimit.js)

import { config } from "./env.js";

const SESSION_SECONDS = 8 * 60 * 60;

export const SECURITY = Object.freeze({
    bodyLimit: "20kb",

    upload: Object.freeze({
        maxFileBytes: 5 * 1024 * 1024,   // 5 MB attachment
        maxFiles: 1,
        maxFields: 10,
        maxFieldBytes: 10 * 1024,        // 10 KB per text field
    }),

    // helmet's defaults (HSTS, nosniff, frame and referrer policies ...). Nothing is switched off.
    helmet: Object.freeze({}),

    adminCookie: Object.freeze({
        name: "oe_admin",
        path: "/api/v1/admin",
        sameSite: "lax",
        httpOnly: true,
        sessionSeconds: SESSION_SECONDS,
    }),

    rateLimits: Object.freeze({
        windowMinutes: 15,
        publicForms: 5,
        otpSend: 10,
        otpVerify: 10,
        adminLogin: 5,
        globalApi: 300,
    }),
});

/** Options for res.cookie / res.clearCookie of the admin session. Secure only in production. */
export const adminCookieOptions = () => ({
    httpOnly: SECURITY.adminCookie.httpOnly,
    sameSite: SECURITY.adminCookie.sameSite,
    secure: config.NODE_ENV === "production",
    path: SECURITY.adminCookie.path,
});
