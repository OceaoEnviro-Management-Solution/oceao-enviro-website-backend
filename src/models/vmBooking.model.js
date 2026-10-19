import mongoose, { Schema } from "mongoose";
import { BOOKING } from "../config/booking.js";
import { BOOKING_ID_PATTERN } from "../utils/ids.js";
import { dateKeyField, emailField, mobileNumberField, expireAtField } from "./shared.js";

// "Completed" is derived (the date and time have passed) and is never stored.
const vmBookingSchema = new Schema({
    bookingId: {
        type: String,
        required: true,
        trim: true,
        match: [BOOKING_ID_PATTERN, "bookingId must look like OE-VM-YYMMDD-XXXX"],
    },
    date: dateKeyField(),
    time: { type: String, required: true, enum: BOOKING.vm.slotTimes },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    email: emailField(),
    mobileNumber: mobileNumberField(),
    organisation: { type: String, trim: true, maxlength: 150 },
    designation: { type: String, trim: true, maxlength: 100 },
    topic: { type: String, trim: true, maxlength: 500 },
    status: { type: String, required: true, enum: ["confirmed", "cancelled"], default: "confirmed" },
    meetStatus: { type: String, required: true, enum: ["pending", "created", "failed"], default: "pending" },
    meetLink: { type: String, trim: true, default: null },
    googleEventId: { type: String, trim: true, default: null },
    cancelledBy: { type: String, trim: true },
    cancelReason: { type: String, trim: true },
    cancelledAt: { type: Date },
    expireAt: expireAtField(),
}, {
    strict: true,
    timestamps: true,
    collection: "vm_bookings",
});

vmBookingSchema.index({ bookingId: 1 }, { unique: true });
vmBookingSchema.index({ email: 1, status: 1, date: 1 });
vmBookingSchema.index({ date: 1, time: 1 });
vmBookingSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const VmBooking = mongoose.model("VmBooking", vmBookingSchema);
