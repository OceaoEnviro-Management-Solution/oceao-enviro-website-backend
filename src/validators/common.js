import { z } from "zod";

// Accepts "98765 43210", "98765-43210", "09876543210", "+91 98765 43210" and outputs "+919876543210".
const indianMobile = z
    .string()
    .transform((value) => value.replace(/[\s-]/g, "").replace(/^(\+91|0)/, ""))
    .pipe(
        z
            .string()
            .regex(/^[6-9]\d{9}$/, "Invalid Indian mobile number")
            .transform((digits) => `+91${digits}`)
    );

export { indianMobile };
