// Visitor counter. recordVisit() adds one visit to the total and to today's IST day, with one
// atomic $inc each (no read-modify-write, so parallel visits never lose a count). Nothing is
// seeded: the counters start at 0 and the first visit creates their documents.

import { VisitStat } from "../models/visitStat.model.js";
import { addDays, nowIST } from "../utils/time.js";

export const DEFAULT_DAILY_DAYS = 30;
export const MAX_DAILY_DAYS = 90;

const DUPLICATE_KEY = 11000;
const MAX_ATTEMPTS = 3;

// Callers that are not people: crawlers, link previews, headless browsers. A missing
// User-Agent is treated the same way.
const NOT_A_VISITOR = /bot|crawl|spider|slurp|preview|headless/i;

/** True when this User-Agent should be counted as a visitor. */
export const isCountableUserAgent = (userAgent) =>
    typeof userAgent === "string" && userAgent.trim() !== "" && !NOT_A_VISITOR.test(userAgent);

// $inc with upsert. When the very first visits arrive in parallel, two upserts can both try to
// insert the same document: the unique index lets one win and the other gets a duplicate key
// error, which is retried as a plain increment of the document that now exists.
const increment = async (filter) => {
    for (let attempt = 1; ; attempt++) {
        try {
            await VisitStat.updateOne(filter, { $inc: { count: 1 } }, { upsert: true });
            return;
        } catch (error) {
            if (error?.code !== DUPLICATE_KEY || attempt >= MAX_ATTEMPTS) throw error;
        }
    }
};

/** Counts one visit: the total document and today's day document (IST). */
export const recordVisit = async ({ now = new Date() } = {}) => {
    await increment({ key: "total" });
    await increment({ key: "day", date: nowIST(now).dateKey });
};

/** Every visit counted so far (0 before the first). */
export const getTotal = async () => {
    const total = await VisitStat.findOne({ key: "total" }).select({ count: 1, _id: 0 }).lean();
    return total?.count ?? 0;
};

/**
 * The last `days` IST days, today included, oldest first, one entry per date
 * (count 0 for a day nobody visited).
 * @returns {Promise<Array<{ date: string, count: number }>>}
 */
export const getDaily = async (days = DEFAULT_DAILY_DAYS, { now = new Date() } = {}) => {
    const today = nowIST(now).dateKey;
    const from = addDays(today, -(days - 1));

    const stored = await VisitStat.find({ key: "day", date: { $gte: from, $lte: today } })
        .select({ date: 1, count: 1, _id: 0 })
        .lean();
    const byDate = new Map(stored.map((entry) => [entry.date, entry.count]));

    return Array.from({ length: days }, (_, index) => {
        const date = addDays(from, index);
        return { date, count: byDate.get(date) ?? 0 };
    });
};
