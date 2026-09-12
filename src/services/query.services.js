import { sendMailService } from "./email/email.services.js";
import { queryClientConfirmationTemplate } from "./email/templates/query/clientConfirmation.query.template.js";
import { queryCompanyNotificationTemplate } from "./email/templates/query/companyNotification.query.template.js";

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
    const clientResponse = queryClientConfirmationTemplate({ name, industry });


    const companyResponse = queryCompanyNotificationTemplate({
        name,
        email,
        mobileNumber,
        organisation,
        industry,
        source,
        subject,
        query
    })

    const companyMail = await sendMailService({
        to: process.env.COMPANY_MAIL,
        from: process.env.MAIL_FROM,
        replyTo: email,
        subject: companyResponse.subject,
        text: companyResponse.text,
        html: companyResponse.html,
    })

    if (companyMail.rejected?.size > 0) {
        return false;
    }

    const clientMail = await sendMailService({
        to: email,
        from: process.env.MAIL_FROM,
        replyTo: process.env.COMPANY_MAIL,
        subject: clientResponse.subject,
        text: clientResponse.text,
        html: clientResponse.html,
    })

    return true;
}

export { handleNewQueryService };