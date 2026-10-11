import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import { ApiError } from "../utils/ApiError.js";
import {
    ADMIN_COOKIE_NAME,
    SESSION_COOKIE_MAX_AGE_MS,
    verifyCredentials,
    issueSessionToken,
    sessionCookieOptions,
    getAdminEmail,
} from "../services/adminAuth.service.js";

const handleLogin = asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    const valid = await verifyCredentials(email, password);
    if (!valid) {
        // One message for a wrong email and a wrong password.
        throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
    }

    res.cookie(ADMIN_COOKIE_NAME, issueSessionToken(), {
        ...sessionCookieOptions(),
        maxAge: SESSION_COOKIE_MAX_AGE_MS,
    });

    return res.status(200).json(new ApiResponse(200, { email: getAdminEmail() }, "Logged in"));
});

const handleLogout = asyncHandler(async (req, res) => {
    res.clearCookie(ADMIN_COOKIE_NAME, sessionCookieOptions());

    return res.status(200).json(new ApiResponse(200, null, "Logged out"));
});

const handleMe = asyncHandler(async (req, res) => {
    return res
        .status(200)
        .json(new ApiResponse(200, { email: getAdminEmail(), expiresAt: req.admin.expiresAt.toISOString() }, "Session valid"));
});

export { handleLogin, handleLogout, handleMe };
