import mongoose, { Schema } from "mongoose";
import { BOOKING } from "../config/booking.js";
import { dateKeyField, expireAtField } from "./shared.js";

// One document per (date, period) that has any booking or block. `booked` is a counter
// that is only changed with atomic $inc updates guarded by the period capacity.
const callbackBucketSchema = new Schema({
    date: dateKeyField(),
    period: { type: String, required: true, enum: BOOKING.callback.periodOrder },
    booked: {
        type: Number,
        required: true,
        default: 0,
        min: 0,
        validate: { validator: Number.isInteger, message: "{PATH} must be a whole number" },
    },
    blocked: { type: Boolean, required: true, default: false },
    blockedBy: { type: String, trim: true },
    blockReason: { type: String, trim: true },
    blockedAt: { type: Date },
    expireAt: expireAtField(),
}, {
    strict: true,
    timestamps: true,
    collection: "callback_buckets",
});

callbackBucketSchema.index({ date: 1, period: 1 }, { unique: true });
callbackBucketSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const CallbackBucket = mongoose.model("CallbackBucket", callbackBucketSchema);
