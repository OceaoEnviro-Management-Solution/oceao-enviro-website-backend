import { escapeHtml } from "../../../../utils/escapeHTML.js";

const feedbackCompanyNotificationTemplate = ({
    type,
    name,
    email,
    mobileNumber,
    subject,
    message,
    attachment
}) => {

    const attachmentName = attachment?.originalname || "No attachment";

    const safeName = escapeHtml(name);
    const safeType = escapeHtml(type);
    const safeSubject = escapeHtml(subject);
    const safeMessage = escapeHtml(message);
    const safeMobileNumber = escapeHtml(mobileNumber);
    const safeEmail = escapeHtml(email);
    const safeAttachmentName = escapeHtml(attachmentName);

    return {
        subject: `New Feedback Received - ${safeSubject}`,

        text: `
New feedback has been received through the Oceao Enviro website.

Feedback Type: ${type}
Name: ${name}
Email: ${email}
Mobile Number: ${mobileNumber || "Not provided"}
Subject: ${subject}

Message:
${message}

Attachment: ${attachmentName}
        `.trim(),

        html: `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>New Feedback Received</title>
</head>

<body style="margin:0; padding:0; font-family:Arial, sans-serif; color:#333;">

    <div style="max-width:700px; margin:30px auto; padding:20px;">

        <h2 style="margin-bottom:20px;">
            New Feedback Received
        </h2>

        <p>
            A new feedback submission has been received
            through the Oceao Enviro website.
        </p>

        <table
            cellpadding="10"
            cellspacing="0"
            border="1"
            style="width:100%; border-collapse:collapse; margin-top:20px;"
        >

            <tr>
                <td><strong>Feedback Type</strong></td>
                <td>${safeType}</td>
            </tr>

            <tr>
                <td><strong>Name</strong></td>
                <td>${safeName}</td>
            </tr>

            <tr>
                <td><strong>Email</strong></td>
                <td>${safeEmail}</td>
            </tr>

            <tr>
                <td><strong>Mobile Number</strong></td>
                <td>${safeMobileNumber || "Not provided"}</td>
            </tr>

            <tr>
                <td><strong>Subject</strong></td>
                <td>${safeSubject}</td>
            </tr>

            <tr>
                <td><strong>Attachment</strong></td>
                <td>${safeAttachmentName}</td>
            </tr>

        </table>
        
        <hr>

        <div style="margin-top:25px;">

            <h3>Message</h3>

            <div
                style="
                    padding:15px;
                    background:#f5f5f5;
                    border-radius:5px;
                    white-space:pre-line;
                "
            >
                ${safeMessage}
            </div>

        </div>

        <hr>

        <p style="margin-top:30px; font-size:13px; color:#777;">
            This email was automatically generated from the
            Oceao Enviro website feedback form.
        </p>

    </div>

</body>
</html>
        `.trim()
    };
};

export { feedbackCompanyNotificationTemplate };