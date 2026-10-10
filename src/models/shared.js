// Field definitions shared by the booking models.

import { isValidDateKey } from "../utils/time.js";

/** A "YYYY-MM-DD" IST date. */
export const dateKeyField = () => ({
    type: String,
    required: true,
    trim: true,
    validate: {
        validator: isValidDateKey,
        message: "{PATH} must be a valid YYYY-MM-DD date",
    },
});

/** Customer email: trimmed and lowercased. */
export const emailField = (options = {}) => ({
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    ...options,
});

/** Indian mobile number in the stored form +91XXXXXXXXXX. */
export const mobileNumberField = () => ({
    type: String,
    required: true,
    trim: true,
    match: [/^\+91[6-9]\d{9}$/, "{PATH} must be in the form +91XXXXXXXXXX"],
});

/** Deletion time for a TTL index; set with expireAtFor(dateKey). */
export const expireAtField = () => ({ type: Date, required: true });
