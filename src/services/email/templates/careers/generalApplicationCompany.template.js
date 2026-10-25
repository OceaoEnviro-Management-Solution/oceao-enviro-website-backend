import { renderLayout } from "../layout.js";
import { paragraph, detailsTable, detailsText, singleLine } from "../booking/shared.js";
import { formatIstDateTime, formatYears } from "./shared.js";

/**
 * To the HR inbox: a resume sent without a job (from "Don't see the right role?" on the careers
 * page). Nothing is stored by the website, so this email IS the application: every field, the
 * reference ID, and the resume attached. The sender sets Reply-To to the candidate.
 */
export const generalApplicationCompanyTemplate = (application) => {
    const a = application;
    const rows = [
        ["Reference ID", a.referenceId],
        ["Received at", formatIstDateTime(a.submittedAt)],
        ["Role interested in", a.desiredRole],
        ["Full name", a.fullName],
        ["Email", a.email],
        ["Phone", a.phone],
        ["Current location", a.currentLocation],
        ["Total experience", formatYears(a.totalExperienceYears)],
        ["Current organisation", a.currentOrganisation],
        ["Current designation", a.currentDesignation],
        ["Highest qualification", a.highestQualification],
        ["Notice period", a.noticePeriod],
        ["Expected CTC", a.expectedCtc],
        ["Profile URL", a.profileUrl],
        ["Cover note", a.coverNote, { multiline: true }],
        ["Resume", `${a.resume.originalName} (attached)`],
    ];

    const text = `
NEW GENERAL APPLICATION (no job posted)

${detailsText(rows)}

The resume is attached. Reply to this email to reach the candidate.
This application is not saved on the website: this email is the only copy.
`.trim();

    const html = renderLayout({
        title: "New general application",
        body: [
            paragraph(`${a.fullName} has sent a resume through the careers page for a ${a.desiredRole} role (no job is posted for it).`),
            detailsTable(rows),
            paragraph("The resume is attached. Reply to this email to reach the candidate."),
            paragraph("This application is not saved on the website: this email is the only copy."),
        ].join("\n"),
    });

    return {
        subject: singleLine(`General application: ${singleLine(a.desiredRole)} - ${singleLine(a.fullName)}`),
        text,
        html,
    };
};
