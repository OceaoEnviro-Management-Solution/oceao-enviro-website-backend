import nodemailer from "nodemailer";
import { config } from "../../config/env.js";

// EMAIL_MODE=test: every message sent is pushed here so tests can inspect it.
const outbox = [];

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
