// Human-friendly public IDs: OE-VM-YYMMDD-XXXX (bookings), OE-CB-YYMMDD-XXXX (callback requests) and
// OE-JA-YYMMDD-XXXX (job applications).
// The suffix has no look-alike characters (no 0/O, 1/I/L, U) and comes from crypto.randomInt.
// The date part is the booking's IST dateKey. Callers retry on a duplicate key (up to 3 times).

import crypto from "node:crypto";
import { isValidDateKey } from "./time.js";

export const ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const SUFFIX_LENGTH = 4;

export const BOOKING_ID_PATTERN = new RegExp(`^OE-VM-\\d{6}-[${ID_ALPHABET}]{${SUFFIX_LENGTH}}$`);
export const REQUEST_ID_PATTERN = new RegExp(`^OE-CB-\\d{6}-[${ID_ALPHABET}]{${SUFFIX_LENGTH}}$`);
export const APPLICATION_ID_PATTERN = new RegExp(`^OE-JA-\\d{6}-[${ID_ALPHABET}]{${SUFFIX_LENGTH}}$`);

const randomSuffix = () => {
    let suffix = "";
    for (let i = 0; i < SUFFIX_LENGTH; i++) {
        suffix += ID_ALPHABET[crypto.randomInt(0, ID_ALPHABET.length)];
    }
    return suffix;
};

const buildId = (prefix, dateKey) => {
    if (!isValidDateKey(dateKey)) {
        throw new RangeError(`Invalid dateKey: ${dateKey}`);
    }
    const yymmdd = dateKey.slice(2, 4) + dateKey.slice(5, 7) + dateKey.slice(8, 10);
    return `${prefix}-${yymmdd}-${randomSuffix()}`;
};

/** "2026-10-15" -> "OE-VM-261015-K7Q2" */
export const generateBookingId = (dateKey) => buildId("OE-VM", dateKey);

/** "2026-10-15" -> "OE-CB-261015-M3XZ" */
export const generateRequestId = (dateKey) => buildId("OE-CB", dateKey);

/** "2026-10-25" -> "OE-JA-251025-K7Q2" */
export const generateApplicationId = (dateKey) => buildId("OE-JA", dateKey);

// General applications (a resume sent without a job) are not stored: the ID is only a reference
// that the HR email and the candidate's email share.
export const GENERAL_APPLICATION_ID_PATTERN = new RegExp(`^OE-GA-\\d{6}-[${ID_ALPHABET}]{${SUFFIX_LENGTH}}$`);

/** "2026-10-25" -> "OE-GA-251025-K7Q2" */
export const generateGeneralApplicationId = (dateKey) => buildId("OE-GA", dateKey);

// Job slugs: the kebab-case title (at most 60 characters) + "-" + 4 suffix characters, lowercased.
export const JOB_SLUG_PATTERN = new RegExp(`^(?:[a-z0-9]+-)+[${ID_ALPHABET.toLowerCase()}]{${SUFFIX_LENGTH}}$`);
const JOB_SLUG_TITLE_MAX = 60;

/** "Senior EIA Consultant (Delhi)" -> "senior-eia-consultant-delhi-k7q2". A title with no Latin letters or digits gives "job-k7q2". */
export const generateJobSlug = (title) => {
    const kebab = String(title)
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, JOB_SLUG_TITLE_MAX)
        .replace(/^-+|-+$/g, "");
    return `${kebab || "job"}-${randomSuffix().toLowerCase()}`;
};
