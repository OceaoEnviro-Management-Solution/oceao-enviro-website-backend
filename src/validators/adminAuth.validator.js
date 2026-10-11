import { z } from "zod";

// Deliberately loose: a malformed email is just a failed login (401), not a hint (400).
const loginSchema = z.object({
    email: z.string().trim().min(1, "Email is required").max(254, "Email cannot exceed 254 characters"),
    // Not trimmed: spaces may be part of the password.
    password: z.string().min(1, "Password is required").max(128, "Password cannot exceed 128 characters"),
}).strict();

export { loginSchema };
