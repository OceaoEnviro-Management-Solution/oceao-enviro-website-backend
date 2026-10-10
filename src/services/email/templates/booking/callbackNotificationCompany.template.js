import { renderLayout } from "../layout.js";
import {
    paragraph, detailsTable, detailsText, singleLine, truncate, formatDateLabel, formatPeriodLabel,
} from "./shared.js";

/**
 * Internal notification of a new callback request. Includes the customer's free-text
 * reason. The sender sets Reply-To to the customer's email.
 */
export const callbackNotificationCompanyTemplate = ({
    requestId, date, period, name, email, mobileNumber, reason,
}) => {
    const rows = [
        ["Request ID", requestId],
        ["Date", formatDateLabel(date)],
        ["Callback window", formatPeriodLabel(period)],
        ["Name", name],
        ["Email", email],
        ["Mobile Number", mobileNumber],
        ["Reason", reason, { multiline: true }],
    ];

    const text = `
NEW CALLBACK REQUEST

${detailsText(rows)}

Please call the customer during the requested window. Reply to this email to reach them by email.
`.trim();

    const html = renderLayout({
        title: "New callback request",
        body: [
            paragraph("A customer has requested a callback through the Oceao Enviro website."),
            detailsTable(rows),
            paragraph("Please call the customer during the requested window. Reply to this email to reach them by email."),
        ].join("\n"),
    });

    return {
        subject: `New Callback Request - ${truncate(singleLine(name), 80)}, ${formatDateLabel(date)}`,
        text,
        html,
    };
};
