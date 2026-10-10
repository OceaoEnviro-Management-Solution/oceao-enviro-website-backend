import { renderLayout } from "../layout.js";
import { paragraph, detailsTable, detailsText, formatDateLabel, formatPeriodLabel } from "./shared.js";

/** Tells the customer their callback request was cancelled. No staff reason is included. */
export const callbackCancellationCustomerTemplate = ({ name, requestId, date, period }) => {
    const rows = [
        ["Request ID", requestId],
        ["Date", formatDateLabel(date)],
        ["Callback window", formatPeriodLabel(period)],
    ];

    const text = `
Hello ${name},

Your callback request with Oceao Enviro has been cancelled.

${detailsText(rows)}

We are sorry for the inconvenience. You are welcome to submit a new request on our website.

Regards,
Oceao Enviro
`.trim();

    const html = renderLayout({
        title: "Your callback request was cancelled",
        body: [
            paragraph(`Hello ${name},`),
            paragraph("Your callback request with Oceao Enviro has been cancelled."),
            detailsTable(rows),
            paragraph("We are sorry for the inconvenience. You are welcome to submit a new request on our website."),
        ].join("\n"),
    });

    return {
        subject: `Callback Request Cancelled - ${formatDateLabel(date)}`,
        text,
        html,
    };
};
