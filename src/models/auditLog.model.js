import mongoose, { Schema } from "mongoose";
import { isValidDateKey } from "../utils/time.js";
import { expireAtField } from "./shared.js";

// What an audit entry is about. Add a value here when a stage starts auditing a new kind of target.
export const AUDIT_TARGET_TYPES = Object.freeze([
    "vm_booking",
    "vm_slot",
    "callback_request",
    "callback_bucket",
    "holiday",
    "settings",
]);

// One entry per admin write (AGENT_CONTEXT.md section 12). Entries are kept 180 days and then
// removed by the TTL index. `detail` is free-form but never holds customer contact details,
// passwords or tokens.
const auditLogSchema = new Schema({
    action: { type: String, required: true, trim: true, maxlength: 60 },          // e.g. "vm.block"
    targetType: { type: String, required: true, enum: AUDIT_TARGET_TYPES },
    targetId: { type: String, required: true, trim: true, maxlength: 100 },       // bookingId, requestId, a date ...
    date: {
        type: String,
        trim: true,
        validate: { validator: isValidDateKey, message: "date must be a valid YYYY-MM-DD date" },
    },
    detail: { type: Schema.Types.Mixed },
    performedBy: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
    reason: { type: String, trim: true, minlength: 3, maxlength: 300 },
    expireAt: expireAtField(),
}, {
    strict: true,
    timestamps: true,
    collection: "audit_logs",
});

auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
