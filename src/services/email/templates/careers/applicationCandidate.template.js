import { renderLayout } from "../layout.js";
import { paragraph, singleLine } from "../booking/shared.js";

/** To the candidate: thank you, with the reference ID. No promised timeline. */
export const applicationCandidateTemplate = ({ fullName, applicationId, jobTitle }) => {
    const lines = [
        `Dear ${fullName},`,
        `Thank you for applying for ${jobTitle} at Oceao Enviro. Your reference ID is ${applicationId}.`,
        "Our team reviews every application carefully. If your profile matches the role, we will contact you by email or phone.",
        "Because we receive many applications, we may not be able to reply to each one individually.",
        "We keep your application for up to 12 months, after which it is deleted.",
    ];
    const signOff = ["Warm regards,", "Oceao Enviro HR Team"];

    const text = [...lines, signOff.join("\n")].join("\n\n");

    const html = renderLayout({
        title: "We've received your application",
        body: [...lines.map(paragraph), paragraph(signOff[0]), paragraph(signOff[1])].join("\n"),
    });

    return {
        subject: singleLine(`We've received your application for ${singleLine(jobTitle)}`),
        text,
        html,
    };
};
