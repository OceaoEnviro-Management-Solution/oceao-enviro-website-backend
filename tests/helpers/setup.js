import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { MongoMemoryServer } from "mongodb-memory-server";

// Test environment. Set before the app is imported so src/config/env.js validates these
// and nothing is ever read from a developer's .env (dotenv is not loaded here).
export const TEST_COMPANY_MAIL = "company@oceao.test";
// The fake Turnstile verifier accepts exactly this token; anything else fails.
export const TEST_CAPTCHA_TOKEN = "test-turnstile-token";
export const TEST_OTP_SECRET = "test-otp-secret-0123456789-abcdefghijklmnop";
export const TEST_BOOKING_TOKEN_SECRET = "test-booking-token-secret-0123456789-abcdefgh";
// Admin login. The hash uses bcrypt cost 4 so tests stay fast (production uses 12).
export const TEST_ADMIN_EMAIL = "admin@oceao.test";
export const TEST_ADMIN_PASSWORD = "correct horse battery staple";
export const TEST_ADMIN_PASSWORD_HASH = bcrypt.hashSync(TEST_ADMIN_PASSWORD, 4);
export const TEST_ADMIN_JWT_SECRET = "test-admin-jwt-secret-0123456789-abcdefghijk";
export const TEST_ORIGIN = "http://localhost:5173";
// For tests that spawn a child process with a hand-built environment.
export const TEST_ADMIN_ENV = {
    ADMIN_EMAIL: TEST_ADMIN_EMAIL,
    ADMIN_PASSWORD_HASH: TEST_ADMIN_PASSWORD_HASH,
    ADMIN_JWT_SECRET: TEST_ADMIN_JWT_SECRET,
};
const TEST_ENV = {
    NODE_ENV: "test",
    EMAIL_MODE: "test",
    CORS_ORIGINS: TEST_ORIGIN,
    MAIL_FROM: "Oceao Enviro <no-reply@oceao.test>",
    COMPANY_MAIL: TEST_COMPANY_MAIL,
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    DATA_GOV_API_KEY: "test-data-gov-api-key",
    CLOUDINARY_CLOUD_NAME: "test-cloud",
    CLOUDINARY_API_KEY: "test-cloudinary-key",
    CLOUDINARY_API_SECRET: "test-cloudinary-secret-0123456789",
    OTP_SECRET: TEST_OTP_SECRET,
    BOOKING_TOKEN_SECRET: TEST_BOOKING_TOKEN_SECRET,
    ...TEST_ADMIN_ENV,
    TRUST_PROXY: "0",
};

let mongod;
let app;
let outbox;
let rateLimitControl;

// Call once per test file, in `before`.
export const startTestEnv = async () => {
    Object.assign(process.env, TEST_ENV);

    mongod = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI, { dbName: "oe_test" });

    // Dynamic imports: they must run after the env above is in place.
    ({ app } = await import("../../src/app.js"));
    ({ outbox } = await import("../../src/services/email/email.transporter.js"));
    ({ rateLimitControl } = await import("../../src/middlewares/rateLimit.js"));

    // No test may reach Cloudflare: the verifier accepts only TEST_CAPTCHA_TOKEN.
    const { setTurnstileVerifier } = await import("../../src/services/turnstile.service.js");
    setTurnstileVerifier(async (token) => token === TEST_CAPTCHA_TOKEN);

    // Unique and TTL indexes must exist before any test relies on them.
    const { initModels } = await import("../../src/models/index.js");
    await initModels();

    return { app };
};

// Call once per test file, in `after`.
export const stopTestEnv = async () => {
    await mongoose.disconnect();
    if (mongod) await mongod.stop();
};

export const getApp = () => app;

// Call in `beforeEach`: empties every collection, the outbox and the rate limit counters,
// and switches rate limiting back off.
export const resetState = async () => {
    const collections = Object.values(mongoose.connection.collections);
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
    outbox.clear();
    rateLimitControl.reset();
    rateLimitControl.setEnabled(false);
};

export const emailOutbox = {
    all: () => [...outbox],
    clear: () => outbox.clear(),
    // target: "company" (to COMPANY_MAIL) | "customer" | "any"
    failNext: (target = "any") => outbox.failNext(target),
};

// Rate limiting is off by default in tests; a test opts in explicitly.
export const rateLimiting = {
    enable: () => rateLimitControl.setEnabled(true),
    disable: () => rateLimitControl.setEnabled(false),
};

// A valid 1x1 PNG and a minimal PDF, for upload tests.
export const PNG_BUFFER = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
);
export const PDF_BUFFER = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
