import { renderLayout } from "../layout.js";
import { paragraph, detailsTable, detailsText, linkButton, safeUrl, singleLine } from "../booking/shared.js";
import { formatExperienceRange, formatIstDateTime, formatYears } from "./shared.js";

const sectionHeading = (text) =>
    `<h2 style="margin:22px 0 10px; font-family:Arial, Helvetica, sans-serif; font-size:16px; color:#0F1D75;">${text}</h2>`;

/**
 * To the HR inbox: every detail of the application, a summary of the job and a link to the job's
 * admin dashboard. The sender attaches the resume and sets Reply-To to the candidate.
 *
 * @param {object} application  the saved application
 * @param {object} job          the job (title, department, location, employmentType, workMode, experience)
 * @param {string} dashboardUrl <first CORS origin>/admin/careers/<jobId>
 */
export const applicationCompanyTemplate = (application, job, dashboardUrl) => {
    const a = application;
    const applicantRows = [
        ["Application ID", a.applicationId],
        ["Applied at", formatIstDateTime(a.createdAt ?? a.consentAt)],
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
    const jobRows = [
        ["Title", job.title],
        ["Department", job.department],
        ["Location", job.location],
        ["Employment type", job.employmentType],
        ["Work mode", job.workMode],
        ["Experience", formatExperienceRange(job.experienceMin, job.experienceMax)],
    ];
    const link = safeUrl(dashboardUrl);

    const text = `
NEW JOB APPLICATION

APPLICANT
${detailsText(applicantRows)}

JOB
${detailsText(jobRows)}
${link ? `\nJob dashboard: ${link}\n` : ""}
The resume is attached. Reply to this email to reach the candidate.
`.trim();

    const html = renderLayout({
        title: "New job application",
        body: [
            paragraph(`${a.fullName} has applied for ${job.title} through the Oceao Enviro website.`),
            sectionHeading("Applicant"),
            detailsTable(applicantRows),
            sectionHeading("Job"),
            detailsTable(jobRows),
            link ? linkButton(link, "Open the job dashboard") : "",
            paragraph("The resume is attached. Reply to this email to reach the candidate."),
        ].join("\n"),
    });

    return {
        subject: singleLine(`New application: ${singleLine(job.title)} - ${singleLine(a.fullName)}`),
        text,
        html,
    };
};
