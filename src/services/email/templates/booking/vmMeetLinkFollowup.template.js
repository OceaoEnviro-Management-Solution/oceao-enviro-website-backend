import { renderLayout } from "../layout.js";
import {
    paragraph, detailsTable, detailsText, linkButton, safeUrl, formatDateLabel, formatTimeLabel,
} from "./shared.js";

/** Sent after staff successfully create a Meet link that was missing at booking time. */
export const vmMeetLinkFollowupTemplate = ({ name, bookingId, date, time, meetLink }) => {
    const link = safeUrl(meetLink);
    const rows = [
        ["Booking ID", bookingId],
        ["Date", formatDateLabel(date)],
        ["Time", formatTimeLabel(time)],
    ];

    const text = `
Hello ${name},

Here is the Google Meet link for your virtual meeting with Oceao Enviro.

${detailsText(rows)}

${link ? `Join with Google Meet: ${link}` : "Your Google Meet link is not available yet. We will contact you shortly."}

Regards,
Oceao Enviro
`.trim();

    const html = renderLayout({
        title: "Your Google Meet link",
        body: [
            paragraph(`Hello ${name},`),
            paragraph("Here is the Google Meet link for your virtual meeting with Oceao Enviro."),
            detailsTable(rows),
            link
                ? linkButton(link, "Join with Google Meet")
                : paragraph("Your Google Meet link is not available yet. We will contact you shortly."),
        ].join("\n"),
    });

    return {
        subject: `Your Google Meet Link - ${formatDateLabel(date)}, ${formatTimeLabel(time)}`,
        text,
        html,
    };
};
