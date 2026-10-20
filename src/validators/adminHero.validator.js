import { z } from "zod";
import { HERO } from "../config/hero.js";
import { HERO_LIMITS, HERO_SETS } from "../models/heroSlide.model.js";
import { isValidDateKey } from "../utils/time.js";

// Who did it (the employee name typed in the admin UI). Kept in the audit log.
const performedBy = z
    .string({ error: "Your name is required" })
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(60, "Name cannot exceed 60 characters");

const slideId = z.string({ error: "A slide id is required" }).regex(/^[0-9a-fA-F]{24}$/, "Must be a slide id");

const set = z.enum(HERO_SETS, { error: `Must be one of: ${HERO_SETS.join(", ")}` });

const required = (label, { min = 1, max }) =>
    z
        .string({ error: `${label} is required` })
        .trim()
        .min(min, min > 1 ? `${label} must be at least ${min} characters` : `${label} is required`)
        .max(max, `${label} cannot exceed ${max} characters`);

const name = required("Name", HERO_LIMITS.name);
const location = required("Location", HERO_LIMITS.location);
const description = required("Description", HERO_LIMITS.description);
const creditText = z.string({ error: "Credit must be text" }).trim().max(HERO_LIMITS.credit.max, `Credit cannot exceed ${HERO_LIMITS.credit.max} characters`);

// POST /admin/hero/slides: the text fields of the multipart form (the picture is the "image" file).
// A blank credit means no credit.
const createSlideSchema = z
    .object({
        set,
        name,
        location,
        description,
        credit: creditText.optional().transform((value) => value || undefined),
        performedBy,
    })
    .strict();

// PATCH /admin/hero/slides/:id: text only. The picture can never be changed here, so there is no
// image field (and any unknown field is a 400). At least one of the four texts is needed.
// credit "" or null removes the credit.
const updateSlideSchema = z
    .object({
        name: name.optional(),
        location: location.optional(),
        description: description.optional(),
        credit: z.union([creditText, z.null()], { error: "Credit must be text or null" }).optional(),
        performedBy,
    })
    .strict()
    .refine(
        (body) => ["name", "location", "description", "credit"].some((key) => body[key] !== undefined),
        { message: "Send at least one of name, location, description or credit", path: ["name"] }
    );

const slideIdParamsSchema = z.object({ id: slideId }).strict();

// DELETE /admin/hero/slides/:id and DELETE /admin/hero/schedule
const performedBySchema = z.object({ performedBy }).strict();

// PUT /admin/hero/order: ids are checked against the set's real slides by the service.
const orderSchema = z
    .object({
        set,
        ids: z
            .array(slideId, { error: "ids must be a list of slide ids" })
            .max(HERO.maxSlidesPerSet, `A set holds at most ${HERO.maxSlidesPerSet} slides`),
        performedBy,
    })
    .strict();

// PUT /admin/hero/schedule: the date itself must also be after today (IST): the service answers 422.
const scheduleSchema = z
    .object({
        switchDate: z
            .string({ error: "switchDate is required (YYYY-MM-DD)" })
            .trim()
            .refine(isValidDateKey, "Must be a valid date in the form YYYY-MM-DD"),
        performedBy,
    })
    .strict();

export {
    createSlideSchema,
    updateSlideSchema,
    slideIdParamsSchema,
    performedBySchema,
    orderSchema,
    scheduleSchema,
};
