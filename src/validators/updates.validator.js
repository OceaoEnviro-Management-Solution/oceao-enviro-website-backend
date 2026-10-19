import { z } from "zod";

const PAGE_MESSAGE = "Must be a whole number from 1 to 99999";

// GET /updates?page   (default 1; a page past the last one is simply empty)
const updatesQuerySchema = z
    .object({
        page: z
            .string({ error: PAGE_MESSAGE })
            .trim()
            .regex(/^\d{1,5}$/, PAGE_MESSAGE)
            .transform(Number)
            .pipe(z.number().min(1, PAGE_MESSAGE))
            .optional(),
    })
    .strict();

export { updatesQuerySchema };
