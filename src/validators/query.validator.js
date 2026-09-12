import { z } from "zod";

const querySchema = z.object({
    name: z
        .string()
        .trim()
        .min(2, "Name must contain at least 2 characters")
        .max(100, "Name cannot exceed 100 characters"),

    email: z
        .string()
        .trim()
        .email("Invalid email address")
        .toLowerCase(),

    mobileNumber: z
        .string()
        .trim()
        .regex(/^[6-9]\d{9}$/, "Invalid Indian mobile number"),

    organisation: z
        .string()
        .trim()
        .max(150, "Company name cannot exceed 150 characters")
        .optional(),

    industry: z
        .string()
        .trim()
        .max(100, "Industry cannot exceed 100 characters")
        .optional()
        .nullable(),

    source: z
        .string()
        .trim()
        .max(100, "Source cannot exceed 100 characters")
        .optional()
        .nullable(),

    subject: z
        .string()
        .trim()
        .min(3, "Subject must contain at least 3 characters")
        .max(150, "Subject cannot exceed 150 characters"),

    query: z
        .string()
        .trim()
        .min(10, "Query must contain at least 10 characters")
        .max(5000, "Query cannot exceed 5000 characters")

});

export { querySchema };
