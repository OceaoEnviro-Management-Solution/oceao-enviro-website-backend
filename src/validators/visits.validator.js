import { z } from "zod";
import { MAX_DAILY_DAYS } from "../services/visits.service.js";

const RANGE_MESSAGE = `Must be a whole number from 1 to ${MAX_DAILY_DAYS}`;

// GET /admin/visits?days   (default 30, at most 90)
const adminVisitsQuerySchema = z
    .object({
        days: z
            .string({ error: RANGE_MESSAGE })
            .trim()
            .regex(/^\d{1,3}$/, RANGE_MESSAGE)
            .transform(Number)
            .pipe(z.number().min(1, RANGE_MESSAGE).max(MAX_DAILY_DAYS, RANGE_MESSAGE))
            .optional(),
    })
    .strict();

export { adminVisitsQuerySchema };
