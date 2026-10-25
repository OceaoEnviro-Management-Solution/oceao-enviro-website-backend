// Retention of job applications (India's DPDP Act 2023: personal data only as long as needed).
// An application older than CAREERS_RETENTION_DAYS (default 365) is deleted with its resume:
// the database rows first, then each resume on Cloudinary (a failed resume delete is only logged by
// deleteResume, so a Cloudinary problem never keeps personal data in the database).
// Runs every day at 03:30 IST and at start-up (the background jobs in src/jobs); by hand: npm run careers:cleanup

import { config } from "../../config/env.js";
import { JobApplication } from "../../models/jobApplication.model.js";
import { logger } from "../../utils/logger.js";
import { deleteResume } from "../cloudinary.service.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 500;

/**
 * Deletes every application made before `now` minus `retentionDays` days, and its resume.
 * @returns {Promise<{ removed: number, cutoff: Date }>}
 */
export const cleanupOldApplications = async ({ now = new Date(), retentionDays = config.CAREERS_RETENTION_DAYS } = {}) => {
    const cutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY);
    let removed = 0;

    for (;;) {
        const batch = await JobApplication.find({ createdAt: { $lt: cutoff } })
            .select({ _id: 1, "resume.publicId": 1 })
            .limit(BATCH_SIZE)
            .lean();
        if (batch.length === 0) break;

        const { deletedCount } = await JobApplication.deleteMany({ _id: { $in: batch.map((row) => row._id) } });
        removed += deletedCount;
        for (const row of batch) await deleteResume(row.resume?.publicId);

        if (batch.length < BATCH_SIZE) break;
    }

    logger.info(`Careers retention: ${removed} application(s) older than ${retentionDays} days removed`);
    return { removed, cutoff };
};
