import nodemailer from "nodemailer";
import { config } from "../../config/env.js";

// EMAIL_MODE=test: every message sent is pushed here so tests can inspect it.
const outbox = [];

// Test hook, only consulted in EMAIL_MODE=test: outbox.failNext("company" | "customer" | "any")
// makes the next matching send throw. "company" means a message to COMPANY_MAIL.
const pendingFailures = [];

outbox.failNext = (target = "any") => {
    pendingFailures.push(target);
};

outbox.takeFailure = (target) => {
    const index = pendingFailures.findIndex((kind) => kind === "any" || kind === target);
    if (index === -1) return false;
    pendingFailures.splice(index, 1);
    return true;
};

outbox.clear = () => {
    outbox.length = 0;
    pendingFailures.length = 0;
};

// smtp: real delivery. log/test: jsonTransport builds the message without any network call.
const transporter = config.EMAIL_MODE === "smtp"
    ? nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        auth: {
            user: config.SMTP_USER,
            pass: config.SMTP_PASSWORD
        }
    })
    : nodemailer.createTransport({ jsonTransport: true });

export { transporter, outbox };
