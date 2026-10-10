import mongoose, { Schema } from "mongoose";
import { BOOKING } from "../config/booking.js";
import { dateKeyField, expireAtField } from "./shared.js";

// One document per OCCUPIED slot. A free slot has no document.
// The unique { date, time } index is what makes double booking impossible.
const vmSlotSchema = new Schema({
    date: dateKeyField(),
    time: { type: String, required: true, enum: BOOKING.vm.slotTimes },
    state: { type: String, required: true, enum: ["booked", "blocked"] },
    bookingId: {
        type: String,
        trim: true,
        required: [function () { return this.state === "booked"; }, "bookingId is required for a booked slot"],
    },
    blockedBy: { type: String, trim: true },
    blockReason: { type: String, trim: true },
    blockedAt: { type: Date },
    expireAt: expireAtField(),
}, {
    strict: true,
    timestamps: true,
    collection: "vm_slots",
});

vmSlotSchema.index({ date: 1, time: 1 }, { unique: true });
vmSlotSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const VmSlot = mongoose.model("VmSlot", vmSlotSchema);
