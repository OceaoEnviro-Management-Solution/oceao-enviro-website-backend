import { transporter, outbox } from "./email.transporter.js";
import { config } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

const sendMailService = async ({ from, to, subject, text, html, replyTo, attachments }) => {

    const mailOptions = {
        from,
        to,
        subject,
        text,
        html,
        replyTo,
        attachments
    }

    if (config.EMAIL_MODE === "test") {
        const target = to === config.COMPANY_MAIL ? "company" : "customer";
        if (outbox.takeFailure(target)) {
            throw new Error(`Simulated ${target} email failure`);
        }
        outbox.push(mailOptions);
        return { accepted: [].concat(to), messageId: `test-${outbox.length}` };
    }

    const result = await transporter.sendMail(mailOptions);

    if (config.EMAIL_MODE === "log") {
        // Recipient and subject only, never the body...
        logger.info("Email (log mode)", { to, subject });

        // ...except when developing locally: the plain-text body is printed too, so an OTP
        // can be read from the console. Never happens in test, production or any other mode.
        if (config.NODE_ENV === "development") {
            logger.info(`Email body (development only):
${text}`);
        }
    }

    return result;

}

export { sendMailService };
