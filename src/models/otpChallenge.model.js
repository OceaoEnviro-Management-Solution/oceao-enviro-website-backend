import mongoose, { Schema } from "mongoose";
import { emailField, expireAtField } from "./shared.js";

// One active OTP challenge per email. Only a hash of the code is stored.
// expireAt = windowStartedAt + 1 hour, so the whole send-count window disappears with it.
const otpChallengeSchema = new Schema({
    email: emailField(),
    codeHash: { type: String, required: true },
    codeExpiresAt: { type: Date, required: true },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    sendCount: { type: Number, required: true, default: 1, min: 0 },
    windowStartedAt: { type: Date, required: true },
    lastSentAt: { type: Date, required: true },
    expireAt: expireAtField(),
}, {
    strict: true,
    timestamps: true,
    collection: "otp_challenges",
});

otpChallengeSchema.index({ email: 1 }, { unique: true });
otpChallengeSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const OtpChallenge = mongoose.model("OtpChallenge", otpChallengeSchema);
