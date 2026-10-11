import { z } from "zod";
import { BOOKING } from "../config/booking.js";
import { BOOKING_ID_PATTERN } from "../utils/ids.js";
import { isValidDateKey } from "../utils/time.js";

const dateKey = z
    .string({ error: "Date is required (YYYY-MM-DD)" })
    .trim()
    .refine(isValidDateKey, "Must be a valid date in the form YYYY-MM-DD");

// Who did it (the employee name typed in the admin UI) and why. Both are kept in the audit log.
const performedBy = z
    .string({ error: "Your name is required" })
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(60, "Name cannot exceed 60 characters");

const reason = z
    .string({ error: "A reason is required" })
    .trim()
    .min(3, "Reason must be at least 3 characters")
    .max(300, "Reason cannot exceed 300 characters");

// POST /admin/vm/blocks and /admin/vm/blocks/remove: one slot time, or the whole day.
const slotTargetSchema = z
    .object({
        date: dateKey,
        time: z.enum(BOOKING.vm.slotTimes, { error: `Must be one of: ${BOOKING.vm.slotTimes.join(", ")}` }).optional(),
        allDay: z.literal(true, { error: "allDay must be true (or leave it out and send a time)" }).optional(),
        performedBy,
        reason,
    })
    .superRefine(({ time, allDay }, ctx) => {
        if ((time === undefined) === (allDay === undefined)) {
            ctx.addIssue({
                code: "custom",
                path: ["time"],
                message: "Send exactly one of time or allDay: true",
            });
        }
    });

// POST /admin/vm/bookings/:bookingId/cancel
const cancelBookingSchema = z.object({
    performedBy,
    reason,
    alsoBlock: z.boolean({ error: "alsoBlock must be true or false" }).default(false),
});

// POST /admin/vm/bookings/:bookingId/retry-meet
const retryMeetSchema = z.object({ performedBy });

// :bookingId in the path
const bookingIdParamsSchema = z.object({
    bookingId: z
        .string()
        .trim()
        .regex(BOOKING_ID_PATTERN, "Must look like OE-VM-YYMMDD-XXXX"),
});

// dateKey, performedBy and reason are shared with the other admin write validators.
export { dateKey, performedBy, reason, slotTargetSchema, cancelBookingSchema, retryMeetSchema, bookingIdParamsSchema };
