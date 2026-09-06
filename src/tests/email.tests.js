import "dotenv/config";
import { emailConnectionVerify } from "../services/email/email.connections.js";
import { sendMail } from "../services/email/email.services.js";

const testEmailConnection = async () => {
    try {
        await emailConnectionVerify();
        console.log("Test 1: ✅ Email connection test passed");
    } catch (error) {
        console.log("Test 1: ❌ Email connection test failed", error);
    }
}

// testEmailConnection();

const send = async () => {
    await sendMail(
        process.env.MAIL_FROM,
        "yuvrajpundhir9@gmail.com",
        "Test Email",
        "This is a test email from Mohit",
        "<h1>This is a test email from Mohit</h1><br><br><p>Hi Yuvraj</p>",
        process.env.MAIL_FROM
    );
}

send();