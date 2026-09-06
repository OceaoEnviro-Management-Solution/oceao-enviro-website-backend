import mongoose, { Schema } from "mongoose";

const vmBookingSchema = new Schema({
    bookingId: {
        type: String,
        required: true,
        unique: true
    },
    slot: {
        type: Schema.Types.ObjectId,
        ref: "Slot",
        required: true
    },
    client: {
        type: Schema.Types.ObjectId,
        ref: "Client",
        required: true
    },
    meetingStatus: {
        type: String,
        enum: ["confirmed", "completed", "cancelled"],
        default: "confirmed"
    },

}, {
    timestamps: true
})

export const VmBooking = mongoose.model("VmBooking", vmBookingSchema)