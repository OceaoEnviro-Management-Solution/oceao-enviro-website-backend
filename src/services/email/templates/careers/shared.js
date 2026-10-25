// Helpers for the careers email templates (the HTML helpers in ../booking/shared.js escape every value).

import { nowIST } from "../../../../utils/time.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (value) => String(value).padStart(2, "0");

/** A moment in IST: "25 Oct 2026, 14:30 IST". */
export const formatIstDateTime = (date) => {
    const { dateKey, minutes } = nowIST(new Date(date));
    const [year, month, day] = dateKey.split("-").map(Number);
    return `${day} ${MONTHS[month - 1]} ${year}, ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)} IST`;
};

/** 0-0 -> "Fresher", 2-2 -> "2 years", 2-5 -> "2-5 years". */
export const formatExperienceRange = (min, max) => {
    if (max === 0) return "Fresher";
    if (min === max) return `${min} ${min === 1 ? "year" : "years"}`;
    return `${min}-${max} years`;
};

/** 3.5 -> "3.5 years", 1 -> "1 year". */
export const formatYears = (years) => `${years} ${years === 1 ? "year" : "years"}`;

// Letters and digits only (accents dropped), words joined by "_".
const fileNamePart = (value, fallback) =>
    String(value ?? "")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^A-Za-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || fallback;

/** "Rahul Sharma", "Senior EIA Consultant", "pdf" -> "Rahul_Sharma_Senior_EIA_Consultant_Resume.pdf" */
export const resumeFileName = (fullName, jobTitle, ext) =>
    `${fileNamePart(fullName, "Candidate")}_${fileNamePart(jobTitle, "Job")}_Resume.${ext}`;
