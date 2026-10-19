import mongoose, { Schema } from "mongoose";
import { isValidDateKey } from "../utils/time.js";

// Visit counters, changed only with atomic $inc updates (services/visits.service.js).
//   { key: "total" }                    one document: every visit ever counted
//   { key: "day", date: "YYYY-MM-DD" }  one document per IST day
// The total starts at 0: nothing is seeded, the first visit creates the documents.
// The unique { key, date } index makes a second "total" (no date) or a second document for the
// same day impossible, even when the first visits arrive in parallel.
const visitStatSchema = new Schema({
    key: { type: String, required: true, enum: ["total", "day"] },
    date: {
        type: String,
        trim: true,
        required: [function () { return this.key === "day"; }, "date is required for a day document"],
        validate: {
            validator: (value) => value === undefined || isValidDateKey(value),
            message: "{PATH} must be a valid YYYY-MM-DD date",
        },
    },
    count: {
        type: Number,
        required: true,
        default: 0,
        min: 0,
        validate: { validator: Number.isInteger, message: "{PATH} must be a whole number" },
    },
}, {
    strict: true,
    timestamps: true,
    collection: "visit_stats",
});

visitStatSchema.index({ key: 1, date: 1 }, { unique: true });

export const VisitStat = mongoose.model("VisitStat", visitStatSchema);
