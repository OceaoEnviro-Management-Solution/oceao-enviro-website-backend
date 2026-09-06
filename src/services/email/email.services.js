import { transporter } from "./email.transpoter.js";

const sendMail = async (from, to, subject, text, html, replyTo) => {
    try {
        const mailOptions = {
            from,
            to,
            subject,
            text,
            html,
            replyTo
        }

        const result = await transporter.sendMail(mailOptions);

        console.log("✅ Email sent", result);
        return true;
    } catch (error) {
        console.log("❌ Email not sent", error);
        return false;
    }
}

export { sendMail };