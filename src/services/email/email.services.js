import { transporter } from "./email.transpoter.js";

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

    const result = await transporter.sendMail(mailOptions);

    return result;

}

export { sendMailService };