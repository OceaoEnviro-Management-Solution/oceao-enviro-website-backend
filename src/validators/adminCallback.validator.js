import { z } from "zod";
import { BOOKING } from "../config/booking.js";
import { REQUEST_ID_PATTERN } from "../utils/ids.js";
import { CAPACITY_LIMITS } from "../models/settings.model.js";
import { dateKey, performedBy, reason } from "./adminVm.validator.js";

const periods = BOOKING.callback.periodOrder;

const requestId = z
    .string({ error: "A request ID is required" })
    .trim()
    .regex(REQUEST_ID_PATTERN, "Must look like OE-CB-YYMMDD-XXXX");

const holidayName = z
    .string({ error: "A holiday name is required" })
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name cannot exceed 100 characters");

// POST /admin/callback/blocks and /admin/callback/blocks/remove: one period, or the whole day.
const callbackBlockSchema = z
    .object({
        date: dateKey,
        period: z.enum(periods, { error: `Must be one of: ${periods.join(", ")}` }).optional(),
        allDay: z.literal(true, { error: "allDay must be true (or leave it out and send a period)" }).optional(),
        performedBy,
        reason,
    })
    .strict()
    .superRefine(({ period, allDay }, ctx) => {
        if ((period === undefined) === (allDay === undefined)) {
            ctx.addIssue({
                code: "custom",
                path: ["period"],
                message: "Send exactly one of period or allDay: true",
            });
        }
    });

// POST /admin/callback/requests/cancel   (1 to 50 request IDs)
const cancelRequestsSchema = z.object({
    requestIds: z
        .array(requestId, { error: "requestIds must be a list of request IDs" })
        .min(1, "Send at least one request ID")
        .max(50, "Cancel at most 50 requests at a time"),
    performedBy,
    reason,
}).strict();

// PATCH /admin/callback/requests/:requestId   ("cancelled" is not a status you can set here)
const requestStatusSchema = z.object({
    status: z.enum(["pending", "completed", "no_answer"], { error: "Must be one of: pending, completed, no_answer" }),
    performedBy,
}).strict();

// :requestId in the path
const requestIdParamsSchema = z.object({ requestId }).strict();

// PUT /admin/settings/callback-capacity
const capacityField = (label) =>
    z
        .number({ error: `${label} capacity must be a whole number from ${CAPACITY_LIMITS.min} to ${CAPACITY_LIMITS.max}` })
        .int(`${label} capacity must be a whole number`)
        .min(CAPACITY_LIMITS.min, `${label} capacity cannot be below ${CAPACITY_LIMITS.min}`)
        .max(CAPACITY_LIMITS.max, `${label} capacity cannot exceed ${CAPACITY_LIMITS.max}`);

const capacitySchema = z.object({
    morning: capacityField("Morning"),
    afternoon: capacityField("Afternoon"),
    evening: capacityField("Evening"),
    performedBy,
    reason,
}).strict();

// POST /admin/holidays
const holidayCreateSchema = z.object({ date: dateKey, name: holidayName, performedBy, reason }).strict();

// POST /admin/holidays/bulk   (1 to 60 holidays)
const holidayBulkSchema = z.object({
    holidays: z
        .array(z.object({ date: dateKey, name: holidayName }).strict(), {
            error: "holidays must be a list of { date, name }",
        })
        .min(1, "Send at least one holiday")
        .max(60, "Add at most 60 holidays at a time"),
    performedBy,
    reason,
}).strict();

// PATCH /admin/holidays/:date
const holidayRenameSchema = z.object({ name: holidayName, performedBy, reason }).strict();

// DELETE /admin/holidays/:date   (the reason travels in the body)
const holidayDeleteSchema = z.object({ performedBy, reason }).strict();

// :date in the path
const dateParamsSchema = z.object({ date: dateKey }).strict();

export {
    callbackBlockSchema,
    cancelRequestsSchema,
    requestStatusSchema,
    requestIdParamsSchema,
    capacitySchema,
    holidayCreateSchema,
    holidayBulkSchema,
    holidayRenameSchema,
    holidayDeleteSchema,
    dateParamsSchema,
};
