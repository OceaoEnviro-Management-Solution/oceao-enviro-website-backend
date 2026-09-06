import { transporter } from "./email.transpoter.js";

const emailConnectionVerify = async () => {
    await transporter.verify();
    console.log("✅ Email connection established");
}

export { emailConnectionVerify };