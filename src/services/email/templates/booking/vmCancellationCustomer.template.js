import { renderLayout } from "../layout.js";
import { paragraph, detailsTable, detailsText, formatDateLabel, formatTimeLabel } from "./shared.js";

/**
 * Tells the customer their meeting was cancelled. Deliberately has no cancellation
 * reason: staff reasons are internal.
 */
export const vmCancellationCustomerTemplate = ({ name, bookingId, date, time }) => {
    const rows = [
        ["Booking ID", bookingId],
        ["Date", formatDateLabel(date)],
        ["Time", formatTimeLabel(time)],
    ];

    const text = `
Hello ${name},

Your virtual meeting with Oceao Enviro has been cancelled.

${detailsText(rows)}

We are sorry for the inconvenience. You are welcome to book another time on our website.

Regards,
Oceao Enviro
`.trim();

    const html = renderLayout({
        title: "Your virtual meeting was cancelled",
        body: [
            paragraph(`Hello ${name},`),
            paragraph("Your virtual meeting with Oceao Enviro has been cancelled."),
            detailsTable(rows),
            paragraph("We are sorry for the inconvenience. You are welcome to book another time on our website."),
        ].join("\n"),
    });

    return {
        subject: `Virtual Meeting Cancelled - ${formatDateLabel(date)}, ${formatTimeLabel(time)}`,
        text,
        html,
    };
};
