import mongoose, { Schema } from "mongoose";

export const PARIVESH_SYNC_KEY = "parivesh";

// How the last syncs of an outside source went: one document per source, { key: "parivesh" } for
// PARIVESH (services/parivesh/sync.js). A failed attempt changes lastAttemptAt and lastError only;
// the counts are those of the last successful sync.
const syncStatusSchema = new Schema({
    key: { type: String, required: true, enum: [PARIVESH_SYNC_KEY], immutable: true },
    lastSuccessAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    itemsReceived: { type: Number, default: null, min: 0 },
    itemsSkipped: { type: Number, default: null, min: 0 },
}, {
    strict: true,
    timestamps: false,
    collection: "sync_status",
});

syncStatusSchema.index({ key: 1 }, { unique: true });

export const SyncStatus = mongoose.model("SyncStatus", syncStatusSchema);
