// Upserts every { date, name } from data/holidays.json into the holidays collection.
// Safe to run repeatedly: existing dates are updated, nothing is removed.
//
//   npm run seed:holidays

import "dotenv/config";

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import connectDB, { disconnectDB } from "../src/db/index.js";
import { Holiday } from "../src/models/holiday.model.js";
import { isClosedByRule } from "../src/services/calendar.service.js";
import { isValidDateKey } from "../src/utils/time.js";
import { logger } from "../src/utils/logger.js";

const DATA_FILE = new URL("../data/holidays.json", import.meta.url);
const NAME_MAX_LENGTH = 100;

/**
 * Validates and upserts holidays. Nothing is written if any entry is invalid.
 * Needs an open mongoose connection.
 * @param {Array<{ date: string, name: string }>} entries
 * @returns {Promise<{ upserted: number, skipped: Array<{ date: string, reason: string }> }>}
 */
export const seedHolidays = async (entries) => {
    if (!Array.isArray(entries)) {
        throw new Error("holidays data must be a JSON array of { date, name }");
    }

    const problems = [];
    entries.forEach((entry, index) => {
        const name = typeof entry?.name === "string" ? entry.name.trim() : "";
        if (!isValidDateKey(entry?.date)) {
            problems.push(`entry ${index}: date must be a valid YYYY-MM-DD date`);
        }
        if (name.length < 2 || name.length > NAME_MAX_LENGTH) {
            problems.push(`entry ${index}: name must be 2-${NAME_MAX_LENGTH} characters`);
        }
    });
    if (problems.length > 0) {
        throw new Error(`Invalid holidays data:\n  - ${problems.join("\n  - ")}`);
    }

    // Sundays and second Saturdays are already closed by rule; never store them.
    const skipped = [];
    const byDate = new Map();
    for (const { date, name } of entries) {
        if (isClosedByRule(date)) {
            skipped.push({ date, reason: "closed_by_rule" });
        } else {
            byDate.set(date, name.trim());   // a repeated date: the last one wins
        }
    }

    if (byDate.size > 0) {
        await Holiday.bulkWrite(
            [...byDate].map(([date, name]) => ({
                updateOne: { filter: { date }, update: { $set: { name } }, upsert: true },
            }))
        );
    }

    return { upserted: byDate.size, skipped };
};

const main = async () => {
    const entries = JSON.parse(await readFile(DATA_FILE, "utf8"));

    await connectDB();
    try {
        const { upserted, skipped } = await seedHolidays(entries);
        logger.info(`Holidays seeded: ${upserted} upserted, ${skipped.length} skipped`);
        skipped.forEach(({ date, reason }) => logger.warn(`Skipped ${date}: ${reason}`));
    } finally {
        await disconnectDB();
    }
};

// Run only when executed directly (importing seedHolidays in tests must not connect).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        logger.error("Seeding holidays failed", error.message);
        process.exit(1);
    });
}
