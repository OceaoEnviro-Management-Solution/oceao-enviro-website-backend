import mongoose, { Schema } from "mongoose";

const slotSchema = new Schema({
    type: {
        type: String,
        enum: ["vm", "cb"],
        required: true
    },
    meetingDate: {
        type: String, // Stored consistently as "YYYY-MM-DD", e.g., "2026-09-04"
        required: true
    },
    timeSlot: {
        type: String,
        // Applying the enum validator you used earlier to lock in specific slots
        enum: ["11:00", "12:00", "14:00", "16:00"],
        required: true
    },
    status: {
        type: String,
        enum: ["booked", "available", "blocked"],
        default: "available"
    }
},
    {
        timestamps: true
    })

slotSchema.index(
    {
        type: 1,
        meetingDate: 1,
        timeSlot: 1
    },
    {
        unique: true
    });

export const Slot = mongoose.model("Slot", slotSchema)