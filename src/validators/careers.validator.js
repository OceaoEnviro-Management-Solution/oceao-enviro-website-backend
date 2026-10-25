import { z } from "zod";
import { CAREERS } from "../config/careers.js";

const limits = CAREERS.applicationLimits;

// /careers/jobs/:slug. Any slug that is not a publicly visible job answers 404 JOB_NOT_FOUND.
const jobSlugParamsSchema = z.object({ slug: z.string().max(100) }).strict();

// Every field of the multipart apply form arrives as text.
const normalize = (value) => value.replace(/\r\n?/g, "\n").trim();

const requiredText = (label, { min = 1, max }) =>
    z
        .string({ error: `${label} is required` })
        .transform(normalize)
        .pipe(
            z
                .string()
                .min(min, min > 1 ? `${label} must be at least ${min} characters` : `${label} is required`)
                .max(max, `${label} cannot exceed ${max} characters`)
        );

// Optional text: blank means not given.
const optionalText = (label, { max }) =>
    z
        .string({ error: `${label} must be text` })
        .transform(normalize)
        .pipe(z.string().max(max, `${label} cannot exceed ${max} characters`))
        .transform((value) => value || undefined)
        .optional();

const PHONE_MESSAGE = `Enter a phone number of ${limits.phoneDigits.min} to ${limits.phoneDigits.max} digits (a leading + is allowed)`;
const EXPERIENCE_MESSAGE = `Enter your total experience in years, from ${limits.totalExperienceYears.min} to ${limits.totalExperienceYears.max} in steps of 0.5`;

// POST /careers/jobs/:slug/apply: the text fields of the multipart form (the file is "resume";
// turnstileToken is checked and removed before this runs).
const applySchema = z
    .object({
        fullName: requiredText("Full name", limits.fullName),
        email: z
            .string({ error: "Email is required" })
            .trim()
            .toLowerCase()
            .max(limits.email.max, `Email cannot exceed ${limits.email.max} characters`)
            .pipe(z.email("Enter a valid email address")),
        // "+91 98765-43210" -> "+919876543210": spaces and hyphens removed, then an optional + and 7-15 digits
        phone: z
            .string({ error: "Phone is required" })
            .transform((value) => value.replace(/[\s-]/g, ""))
            .pipe(z.string().regex(new RegExp(`^\\+?\\d{${limits.phoneDigits.min},${limits.phoneDigits.max}}$`), PHONE_MESSAGE)),
        currentLocation: requiredText("Current location", limits.currentLocation),
        totalExperienceYears: z
            .string({ error: EXPERIENCE_MESSAGE })
            .trim()
            .regex(/^\d{1,2}(\.\d{1,2})?$/, EXPERIENCE_MESSAGE)
            .transform(Number)
            .pipe(
                z
                    .number()
                    .min(limits.totalExperienceYears.min, EXPERIENCE_MESSAGE)
                    .max(limits.totalExperienceYears.max, EXPERIENCE_MESSAGE)
                    .refine((years) => Number.isInteger(years / limits.totalExperienceYears.step), EXPERIENCE_MESSAGE)
            ),
        currentOrganisation: optionalText("Current organisation", limits.currentOrganisation),
        currentDesignation: optionalText("Current designation", limits.currentDesignation),
        highestQualification: requiredText("Highest qualification", limits.highestQualification),
        noticePeriod: z
            .string({ error: "Notice period must be text" })
            .trim()
            .transform((value) => value || undefined)
            .pipe(z.enum(CAREERS.noticePeriods, { error: `Must be one of: ${CAREERS.noticePeriods.join(", ")}` }).optional())
            .optional(),
        expectedCtc: optionalText("Expected CTC", limits.expectedCtc),
        profileUrl: optionalText("Profile URL", limits.profileUrl).pipe(
            z
                .string()
                .refine((value) => {
                    try {
                        const url = new URL(value);
                        return url.protocol === "https:" && Boolean(url.hostname) && !/\s/.test(value);
                    } catch {
                        return false;
                    }
                }, "Enter a link that starts with https://")
                .optional()
        ),
        coverNote: optionalText("Cover note", limits.coverNote),
        consent: z.literal("true", { error: "Please agree to how we store and use your details" }),
    })
    .strict();

// POST /careers/general-apply: the same fields as a job application, plus the role the candidate
// is looking for (there is no job to apply to).
const generalApplySchema = z
    .object({
        ...applySchema.shape,
        desiredRole: requiredText("Role you are interested in", limits.desiredRole),
    })
    .strict();

export { jobSlugParamsSchema, applySchema, generalApplySchema };
