import { z } from "zod";
import { isValidDateKey, addDays } from "../utils/time.js";
import { MAX_CALENDAR_RANGE_DAYS } from "../services/vmAvailability.service.js";

const dateKey = z
    .string({ error: "Date is required (YYYY-MM-DD)" })
    .trim()
    .refine(isValidDateKey, "Must be a valid date in the form YYYY-MM-DD");

const calendarQuerySchema = z
    .object({ from: dateKey, to: dateKey })
    .strict()
    .superRefine(({ from, to }, ctx) => {
        // Only compare once both are valid dates (otherwise the field errors above already apply).
        if (!isValidDateKey(from) || !isValidDateKey(to)) return;

        if (to < from) {
            ctx.addIssue({ code: "custom", path: ["to"], message: "'to' must be on or after 'from'" });
        } else if (to > addDays(from, MAX_CALENDAR_RANGE_DAYS - 1)) {
            ctx.addIssue({
                code: "custom",
                path: ["to"],
                message: `Range cannot exceed ${MAX_CALENDAR_RANGE_DAYS} days`,
            });
        }
    });

const availabilityQuerySchema = z.object({ date: dateKey }).strict();

export { calendarQuerySchema, availabilityQuerySchema };
