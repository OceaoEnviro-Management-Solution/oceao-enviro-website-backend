import { z } from "zod";
import { BOOKING } from "../config/booking.js";
import { isValidDateKey } from "../utils/time.js";
import { indianMobile } from "./common.js";

// Optional free text: surrounding spaces are trimmed and a blank value counts as not provided.
const optionalText = (max, label) =>
    z.preprocess(
        (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
        z.string().trim().max(max, `${label} cannot exceed ${max} characters`).optional()
    );

// turnstileToken is not part of this schema: requireTurnstile verifies it and removes it
// from the body before validation.
const createCallbackRequestSchema = z.object({
    name: z
        .string()
        .trim()
        .min(2, "Name must contain at least 2 characters")
        .max(100, "Name cannot exceed 100 characters"),
    email: z
        .string()
        .trim()
        .max(254, "Email cannot exceed 254 characters")
        .email("Invalid email address")
        .toLowerCase(),
    mobileNumber: indianMobile,
    date: z
        .string({ error: "Date is required (YYYY-MM-DD)" })
        .trim()
        .refine(isValidDateKey, "Must be a valid date in the form YYYY-MM-DD"),
    period: z.enum(BOOKING.callback.periodOrder, {
        error: `Period must be one of: ${BOOKING.callback.periodOrder.join(", ")}`,
    }),
    reason: optionalText(500, "Reason"),
});

export { createCallbackRequestSchema };
