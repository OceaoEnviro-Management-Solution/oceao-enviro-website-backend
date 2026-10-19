import mongoose, { Schema } from "mongoose";
import { BOOKING } from "../config/booking.js";
import { isValidDateKey } from "../utils/time.js";

export const SETTINGS_KEY = "main";

// Admin-editable callback capacity per period: whole numbers from 0 to 50.
export const CAPACITY_LIMITS = Object.freeze({ min: 0, max: 50 });

const capacityField = {
    type: Number,
    required: true,
    min: CAPACITY_LIMITS.min,
    max: CAPACITY_LIMITS.max,
    validate: {
        validator: Number.isInteger,
        message: "{PATH} must be a whole number",
    },
};

const callbackCapacity = Object.fromEntries(
    BOOKING.callback.periodOrder.map((period) => [period, capacityField])
);

// One document only: { key: "main", callbackCapacity: { morning, afternoon, evening }, heroSwitchDate }.
// A missing document means "use the defaults from config/booking.js" and no hero switch planned.
// heroSwitchDate: the IST day (YYYY-MM-DD) on which the scheduled hero slides replace the live ones,
// or null (services/hero.service.js clears it when the switch happens).
const settingsSchema = new Schema({
    key: {
        type: String,
        required: true,
        unique: true,
        default: SETTINGS_KEY,
        enum: [SETTINGS_KEY],
        immutable: true,
    },
    callbackCapacity,
    heroSwitchDate: {
        type: String,
        default: null,
        validate: {
            validator: (value) => value === null || isValidDateKey(value),
            message: "{PATH} must be null or a valid YYYY-MM-DD date",
        },
    },
}, {
    strict: true,
    timestamps: true,
});

export const Settings = mongoose.model("Settings", settingsSchema);
