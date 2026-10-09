import { escapeHtml } from "../../../../utils/escapeHTML.js";

const queryClientConfirmationTemplate = ({ name, subject }) => {
    const safeName = escapeHtml(name);
    const safeSubject = escapeHtml(subject);

    const text = `
    Hello ${name},

    Thank you for contacting OCEAO ENVIRO.

    We have successfully received your query regarding: ${subject}
    
    Our team will review your request and get back to you
    within the expected response timeframe.

    We appreciate your interest in OCEAO ENVIRO.

    Regards,
    OCEAO ENVIRO
    `.trim()

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>New Query Received</title>
    </head>
    <body>
        <p>Hello ${safeName},</p>
        <p>Thank you for contacting OCEAO ENVIRO.</p>
        <p>We have successfully received your query regarding: ${safeSubject}</p>
        <p>Our team will review your request and get back to you within the expected response timeframe.</p>
        <p>We appreciate your interest in OCEAO ENVIRO.</p>
        <p>Regards,</p>
        <p>OCEAO ENVIRO</p>
    </body>
    </html>
    `.trim()

    return {
        text,
        html,
        subject: `QUERY: We Have Received Your Request`
    }
}

export { queryClientConfirmationTemplate };
