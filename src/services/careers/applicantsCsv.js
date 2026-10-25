// The applicants of one job as a CSV file that opens correctly in Excel:
//   - UTF-8 with a byte order mark first, so Hindi and other non-English names show correctly
//   - RFC 4180 quoting: a cell with a comma, a quote or a line break is wrapped in quotes, and
//     quotes inside are doubled; rows end with CRLF
//   - formula guard: a cell starting with =, +, -, @, a tab or a carriage return gets a leading
//     single quote, so a name like =HYPERLINK(...) is shown as text and never runs as a formula

import { JobApplication } from "../../models/jobApplication.model.js";
import { nowIST } from "../../utils/time.js";
import { recordAudit } from "../audit.service.js";

const BOM = "\uFEFF";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STATUS_LABELS = { new: "New", shortlisted: "Shortlisted", rejected: "Rejected", hired: "Hired" };
const pad = (value) => String(value).padStart(2, "0");

export const CSV_COLUMNS = Object.freeze([
    ["Application ID", (a) => a.applicationId],
    ["Applied At", (a) => formatAppliedAt(a.createdAt)],
    ["Status", (a) => STATUS_LABELS[a.status] ?? a.status],
    ["Full Name", (a) => a.fullName],
    ["Email", (a) => a.email],
    ["Phone", (a) => a.phone],
    ["Current Location", (a) => a.currentLocation],
    ["Total Experience (years)", (a) => a.totalExperienceYears],
    ["Current Organisation", (a) => a.currentOrganisation],
    ["Current Designation", (a) => a.currentDesignation],
    ["Highest Qualification", (a) => a.highestQualification],
    ["Notice Period", (a) => a.noticePeriod],
    ["Expected CTC", (a) => a.expectedCtc],
    ["Profile URL", (a) => a.profileUrl],
    ["Cover Note", (a) => a.coverNote],
    ["Resume File Name", (a) => a.resume?.originalName],
    ["Job Title", (a) => a.jobSnapshot?.title],
]);

/** A moment in IST as "25 Oct 2026 14:30". */
export const formatAppliedAt = (date) => {
    const { dateKey, minutes } = nowIST(new Date(date));
    const [year, month, day] = dateKey.split("-").map(Number);
    return `${day} ${MONTHS[month - 1]} ${year} ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
};

const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: formula guard first, then quoting. */
export const csvCell = (value) => {
    let text = value === undefined || value === null ? "" : String(value);
    if (FORMULA_START.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** The whole file (BOM, header row, one row per application). */
export const buildApplicantsCsv = (applications) => {
    const rows = [CSV_COLUMNS.map(([header]) => header), ...applications.map((a) => CSV_COLUMNS.map(([, read]) => read(a)))];
    return BOM + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
};

/** The CSV of a job's applications (newest first) and its file name; each export is audited. */
export const exportApplicantsCsv = async (job, { performedBy = "Admin" } = {}, now = new Date()) => {
    const applications = await JobApplication.find({ jobId: job._id }).sort({ createdAt: -1, _id: -1 }).lean();

    await recordAudit({
        action: "career.csv.export",
        targetType: "job",
        targetId: String(job._id),
        detail: { slug: job.slug, rows: applications.length },
        performedBy,
    }, { now });

    return {
        filename: `${job.slug}-applicants-${nowIST(now).dateKey}.csv`,
        csv: buildApplicantsCsv(applications),
        rows: applications.length,
    };
};
