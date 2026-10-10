import mongoose, { Schema } from "mongoose";
import { isValidDateKey } from "../utils/time.js";

// A festival or company holiday. Closes the date for both VM and callbacks.
// Sundays and second Saturdays are closed by rule and are never stored here.
const holidaySchema = new Schema({
    date: {
        type: String,                 // "YYYY-MM-DD" (IST)
        required: true,
        unique: true,
        trim: true,
        validate: {
            validator: isValidDateKey,
            message: "date must be a valid YYYY-MM-DD date",
        },
    },
    name: {
        type: String,
        required: true,
        trim: true,
        minlength: 2,
        maxlength: 100,
    },
}, {
    strict: true,
    timestamps: true,
});

export const Holiday = mongoose.model("Holiday", holidaySchema);
