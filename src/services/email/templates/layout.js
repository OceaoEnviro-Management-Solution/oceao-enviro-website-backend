// Shared HTML wrapper for booking emails: plain markup, inline styles only (email clients
// strip <style> blocks), 600px max width, company footer.
//
// `title` is plain text and is escaped here. `body` is HTML that the caller has already
// built from escaped values; it is inserted as is.

import { escapeHtml } from "../../../utils/escapeHTML.js";

export const COMPANY_NAME = "Oceao Enviro";

const FONT = "Arial, Helvetica, sans-serif";

export const renderLayout = ({ title, body }) => {
    const safeTitle = escapeHtml(title);

    return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle}</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f6f4; font-family:${FONT}; color:#333333;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f6f4;">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border:1px solid #e2e8e2;">
<tr>
<td style="padding:18px 28px; background-color:#017119; color:#ffffff; font-family:${FONT}; font-size:18px; font-weight:bold;">
${escapeHtml(COMPANY_NAME)}
</td>
</tr>
<tr>
<td style="padding:28px; font-family:${FONT}; font-size:15px; line-height:1.5; color:#333333;">
<h1 style="margin:0 0 18px; font-size:20px; line-height:1.3; color:#0F1D75;">${safeTitle}</h1>
${body}
</td>
</tr>
<tr>
<td style="padding:16px 28px; border-top:1px solid #e2e8e2; background-color:#f8faf8; font-family:${FONT}; font-size:12px; line-height:1.5; color:#777777;">
<strong>${escapeHtml(COMPANY_NAME)}</strong><br>
This is an automated message from the ${escapeHtml(COMPANY_NAME)} website.
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`.trim();
};
