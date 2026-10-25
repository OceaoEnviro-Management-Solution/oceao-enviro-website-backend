import mongoose, { Schema } from "mongoose";
import { isValidDateKey, nowIST } from "../utils/time.js";

const DUPLICATE_KEY = 11000;
const MAX_ATTEMPTS = 3;

export const JOB_STAT_FIELDS = Object.freeze(["views", "applications"]);

const count = {
    type: Number,
    required: true,
    default: 0,
    min: 0,
    validate: { validator: Number.isInteger, message: "{PATH} must be a whole number" },
};

// Per job, per IST day: page views and applications. Changed only with atomic $inc updates
// (incrementJobStat below), the same way as the visitor counter. Nothing is seeded: a day with no
// views or applications has no document.
const jobStatSchema = new Schema({
    jobId: { type: Schema.Types.ObjectId, ref: "Job", required: true },
    date: {
        type: String,
        required: true,
        trim: true,
        validate: { validator: isValidDateKey, message: "{PATH} must be a valid YYYY-MM-DD date" },
    },
    views: count,
    applications: count,
}, {
    strict: true,
    timestamps: true,
    collection: "job_stats",
});

jobStatSchema.index({ jobId: 1, date: 1 }, { unique: true });

export const JobStat = mongoose.model("JobStat", jobStatSchema);

/**
 * Adds 1 to today's (IST) `field` ("views" or "applications") of a job: one updateOne with $inc
 * and upsert. When the first counts of a day arrive in parallel, two upserts can both try to insert
 * the document: the unique index lets one win and the other is retried as a plain increment.
 */
export const incrementJobStat = async (jobId, field, now = new Date()) => {
    if (!JOB_STAT_FIELDS.includes(field)) throw new RangeError(`Unknown job stat field: ${field}`);
    const filter = { jobId, date: nowIST(now).dateKey };

    for (let attempt = 1; ; attempt++) {
        try {
            await JobStat.updateOne(filter, { $inc: { [field]: 1 } }, { upsert: true });
            return;
        } catch (error) {
            if (error?.code !== DUPLICATE_KEY || attempt >= MAX_ATTEMPTS) throw error;
        }
    }
};
