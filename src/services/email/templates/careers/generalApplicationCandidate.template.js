import { renderLayout } from "../layout.js";
import { paragraph, singleLine } from "../booking/shared.js";

/** To the candidate who sent a resume without a job: thank you, with the reference ID. No promised timeline. */
export const generalApplicationCandidateTemplate = ({ fullName, referenceId, desiredRole }) => {
    const lines = [
        `Dear ${fullName},`,
        `Thank you for sending your resume to Oceao Enviro for a ${desiredRole} role. Your reference ID is ${referenceId}.`,
        "We don't have a matching opening posted right now, but our team reads every resume. If a suitable role opens up, we will contact you by email or phone.",
        "Because we receive many resumes, we may not be able to reply to each one individually.",
        "We keep your details for up to 12 months, after which they are deleted.",
    ];
    const signOff = ["Warm regards,", "Oceao Enviro HR Team"];

    const text = [...lines, signOff.join("\n")].join("\n\n");

    const html = renderLayout({
        title: "We've received your resume",
        body: [...lines.map(paragraph), paragraph(signOff[0]), paragraph(signOff[1])].join("\n"),
    });

    return {
        subject: singleLine(`We've received your resume for ${singleLine(desiredRole)}`),
        text,
        html,
    };
};
