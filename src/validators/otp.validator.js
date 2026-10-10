import { z } from "zod";
import { BOOKING } from "../config/booking.js";

const email = z
    .string()
    .trim()
    .max(254, "Email cannot exceed 254 characters")
    .email("Invalid email address")
    .toLowerCase();

const sendOtpSchema = z.object({ email });

const verifyOtpSchema = z.object({
    email,
    otp: z
        .string()
        .trim()
        .regex(new RegExp(`^\\d{${BOOKING.otp.length}}$`), `Code must be ${BOOKING.otp.length} digits`),
});

export { sendOtpSchema, verifyOtpSchema };
