import mongoose, { Schema } from "mongoose";
import { AQI_CATEGORIES, AQI_POLLUTANTS } from "../config/aqi.js";

// The latest AQI of each station: one document per station, replaced in place by every hourly
// run (services/aqi/readings.js). The unique station index keeps it to one.
//   aqi, category, dominantPollutant   null when the source gave too little to work out an AQI
//   sourceLastUpdate                   when CPCB measured it (the source's last_update)
//   fetchedAt                          when this server stored it
const aqiReadingSchema = new Schema({
    city: { type: String, required: true, trim: true },
    station: { type: String, required: true, trim: true },
    aqi: {
        type: Number,
        default: null,
        min: 0,
        max: 500,
        validate: { validator: (value) => value === null || Number.isInteger(value), message: "{PATH} must be a whole number" },
    },
    category: { type: String, default: null, enum: [...AQI_CATEGORIES.map((category) => category.name), null] },
    dominantPollutant: { type: String, default: null, enum: [...AQI_POLLUTANTS, null] },
    sourceLastUpdate: { type: Date, default: null },
    fetchedAt: { type: Date, required: true },
}, {
    strict: true,
    timestamps: false,
    collection: "aqi_readings",
});

aqiReadingSchema.index({ station: 1 }, { unique: true });

export const AqiReading = mongoose.model("AqiReading", aqiReadingSchema);
