import { escapeHtml } from "../../../../utils/escapeHTML.js";

const feedbackClientConfirmationTemplate = ({
    name,
    type,
    subject
}) => {

    const safeName = escapeHtml(name);
    const safeType = escapeHtml(type);
    const safeSubject = escapeHtml(subject);

    return {
        subject: "Feedback Received - Oceao Enviro",

        text: `
Dear ${name},

Thank you for contacting Oceao Enviro.

We have successfully received your feedback.

Feedback Type: ${type}
Subject: ${subject}

Our team will review your feedback and take the appropriate action where required.

Thank you for taking the time to share your feedback with us.

Regards,
Oceao Enviro
        `.trim(),

        html: `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Feedback Received</title>
</head>

<body style="margin:0; padding:0; font-family:Arial, sans-serif; color:#333;">

    <div style="max-width:650px; margin:30px auto; padding:20px;">

        <h2 style="margin-bottom:20px;">
            Feedback Received
        </h2>

        <p>
            Dear ${safeName},
        </p>

        <p>
            Thank you for contacting Oceao Enviro.
        </p>

        <p>
            We have successfully received your feedback.
        </p>

        <table
            cellpadding="10"
            cellspacing="0"
            border="1"
            style="width:100%; border-collapse:collapse; margin:20px 0;"
        >

            <tr>
                <td><strong>Feedback Type</strong></td>
                <td>${safeType}</td>
            </tr>

            <tr>
                <td><strong>Subject</strong></td>
                <td>${safeSubject}</td>
            </tr>

        </table>

        <p>
            Our team will review your feedback and take the
            appropriate action where required.
        </p>

        <p>
            Thank you for taking the time to share your feedback
            with us.
        </p>

        <p style="margin-top:30px;">
            Regards,<br>
            <strong>Oceao Enviro</strong>
        </p>

    </div>

</body>
</html>
        `.trim()
    };
};

export { feedbackClientConfirmationTemplate };