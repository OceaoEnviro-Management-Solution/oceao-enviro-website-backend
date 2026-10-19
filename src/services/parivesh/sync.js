// Copies PARIVESH "What's New" into MongoDB (parivesh_updates).
//
//   syncParivesh()   fetch (20 s limit) -> validate -> one bulkWrite of upserts keyed by pariveshId
//   isSyncDue()      true when the last successful sync is older than 6 hours (or there is none)
//   getSyncStatus()  how the last syncs went (GET /admin/updates/sync-status)
//
// All or nothing: when the request fails, the answer is not a list, or no item is usable, nothing
// is written except the status (lastAttemptAt, lastError). Items are never deleted: one that
// leaves the source stays stored, and one the source marks unpublished is stored but hidden.
// A single bad item is skipped and counted, it does not stop the others.

import { z } from "zod";
import { PARIVESH } from "../../config/parivesh.js";
import { PariveshUpdate } from "../../models/pariveshUpdate.model.js";
import { PARIVESH_SYNC_KEY, SyncStatus } from "../../models/syncStatus.model.js";
import { logger } from "../../utils/logger.js";

const MS_PER_HOUR = 60 * 60 * 1000;
const MAX_ERROR_LENGTH = 300;

// What the source sends for one item. Other fields are ignored. A date that cannot be read
// makes the item unusable (uploadedOn) or just missing (orderDate).
const readDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const sourceItemSchema = z.object({
    id: z.number().int().positive(),
    fileName: z.string().trim().min(1),
    documentPath: z.string().trim().min(1),
    uploadedOn: z.string().refine((value) => readDate(value) !== null, "not a date"),
    documentTitle: z.string().nullish(),
    orderDate: z.string().nullish(),
    documentSize: z.string().nullish(),
    // Not saying it is published means it is not shown.
    published: z.boolean().catch(false),
});

/** "Order- Reconstitution of EAC.pdf" -> "Order- Reconstitution of EAC" */
export const titleFromFileName = (fileName) => fileName.replace(/\.pdf$/i, "").trim();

/**
 * The public link of a document, or null when it is not one we can link to.
 * Only the part of documentPath from "/publicdocument/" on is used, each piece URL-encoded
 * (file names have spaces, brackets and ampersands). The host is always PARIVESH's own.
 */
export const buildPdfUrl = (documentPath) => {
    if (typeof documentPath !== "string") return null;

    const start = documentPath.indexOf(PARIVESH.documentMarker);
    if (start === -1) return null;

    const pieces = documentPath.slice(start + 1).split("/");   // "publicdocument", "UPLOAD...", "file name.pdf"
    if (pieces.some((piece) => piece === "" || piece === "." || piece === "..")) return null;

    return `${PARIVESH.siteOrigin}/${pieces.map(encodeURIComponent).join("/")}`;
};

/**
 * One source item -> the fields to store, or null (with the reason) when it cannot be used.
 * @returns {{ ok: true, fields: object } | { ok: false, reason: "invalid" | "no_public_document" }}
 */
const toFields = (raw) => {
    const parsed = sourceItemSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: "invalid" };

    const item = parsed.data;
    const title = titleFromFileName(item.fileName);
    if (title === "") return { ok: false, reason: "invalid" };

    const pdfUrl = buildPdfUrl(item.documentPath);
    if (!pdfUrl) return { ok: false, reason: "no_public_document" };

    return {
        ok: true,
        fields: {
            pariveshId: item.id,
            title,
            category: (item.documentTitle ?? "").replace(/\s+/g, " ").trim(),
            orderDate: item.orderDate ? readDate(item.orderDate) : null,
            uploadedOn: readDate(item.uploadedOn),
            sizeLabel: item.documentSize?.trim() || null,
            pdfUrl,
            published: item.published,
        },
    };
};

// ── Status document ──────────────────────────────────────────────────────────

const writeStatus = async (changes) => {
    try {
        await SyncStatus.updateOne({ key: PARIVESH_SYNC_KEY }, { $set: changes }, { upsert: true });
    } catch (error) {
        logger.error("PARIVESH sync status could not be saved", error);
    }
};

/** @returns {Promise<{ lastSuccessAt: Date|null, lastAttemptAt: Date|null, lastError: string|null, itemsReceived: number|null, itemsSkipped: number|null }>} */
export const getSyncStatus = async () => {
    const status = await SyncStatus.findOne({ key: PARIVESH_SYNC_KEY }).lean();

    return {
        lastSuccessAt: status?.lastSuccessAt ?? null,
        lastAttemptAt: status?.lastAttemptAt ?? null,
        lastError: status?.lastError ?? null,
        itemsReceived: status?.itemsReceived ?? null,
        itemsSkipped: status?.itemsSkipped ?? null,
    };
};

