import { ApiError } from "../utils/ApiError.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { feedbackCompanyNotificationTemplate } from "./email/templates/feedback/companyNotification.feedback.template.js";
import { feedbackClientConfirmationTemplate } from "./email/templates/feedback/clientConfirmation.feedback.template.js";
import { sendMailService } from "./email/email.services.js";

const handleNewFeedbackService = async ({
    type,
    name,
    email,
    mobileNumber,
    subject,
    message,
    attachment
}) => {
    const companyResponse = feedbackCompanyNotificationTemplate({
        type,
        name,
        email,
        mobileNumber,
        subject,
        message,
        attachment
    });

    try {
        await sendMailService({
            to: config.COMPANY_MAIL,
            from: config.MAIL_FROM,
            replyTo: email,
            subject: companyResponse.subject,
            text: companyResponse.text,
            html: companyResponse.html,
            // Never use the user-supplied file name for the attachment
            attachments: attachment ? [
                {
                    filename: `feedback-attachment.${attachment.detectedExt}`,
                    content: attachment.buffer
                }
            ] : []
        });
    } catch (error) {
        logger.error("Company feedback notification failed", error);
        throw new ApiError(
            500,
            "INTERNAL_ERROR",
            "Unable to process your feedback at the moment. Please try again later."
        );
    }

    const clientResponse = feedbackClientConfirmationTemplate({
        name,
        type,
        subject
    });

    try {
        await sendMailService({
            to: email,
            from: config.MAIL_FROM,
            subject: clientResponse.subject,
            text: clientResponse.text,
            html: clientResponse.html
        });
    } catch (error) {
        logger.error("Customer confirmation email failed", error);
    }
}

export { handleNewFeedbackService };