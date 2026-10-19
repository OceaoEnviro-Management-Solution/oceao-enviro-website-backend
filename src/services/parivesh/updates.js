// What the website shows of the synced PARIVESH items: published ones only, newest order date first
// (the date each item is shown with), so the list reads in date order from top to bottom.
// The stored document is turned into the public item here, so nothing else (no documentPath, no
// firstSeenAt) can leak out of the API.

import { PARIVESH } from "../../config/parivesh.js";
import { PariveshUpdate } from "../../models/pariveshUpdate.model.js";
import { nowIST } from "../../utils/time.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Newest order date first; items without one come last. Same date: the later upload first, then the
// higher id, so the order is the same every time and a page never repeats or skips an item.
const NEWEST_FIRST = { orderDate: -1, uploadedOn: -1, pariveshId: -1 };

/** @returns {{ id: number, title: string, category: string, date: string|null, sizeLabel: string|null, pdfUrl: string, isNew: boolean }} */
export const toPublicItem = (document, now = new Date()) => ({
    id: document.pariveshId,
    title: document.title,
    category: document.category,
    date: document.orderDate ? nowIST(document.orderDate).dateKey : null,
    sizeLabel: document.sizeLabel ?? null,
    pdfUrl: document.pdfUrl,
    isNew: now.getTime() - document.uploadedOn.getTime() <= PARIVESH.newWithinDays * MS_PER_DAY,
});

/** The 5 newest published items. */
export const getLatestUpdates = async ({ now = new Date() } = {}) => {
    const documents = await PariveshUpdate.find({ published: true })
        .sort(NEWEST_FIRST)
        .limit(PARIVESH.latestCount)
        .lean();

    return documents.map((document) => toPublicItem(document, now));
};

/** One page (1-based) of published items, 10 per page. A page past the end has no items. */
export const getUpdatesPage = async (page, { now = new Date() } = {}) => {
    const { pageSize } = PARIVESH;
    const [documents, total] = await Promise.all([
        PariveshUpdate.find({ published: true })
            .sort(NEWEST_FIRST)
            .skip((page - 1) * pageSize)
            .limit(pageSize)
            .lean(),
        PariveshUpdate.countDocuments({ published: true }),
    ]);

    return {
        items: documents.map((document) => toPublicItem(document, now)),
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
    };
};
