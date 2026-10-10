import { BOOKING } from "../../../../config/booking.js";
import { renderLayout } from "../layout.js";
import {
    paragraph, detailsTable, detailsText, safeUrl, singleLine, truncate, formatDateLabel, formatTimeLabel,
} from "./shared.js";

const meetStatusLabel = (meetStatus, link) => {
    if (link) return link;
    if (meetStatus === "failed") return "Not created (Google Meet failed). Retry it from the admin panel.";
    return "Not created yet";
};

/**
 * Internal notification of a new virtual meeting booking. Includes the customer's
 * free-text topic. The sender sets Reply-To to the customer's email.
 */
export const vmNotificationCompanyTemplate = ({
    bookingId, date, time, name, email, mobileNumber, organisation, designation, topic,
    meetLink, meetStatus, durationMinutes = BOOKING.vm.durationMinutes,
}) => {
    const link = safeUrl(meetLink);
    const when = `${formatDateLabel(date)}, ${formatTimeLabel(time)}`;

    const rows = [
        ["Booking ID", bookingId],
        ["Date", formatDateLabel(date)],
        ["Time", formatTimeLabel(time)],
        ["Duration", `${durationMinutes} minutes`],
        ["Name", name],
        ["Email", email],
        ["Mobile Number", mobileNumber],
        ["Organisation", organisation],
        ["Designation", designation],
        ["Topic", topic, { multiline: true }],
        ["Google Meet", meetStatusLabel(meetStatus, link)],
    ];

    const text = `
NEW VIRTUAL MEETING BOOKING

${detailsText(rows)}

Reply to this email to reach the customer.
`.trim();

    const html = renderLayout({
        title: "New virtual meeting booking",
        body: [
            paragraph("A customer has booked a virtual meeting through the Oceao Enviro website."),
            detailsTable(rows),
            paragraph("Reply to this email to reach the customer."),
        ].join("\n"),
    });

    return {
        subject: `New Virtual Meeting Booking - ${truncate(singleLine(name), 80)}, ${when}`,
        text,
        html,
    };
};
