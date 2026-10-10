import mongoose, { Schema } from "mongoose";
import { BOOKING } from "../config/booking.js";
import { REQUEST_ID_PATTERN } from "../utils/ids.js";
import { dateKeyField, emailField, mobileNumberField, expireAtField } from "./shared.js";

const callbackRequestSchema = new Schema({
    requestId: {
        type: String,
        required: true,
        trim: true,
        match: [REQUEST_ID_PATTERN, "requestId must look like OE-CB-YYMMDD-XXXX"],
    },
    date: dateKeyField(),
    period: { type: String, required: true, enum: BOOKING.callback.periodOrder },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    email: emailField(),
    mobileNumber: mobileNumberField(),
    reason: { type: String, trim: true, maxlength: 500 },
    status: {
        type: String,
        required: true,
        enum: ["pending", "completed", "no_answer", "cancelled"],
        default: "pending",
    },
    statusUpdatedBy: { type: String, trim: true },
    cancelledBy: { type: String, trim: true },
    cancelReason: { type: String, trim: true },
    cancelledAt: { type: Date },
    expireAt: expireAtField(),
}, {
    strict: true,
    timestamps: true,
    collection: "callback_requests",
});

callbackRequestSchema.index({ requestId: 1 }, { unique: true });
callbackRequestSchema.index({ date: 1, period: 1 });
callbackRequestSchema.index({ email: 1, date: 1, status: 1 });
callbackRequestSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const CallbackRequest = mongoose.model("CallbackRequest", callbackRequestSchema);
