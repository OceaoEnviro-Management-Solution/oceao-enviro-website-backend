import { z } from "zod";

// Treat blank values (e.g. `FOO=` in .env) as unset.
const blankToUndefined = (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value;

const text = () => z.preprocess(blankToUndefined, z.string().trim());
const required = () => text().pipe(z.string().min(1));
const optional = () => z.preprocess(blankToUndefined, z.string().trim().optional());
const secret = () => z.preprocess(blankToUndefined, z.string().min(32, "must be at least 32 characters").optional());
const requiredSecret = () => z.preprocess(blankToUndefined, z.string().min(32, "must be at least 32 characters"));

const envSchema = z
    .object({
        NODE_ENV: z.preprocess(blankToUndefined, z.enum(["development", "test", "production"])),
        PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(8000)),
        MONGODB_URI: required().refine(
            (uri) => /^mongodb(\+srv)?:\/\//.test(uri),
            "must start with mongodb:// or mongodb+srv://"
        ),
        CORS_ORIGINS: required().transform((value) =>
            value.split(",").map((origin) => origin.trim()).filter(Boolean)
        ).pipe(z.array(z.string()).min(1, "must list at least one origin")),
        TRUST_PROXY: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(0)),

        EMAIL_MODE: z.preprocess(blankToUndefined, z.enum(["log", "smtp", "test"]).default("log")),
        MAIL_FROM: required(),
        COMPANY_MAIL: required(),

        // Required only when EMAIL_MODE=smtp (checked below)
        SMTP_HOST: optional(),
        SMTP_PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).optional()),
        SMTP_SECURE: z.preprocess(
            (value) => (typeof blankToUndefined(value) === "string" ? value.trim().toLowerCase() : undefined),
            z.enum(["true", "false"]).optional()
        ).transform((value) => (value === undefined ? undefined : value === "true")),
        SMTP_USER: optional(),
        SMTP_PASSWORD: optional(),

        // Virtual meeting OTP and booking token signing (each at least 32 characters)
        OTP_SECRET: requiredSecret(),
        BOOKING_TOKEN_SECRET: requiredSecret(),

        // Optional until the stage that uses them
        GOOGLE_CLIENT_ID: optional(),
        GOOGLE_CLIENT_SECRET: optional(),
        GOOGLE_REFRESH_TOKEN: optional(),
        GOOGLE_CALENDAR_ID: z.preprocess(blankToUndefined, z.string().trim().default("primary")),
        TURNSTILE_SECRET_KEY: optional(),
        ADMIN_EMAIL: optional(),
        ADMIN_PASSWORD_HASH: optional(),
        ADMIN_JWT_SECRET: secret(),
    })
    .superRefine((env, ctx) => {
        if (env.EMAIL_MODE !== "smtp") return;
        for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD"]) {
            if (env[key] === undefined) {
                ctx.addIssue({
                    code: "custom",
                    path: [key],
                    message: "is required when EMAIL_MODE=smtp",
                });
            }
        }
    });

const loadConfig = () => {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
        // Print variable names and reasons only, never values.
        const lines = result.error.issues.map((issue) => {
            const name = issue.path.join(".") || "(env)";
            const raw = process.env[name];
            const missing = raw === undefined || raw.trim() === "";
            return `  - ${name}: ${missing ? "is missing" : issue.message}`;
        });
        console.error(`Invalid environment configuration:\n${lines.join("\n")}`);
        process.exit(1);
    }
    return Object.freeze({
        ...result.data,
        CORS_ORIGINS: Object.freeze(result.data.CORS_ORIGINS),
    });
};

const config = loadConfig();

export { config };
