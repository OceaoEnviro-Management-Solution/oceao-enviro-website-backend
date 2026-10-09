import { z } from "zod";
import { indianMobile } from "./common.js";

const feedbackSchema = z.object({
    type: z
        .string()
        .trim()
        .min(1, "Type is required")
        .max(100, "Type cannot exceed 100 characters"),
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

    // Optional: a blank value is treated as not provided
    mobileNumber: z.preprocess(
        (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
        indianMobile.optional()
    ),

    subject: z
        .string()
        .trim()
        .min(10, "Subject must contain at least 10 characters")
        .max(100, "Subject cannot exceed 100 characters"),
    message: z
        .string()
        .trim()
        .min(10, "Message must contain at least 10 characters")
        .max(5000, "Message cannot exceed 5000 characters")
});

export { feedbackSchema };
