import { z } from "zod";
import { BOOKING } from "../config/booking.js";
import { isValidDateKey, addDays } from "../utils/time.js";
import { MAX_CALENDAR_RANGE_DAYS } from "../services/vmAvailability.service.js";

const dateKey = z
    .string({ error: "Date is required (YYYY-MM-DD)" })
    .trim()
    .refine(isValidDateKey, "Must be a valid date in the form YYYY-MM-DD");

const month = z
    .string({ error: "Month is required (YYYY-MM)" })
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Must be a month in the form YYYY-MM");

const year = z
    .string({ error: "Year is required (YYYY)" })
    .trim()
    .regex(/^\d{4}$/, "Must be a four digit year");

const period = z.enum(BOOKING.callback.periodOrder, {
    error: `Must be one of: ${BOOKING.callback.periodOrder.join(", ")}`,
});

// Query strings arrive as text.
const flag = z
    .enum(["true", "false"], { error: "Must be true or false" })
    .default("false")
    .transform((value) => value === "true");

// GET /admin/dashboard?date   (default: today in IST, applied by the service)
const dashboardQuerySchema = z.object({ date: dateKey.optional() });

// GET /admin/bookings?from&to&type&includeCancelled   (at most 62 dates, inclusive)
const bookingsQuerySchema = z
    .object({
        from: dateKey,
        to: dateKey,
        type: z.enum(["all", "vm", "callback"], { error: "Must be one of: all, vm, callback" }).default("all"),
        includeCancelled: flag,
    })
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

// GET /admin/vm/calendar?month
const monthQuerySchema = z.object({ month });

// GET /admin/vm/availability?date  and  GET /admin/callback/availability?date
const dateQuerySchema = z.object({ date: dateKey });

// GET /admin/callback/requests?date&period
const callbackRequestsQuerySchema = z.object({ date: dateKey, period: period.optional() });

// GET /admin/holidays?year
const holidaysQuerySchema = z.object({ year });

export {
    dashboardQuerySchema,
    bookingsQuerySchema,
    monthQuerySchema,
    dateQuerySchema,
    callbackRequestsQuerySchema,
    holidaysQuerySchema,
};
