// Helpers for the booking email templates.
//
// The HTML helpers take RAW values and escape them, so a template cannot forget to
// escape a user value. Text bodies and subjects use raw values (subjects single-line).

import { BOOKING } from "../../../../config/booking.js";
import { escapeHtml } from "../../../../utils/escapeHTML.js";
import { isValidDateKey, dayOfWeek, isValidTime } from "../../../../utils/time.js";

export { singleLine, truncate } from "../../../../utils/emailText.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-15" -> "Thu, 15 Oct 2026". Built from the key itself, so no timezone is involved. */
export const formatDateLabel = (dateKey) => {
    if (!isValidDateKey(dateKey)) return String(dateKey ?? "");
    const [year, month, day] = dateKey.split("-").map(Number);
    return `${DAYS[dayOfWeek(dateKey)]}, ${day} ${MONTHS[month - 1]} ${year}`;
};

/** "10:00" -> "10:00 AM IST", "14:00" -> "2:00 PM IST". */
export const formatTimeLabel = (time) => {
    if (!isValidTime(time)) return String(time ?? "");
    const [hours, minutes] = time.split(":").map(Number);
    const hour12 = hours % 12 || 12;
    return `${hour12}:${String(minutes).padStart(2, "0")} ${hours >= 12 ? "PM" : "AM"} IST`;
};

/** A callback period as "Morning (9 AM – 12 PM IST)". Unknown periods are returned as given. */
export const formatPeriodLabel = (periodKey) => {
    if (!Object.hasOwn(BOOKING.callback.periods, periodKey)) return String(periodKey ?? "");
    const { label, timeRange } = BOOKING.callback.periods[periodKey];
    return `${label} (${timeRange} IST)`;
};

/** Returns the URL only when it is a plain http(s) link; anything else is treated as absent. */
export const safeUrl = (value) =>
    typeof value === "string" && /^https?:\/\/[^\s"'<>]+$/i.test(value.trim()) ? value.trim() : null;

const FONT = "Arial, Helvetica, sans-serif";

export const paragraph = (value) =>
    `<p style="margin:0 0 14px; font-family:${FONT}; font-size:15px; line-height:1.5; color:#333333;">${escapeHtml(value)}</p>`;

export const detailsTable = (rows) => {
    const body = rows
        .map(([label, value, { multiline = false } = {}]) => {
            const shown = value === undefined || value === null || value === "" ? "-" : value;
            const style = multiline ? " white-space:pre-line;" : "";
            return `<tr>
<td style="padding:8px 12px; border:1px solid #e2e8e2; background-color:#f8faf8; font-family:${FONT}; font-size:14px; font-weight:bold; width:36%; vertical-align:top;">${escapeHtml(label)}</td>
<td style="padding:8px 12px; border:1px solid #e2e8e2; font-family:${FONT}; font-size:14px; vertical-align:top;${style}">${escapeHtml(shown)}</td>
</tr>`;
        })
        .join("\n");

    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; margin:0 0 18px;">
${body}
</table>`;
};

export const linkButton = (href, label) =>
    `<p style="margin:0 0 18px;"><a href="${escapeHtml(href)}" style="display:inline-block; padding:12px 22px; background-color:#017119; color:#ffffff; font-family:${FONT}; font-size:15px; font-weight:bold; text-decoration:none; border-radius:4px;">${escapeHtml(label)}</a></p>
<p style="margin:0 0 14px; font-family:${FONT}; font-size:13px; color:#555555;">Or copy this link: ${escapeHtml(href)}</p>`;

/** Plain-text details block: "Label: value" lines, same rows as detailsTable. */
export const detailsText = (rows) =>
    rows.map(([label, value]) => `${label}: ${value === undefined || value === null || value === "" ? "-" : value}`).join("\n");