/** True when no sync has ever succeeded, or the last one is more than 6 hours old. */
export const isSyncDue = async ({ now = new Date() } = {}) => {
    const { lastSuccessAt } = await getSyncStatus();
    return !lastSuccessAt || now.getTime() - lastSuccessAt.getTime() > PARIVESH.syncEveryHours * MS_PER_HOUR;
};

// ── Reading the source ───────────────────────────────────────────────────────

const FAILURES = Object.freeze({
    timeout: `PARIVESH did not answer within ${PARIVESH.timeoutMs / 1000} seconds`,
    network: "PARIVESH could not be reached",
    bad_response: "PARIVESH sent an answer that is not a list of updates",
    no_valid_items: "PARIVESH sent no usable updates",
    store_failed: "The updates could not be saved to the database",
});

// The test hook: tests replace the network call (like the Turnstile verifier). null restores it.
let defaultFetch = null;
export const setPariveshFetch = (fn) => {
    defaultFetch = fn ?? null;
};

const fetchSourceItems = async (fetchImpl) => {
    let response;
    try {
        response = await fetchImpl(PARIVESH.sourceUrl, { signal: AbortSignal.timeout(PARIVESH.timeoutMs) });
    } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        return { ok: false, reason: timedOut ? "timeout" : "network" };
    }

    if (!response.ok) return { ok: false, reason: `http_${response.status}` };

    let body;
    try {
        body = await response.json();
    } catch {
        return { ok: false, reason: "bad_response" };
    }

    return Array.isArray(body) ? { ok: true, items: body } : { ok: false, reason: "bad_response" };
};

const describe = (reason) => FAILURES[reason] ?? (reason.startsWith("http_") ? `PARIVESH answered with status ${reason.slice(5)}` : reason);

// ── The sync ─────────────────────────────────────────────────────────────────

const runSync = async ({ fetchImpl, now }) => {
    await writeStatus({ lastAttemptAt: now });

    const fail = async (reason) => {
        const message = describe(reason);
        logger.warn("PARIVESH sync failed", { reason });
        await writeStatus({ lastError: message.slice(0, MAX_ERROR_LENGTH) });
        return { ok: false, reason, message };
    };

    const source = await fetchSourceItems(fetchImpl);
    if (!source.ok) return fail(source.reason);

    const operations = [];
    let invalid = 0;
    let noPublicDocument = 0;

    for (const raw of source.items) {
        const result = toFields(raw);
        if (!result.ok) {
            if (result.reason === "invalid") invalid++;
            else noPublicDocument++;
            continue;
        }

        const { pariveshId, ...fields } = result.fields;
        operations.push({
            updateOne: {
                filter: { pariveshId },
                update: { $set: fields, $setOnInsert: { firstSeenAt: now } },
                upsert: true,
            },
        });
    }

    if (operations.length === 0) return fail("no_valid_items");

    let written;
    try {
        written = await PariveshUpdate.bulkWrite(operations, { ordered: false });
    } catch (error) {
        logger.error("PARIVESH updates could not be saved", error);
        return fail("store_failed");
    }

    const received = source.items.length;
    const skipped = invalid + noPublicDocument;
    await writeStatus({ lastSuccessAt: now, lastError: null, itemsReceived: received, itemsSkipped: skipped });

    const outcome = {
        ok: true,
        received,
        saved: operations.length,
        inserted: written.upsertedCount ?? 0,
        updated: written.modifiedCount ?? 0,
        skipped,
        skippedInvalid: invalid,
        skippedNoPublicDocument: noPublicDocument,
    };
    logger.info(`PARIVESH synced: ${outcome.saved} saved (${outcome.inserted} new, ${outcome.updated} changed), ${skipped} skipped`);
    return outcome;
};

let running = null;

/**
 * Runs one sync. Never throws. A call made while a sync is running gets that sync's result.
 * @returns {Promise<{ ok: true, received: number, saved: number, inserted: number, updated: number, skipped: number,
 *                     skippedInvalid: number, skippedNoPublicDocument: number } | { ok: false, reason: string, message: string }>}
 */
export const syncParivesh = ({ fetchImpl = defaultFetch ?? fetch, now = new Date() } = {}) => {
    if (!running) {
        running = runSync({ fetchImpl, now })
            .catch((error) => {
                logger.error("PARIVESH sync crashed", error);
                return { ok: false, reason: "store_failed", message: FAILURES.store_failed };
            })
            .finally(() => { running = null; });
    }
    return running;
};
