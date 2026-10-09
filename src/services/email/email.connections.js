import { transporter } from "./email.transporter.js";
import { logger } from "../../utils/logger.js";

// Boot-time SMTP check. A failure only warns; the server keeps running.
const emailConnectionVerify = async () => {
    try {
        await transporter.verify();
        logger.info("SMTP connection verified");
    } catch (error) {
        logger.warn("SMTP verification failed", error.message);
    }
}

export { emailConnectionVerify };
