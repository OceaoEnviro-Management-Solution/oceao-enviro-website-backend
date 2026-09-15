import { ApiError } from "../utils/ApiError.js";
import { sendMailService } from "./email/email.services.js";

import { queryClientConfirmationTemplate }
    from "./email/templates/query/clientConfirmation.query.template.js";

import { queryCompanyNotificationTemplate }
    from "./email/templates/query/companyNotification.query.template.js";


const handleNewQueryService = async ({
    name,
    email,
    mobileNumber,
    organisation,
    industry,
    source,
    subject,
    query
}) => {

    const companyResponse = queryCompanyNotificationTemplate({
        name,
        email,
        mobileNumber,
        organisation,
        industry,
        source,
        subject,
        query
    });

    // Company notification is critical.
    // If this fails, the query operation fails.
    try {

        await sendMailService({
            to: process.env.COMPANY_MAIL,
            from: process.env.MAIL_FROM,
            replyTo: email,
            subject: companyResponse.subject,
            text: companyResponse.text,
            html: companyResponse.html
        });

    } catch (error) {

        console.error("Company query notification failed:", error);

        throw new ApiError(
            500,
            "Unable to process your query at the moment. Please try again later."
        );
    }


    // Customer confirmation is non-critical.
    // If this fails, the query has still been received by the company.
    const clientResponse = queryClientConfirmationTemplate({
        name,
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

        // Intentionally ignored.
    }
};

export { handleNewQueryService };