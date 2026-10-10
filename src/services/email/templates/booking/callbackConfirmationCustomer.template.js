import { renderLayout } from "../layout.js";
import { paragraph, detailsTable, detailsText, formatDateLabel, formatPeriodLabel } from "./shared.js";

/** Confirmation of a callback request. Never includes the customer's free-text reason. */
export const callbackConfirmationCustomerTemplate = ({ name, requestId, date, period }) => {
    const rows = [
        ["Request ID", requestId],
        ["Date", formatDateLabel(date)],
        ["Callback window", formatPeriodLabel(period)],
    ];

    const text = `
Hello ${name},

We have received your callback request.

${detailsText(rows)}

Our team will call you on the mobile number you provided during this window.

Regards,
Oceao Enviro
`.trim();

    const html = renderLayout({
        title: "We have received your callback request",
        body: [
            paragraph(`Hello ${name},`),
            paragraph("We have received your callback request."),
            detailsTable(rows),
            paragraph("Our team will call you on the mobile number you provided during this window."),
        ].join("\n"),
    });

    return {
        subject: `Callback Request Received - ${formatDateLabel(date)}`,
        text,
        html,
    };
};
