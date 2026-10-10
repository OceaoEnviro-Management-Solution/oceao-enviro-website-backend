import { BOOKING } from "../../../../config/booking.js";
import { renderLayout } from "../layout.js";
import {
    paragraph, detailsTable, detailsText, linkButton, safeUrl, formatDateLabel, formatTimeLabel,
} from "./shared.js";

export const MEET_LINK_PENDING_MESSAGE = "Your Google Meet link will follow in a separate email.";

/**
 * Booking confirmation for the customer. Shows the Meet link when there is one,
 * otherwise tells them it will follow. Never includes the customer's free-text topic.
 */
export const vmConfirmationCustomerTemplate = ({
    name,
    bookingId,
    date,
    time,
    durationMinutes = BOOKING.vm.durationMinutes,
    meetLink,
}) => {
    const link = safeUrl(meetLink);
    const rows = [
        ["Booking ID", bookingId],
        ["Date", formatDateLabel(date)],
        ["Time", formatTimeLabel(time)],
        ["Duration", `${durationMinutes} minutes`],
    ];

    const text = `
Hello ${name},

Your virtual meeting with Oceao Enviro is confirmed.

${detailsText(rows)}

${link ? `Join with Google Meet: ${link}` : MEET_LINK_PENDING_MESSAGE}

Please quote your booking ID if you need to contact us about this meeting.

Regards,
Oceao Enviro
`.trim();

    const html = renderLayout({
        title: "Your virtual meeting is confirmed",
        body: [
            paragraph(`Hello ${name},`),
            paragraph("Your virtual meeting with Oceao Enviro is confirmed."),
            detailsTable(rows),
            link ? linkButton(link, "Join with Google Meet") : paragraph(MEET_LINK_PENDING_MESSAGE),
            paragraph("Please quote your booking ID if you need to contact us about this meeting."),
        ].join("\n"),
    });

    return {
        subject: `Virtual Meeting Confirmed - ${formatDateLabel(date)}, ${formatTimeLabel(time)}`,
        text,
        html,
    };
};
