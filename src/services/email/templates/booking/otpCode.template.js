import { BOOKING } from "../../../../config/booking.js";
import { renderLayout } from "../layout.js";
import { paragraph } from "./shared.js";
import { escapeHtml } from "../../../../utils/escapeHTML.js";

/** The one-time code for the virtual meeting booking. Sent to the customer. */
export const otpCodeTemplate = ({ code, validityMinutes = BOOKING.otp.validityMinutes }) => {
    const text = `
Your Oceao Enviro verification code is: ${code}

This code is valid for ${validityMinutes} minutes. Do not share it with anyone.

If you did not request this code, you can ignore this email.
`.trim();

    const html = renderLayout({
        title: "Your verification code",
        body: [
            paragraph("Use this code to continue booking your virtual meeting:"),
            `<p style="margin:0 0 18px; font-family:Arial, Helvetica, sans-serif; font-size:32px; font-weight:bold; letter-spacing:6px; color:#0F1D75;">${escapeHtml(code)}</p>`,
            paragraph(`This code is valid for ${validityMinutes} minutes. Do not share it with anyone.`),
            paragraph("If you did not request this code, you can ignore this email."),
        ].join("\n"),
    });

    return { subject: "Your Oceao Enviro verification code", text, html };
};
