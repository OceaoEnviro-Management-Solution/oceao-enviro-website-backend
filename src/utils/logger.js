// Minimal logger. Never pass request bodies, OTPs, passwords, tokens, phone numbers or email bodies.
//
// Every line inside a request carries requestId=<X-Request-Id>. As a safety net, anything that
// slipped into a message is redacted unless NODE_ENV=development (where the email log mode prints
// bodies on purpose so the OTP can be read from the console).

import { config } from "../config/env.js";
import { getRequestId } from "./requestContext.js";

const REDACTIONS = [
    [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]"],
    [/\bBearer\s+[\w.~+/=-]+/gi, "Bearer [redacted]"],
    [/(mongodb(?:\+srv)?:\/\/)[^\s/@]+@/gi, "$1[redacted]@"],
    [/(?:\+91[\s-]?|\b91[\s-]?|\b0)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, "[phone]"],
    [/(["']?(?:otp|password|passwd|token|secret)["']?\s*[:=]\s*)(["']?)[^\s"',}]+/gi, "$1$2[redacted]"],
];

const redact = (text) => REDACTIONS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);

const format = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "object" && value !== null) {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
};

const write = (level, stream, args) => {
    let message = args.map(format).join(" ");
    if (config.NODE_ENV !== "development") message = redact(message);

    const requestId = getRequestId();
    const tag = requestId ? ` requestId=${requestId}` : "";
    stream(`${new Date().toISOString()} [${level}]${tag} ${message}`);
};

const logger = {
    info: (...args) => write("INFO", console.log, args),
    warn: (...args) => write("WARN", console.warn, args),
    error: (...args) => write("ERROR", console.error, args),
};

export { logger };
