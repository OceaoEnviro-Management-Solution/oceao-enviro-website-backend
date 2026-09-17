import { ApiError } from "../utils/ApiError.js";
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
            to: process.env.COMPANY_MAIL,
            from: process.env.MAIL_FROM,
            replyTo: email,
            subject: companyResponse.subject,
            text: companyResponse.text,
            html: companyResponse.html,
            attachments: attachment && attachment.path ? [
                {
                    filename: attachment.originalname,
                    path: attachment.path
                }
            ] : []
        });
    } catch (error) {
        console.error("Company feedback notification failed:", error);
        throw new ApiError(
            500,
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
            from: process.env.MAIL_FROM,
            subject: clientResponse.subject,
            text: clientResponse.text,
            html: clientResponse.html
        });
    } catch (error) {
        console.error("Customer confirmation email failed:", error);
    }
}

export { handleNewFeedbackService };