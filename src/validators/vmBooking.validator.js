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

// Note: there is no `email` field. The email always comes from the booking token, and
// zod drops any `email` sent in the body.
const createVmBookingSchema = z.object({
    name: z
        .string()
        .trim()
        .min(2, "Name must contain at least 2 characters")
        .max(100, "Name cannot exceed 100 characters"),
    mobileNumber: indianMobile,
    organisation: optionalText(150, "Organisation"),
    designation: optionalText(100, "Designation"),
    topic: optionalText(500, "Topic"),
    date: z
        .string({ error: "Date is required (YYYY-MM-DD)" })
        .trim()
        .refine(isValidDateKey, "Must be a valid date in the form YYYY-MM-DD"),
    time: z.enum(BOOKING.vm.slotTimes, {
        error: `Time must be one of: ${BOOKING.vm.slotTimes.join(", ")}`,
    }),
});

export { createVmBookingSchema };
