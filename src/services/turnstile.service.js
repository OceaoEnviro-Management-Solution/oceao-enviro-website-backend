// Cloudflare Turnstile verification (AGENT_CONTEXT.md section 10).
//
// verifyTurnstile never throws and fails closed: any problem (no token, network error,
// timeout, a non-JSON answer, success !== true) is "not verified". The token is never logged.
// Tests inject a fake with setTurnstileVerifier() so no test touches the network.

import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_TIMEOUT_MS = 5000;

// Cloudflare documents tokens of up to 2048 characters.
const MAX_TOKEN_LENGTH = 2048;

let injectedVerifier = null;

/** Test seam: replace the verifier with `async (token, ip) => boolean`. Pass null to restore. */
export const setTurnstileVerifier = (verifier) => {
    injectedVerifier = typeof verifier === "function" ? verifier : null;
};

/**
 * @param {unknown} token the widget's token from the form
 * @param {string} [ip] the visitor's IP, sent as remoteip
 * @returns {Promise<boolean>}
 */
export const verifyTurnstile = async (token, ip) => {
    if (typeof token !== "string" || token.trim() === "" || token.length > MAX_TOKEN_LENGTH) {
        return false;
    }

    if (injectedVerifier) {
        try {
            return (await injectedVerifier(token, ip)) === true;
        } catch {
            return false;
        }
    }

    try {
        const body = new URLSearchParams({ secret: config.TURNSTILE_SECRET_KEY, response: token });
        if (ip) body.set("remoteip", ip);

        const response = await fetch(TURNSTILE_VERIFY_URL, {
            method: "POST",
            body,                                        // sent as application/x-www-form-urlencoded
            signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
        });
        if (!response.ok) return false;

        const result = await response.json();
        return result?.success === true;
    } catch (error) {
        logger.warn("Turnstile verification failed", { reason: error?.name ?? "unknown" });
        return false;
    }
};
