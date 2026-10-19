// PARIVESH What's New: syncing, the public endpoints, the admin endpoints and the job schedule.
// Nothing here touches the network: every fetch is a fake.

import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
import {
    startTestEnv, stopTestEnv, resetState, getApp, rateLimiting,
    TEST_ORIGIN, TEST_ADMIN_PASSWORD_HASH, TEST_ADMIN_JWT_SECRET,
} from "./helpers/setup.js";

const DAY = 24 * 60 * 60 * 1000;

let syncParivesh;
let isSyncDue;
let getSyncStatus;
let buildPdfUrl;
let titleFromFileName;
let setPariveshFetch;
let getUpdatesPage;
let getLatestUpdates;
let toPublicItem;
let startJobs;
let PariveshUpdate;
let SyncStatus;
let PARIVESH;

// ── Fakes ────────────────────────────────────────────────────────────────────

const PATH_ROOT = "/opt/apache-tomcat-9.0.62/webapps";

const item = (id, overrides = {}) => ({
    id,
    documentPath: `${PATH_ROOT}/publicdocument/UPLOAD_OM_NOTIFICATION/IA_DOCS/doc_${id}.pdf`,
    fileName: `Order ${id}.pdf`,
    documentTitle: "Thermal Power & Coal Mining",
    published: true,
    orderDate: "2026-10-19T00:00:00.000+00:00",
    uploadedOn: "2026-10-19T05:58:21.075+00:00",
    documentSize: "4.08 MB",
    extension: "pdf",
    ...overrides,
});

const answer = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});
const feed = (body, status) => async () => answer(body, status);

const T1 = new Date("2026-10-19T10:00:00Z");
const T2 = new Date("2026-10-19T16:30:00Z");

const quiet = () => { for (const method of ["log", "warn", "error"]) mock.method(console, method, () => {}); };
const sync = (body, now = T1) => syncParivesh({ fetchImpl: feed(body), now });
const stored = (id) => PariveshUpdate.findOne({ pariveshId: id }).lean();
const everything = () => PariveshUpdate.find().sort({ pariveshId: 1 }).lean();

// Seeds published items straight into the database, uploaded `daysAgo[i]` days before `now`.
const seed = (daysAgo, now = new Date(), overrides = {}) =>
    PariveshUpdate.insertMany(daysAgo.map((days, index) => ({
        pariveshId: 1000 + index,
        title: `Order ${1000 + index}`,
        category: "Industry-I",
        orderDate: new Date("2026-10-19T00:00:00.000Z"),
        uploadedOn: new Date(now.getTime() - days * DAY),
        sizeLabel: "1 MB",
        pdfUrl: `https://parivesh.nic.in/publicdocument/x/${1000 + index}.pdf`,
        published: true,
        firstSeenAt: now,
        ...overrides,
    })));

const passwordVersion = crypto.createHash("sha256").update(TEST_ADMIN_PASSWORD_HASH).digest("hex").slice(0, 12);
const sessionCookie = () =>
    `oe_admin=${jwt.sign({ sub: "admin", pwv: passwordVersion }, TEST_ADMIN_JWT_SECRET, { algorithm: "HS256", expiresIn: 3600 })}`;
const adminGet = (path) => request(getApp()).get(`/api/v1/admin/updates/${path}`).set("Cookie", sessionCookie());
const adminSync = (body = {}) =>
    request(getApp()).post("/api/v1/admin/updates/sync")
        .set("Cookie", sessionCookie()).set("Origin", TEST_ORIGIN).set("Content-Type", "application/json").send(body);

describe("PARIVESH updates", () => {
    before(async () => {
        await startTestEnv();
        ({ syncParivesh, isSyncDue, getSyncStatus, buildPdfUrl, titleFromFileName, setPariveshFetch } =
            await import("../src/services/parivesh/sync.js"));
        ({ getUpdatesPage, getLatestUpdates, toPublicItem } = await import("../src/services/parivesh/updates.js"));
        ({ startJobs } = await import("../src/jobs/scheduler.js"));
        ({ PariveshUpdate } = await import("../src/models/pariveshUpdate.model.js"));
        ({ SyncStatus } = await import("../src/models/syncStatus.model.js"));
        ({ PARIVESH } = await import("../src/config/parivesh.js"));
    });
    after(stopTestEnv);
    beforeEach(resetState);
    afterEach(() => {
        mock.restoreAll();
        setPariveshFetch(null);
    });

    // ── The link and the title ───────────────────────────────────────────────
    describe("pdfUrl", () => {
        it("keeps the part from /publicdocument/ on, on PARIVESH's own host", () => {
            assert.equal(
                buildPdfUrl("/opt/apache-tomcat-9.0.62/webapps/publicdocument/UPLOAD_OM_NOTIFICATION/IA_DOCS/1003_19102026110658.pdf"),
                "https://parivesh.nic.in/publicdocument/UPLOAD_OM_NOTIFICATION/IA_DOCS/1003_19102026110658.pdf"
            );
        });

        it("URL-encodes spaces and other characters in every part of the path", () => {
            assert.equal(
                buildPdfUrl(`${PATH_ROOT}/publicdocument/UPLOAD OM/Order (2) & more #1.pdf`),
                "https://parivesh.nic.in/publicdocument/UPLOAD%20OM/Order%20(2)%20%26%20more%20%231.pdf"
            );
            assert.equal(buildPdfUrl(`${PATH_ROOT}/publicdocument/a/100% done?.pdf`), "https://parivesh.nic.in/publicdocument/a/100%25%20done%3F.pdf");
        });

        it("a built link is a valid URL on the PARIVESH host whatever the file name", () => {
            const url = new URL(buildPdfUrl(`${PATH_ROOT}/publicdocument/a b/c%20d\\e.pdf`));

            assert.equal(url.origin, "https://parivesh.nic.in");
            assert.equal(url.pathname, "/publicdocument/a%20b/c%2520d%5Ce.pdf");
        });

        it("is null without /publicdocument/, for an outside link and for a path that climbs out", () => {
            for (const bad of [
                "https://forestsclearance.nic.in/writereaddata/public_display/schemes/875875603$Guidelines.pdf",
                `${PATH_ROOT}/other/doc.pdf`,
                `${PATH_ROOT}/publicdocument/../../etc/passwd`,
                `${PATH_ROOT}/publicdocument//double.pdf`,
                "", null, undefined, 42,
            ]) {
                assert.equal(buildPdfUrl(bad), null, String(bad));
            }
        });

        it("a stored item has the built link and no documentPath", async () => {
            quiet();
            await sync([item(1, { documentPath: `${PATH_ROOT}/publicdocument/IA DOCS/my file.pdf` })]);

            const saved = await stored(1);
            assert.equal(saved.pdfUrl, "https://parivesh.nic.in/publicdocument/IA%20DOCS/my%20file.pdf");
            assert.equal(saved.documentPath, undefined);
            assert.ok(!JSON.stringify(saved).includes("apache-tomcat"));
        });
    });

    describe("title and category", () => {
        it("the title is the file name without its .pdf (any case, only at the end)", () => {
            assert.equal(titleFromFileName("Order- Reconstitution of EAC (Thermal & Coal Mining).pdf"), "Order- Reconstitution of EAC (Thermal & Coal Mining)");
            assert.equal(titleFromFileName("document (2).pdf"), "document (2)");
            assert.equal(titleFromFileName("SCAN.PDF"), "SCAN");
            assert.equal(titleFromFileName("a.pdf.pdf"), "a.pdf");
            assert.equal(titleFromFileName("report.pdf.docx"), "report.pdf.docx");
            assert.equal(titleFromFileName("no extension"), "no extension");
        });

        it("the category is the documentTitle with stray whitespace removed", async () => {
            quiet();
            await sync([item(1, { documentTitle: "Industry-III\n" }), item(2, { documentTitle: "  River   Valley &\n Hydroelectric " }), item(3, { documentTitle: null })]);

            assert.equal((await stored(1)).category, "Industry-III");
            assert.equal((await stored(2)).category, "River Valley & Hydroelectric");
            assert.equal((await stored(3)).category, "");
        });

        it("keeps size and dates, a missing orderDate or size is null", async () => {
            quiet();
            await sync([item(1), item(2, { orderDate: null, documentSize: null })]);

            const first = await stored(1);
            assert.equal(first.sizeLabel, "4.08 MB");
            assert.equal(first.orderDate.toISOString(), "2026-10-19T00:00:00.000Z");
            assert.equal(first.uploadedOn.toISOString(), "2026-10-19T05:58:21.075Z");
            const second = await stored(2);
            assert.equal(second.sizeLabel, null);
            assert.equal(second.orderDate, null);
        });
    });

    // ── The sync ─────────────────────────────────────────────────────────────
    describe("syncing", () => {
        it("asks the PARIVESH list with a 20 second limit", async () => {
            quiet();
            const seen = [];
            await syncParivesh({ fetchImpl: async (url, init) => { seen.push({ url, signal: init?.signal }); return answer([item(1)]); }, now: T1 });

            assert.equal(seen.length, 1);
            assert.equal(seen[0].url, "https://parivesh.nic.in/ua/parivesh/StatePortal/GetStatePortalData/ALL/");
            assert.ok(seen[0].signal instanceof AbortSignal);
            assert.equal(PARIVESH.timeoutMs, 20000);
        });

        it("saves the items and says how many", async () => {
            quiet();
            const outcome = await sync([item(1), item(2), item(3)]);

            assert.deepEqual(outcome, {
                ok: true, received: 3, saved: 3, inserted: 3, updated: 0, skipped: 0, skippedInvalid: 0, skippedNoPublicDocument: 0,
            });
            assert.equal(await PariveshUpdate.countDocuments(), 3);
        });

        it("running it twice gives no duplicates, and the second run changes nothing", async () => {
            quiet();
            const body = [item(1), item(2)];
            await sync(body, T1);

            const second = await sync(body, T2);

            assert.equal(await PariveshUpdate.countDocuments(), 2);
            assert.equal(second.inserted, 0);
            assert.equal(second.updated, 0);
        });

        it("a changed title (or file, or published flag) updates the stored item", async () => {
            quiet();
            await sync([item(1, { fileName: "Old title.pdf" })], T1);

            const second = await sync([item(1, { fileName: "New title.pdf", documentTitle: "Moved", documentSize: "9 MB" })], T2);

            assert.equal(second.updated, 1);
            assert.equal(await PariveshUpdate.countDocuments(), 1);
            const saved = await stored(1);
            assert.equal(saved.title, "New title");
            assert.equal(saved.category, "Moved");
            assert.equal(saved.sizeLabel, "9 MB");
        });

        it("firstSeenAt is set when the item is first saved and never changes", async () => {
            quiet();
            await sync([item(1)], T1);
            await sync([item(1, { fileName: "Renamed.pdf" }), item(2)], T2);

            assert.equal((await stored(1)).firstSeenAt.toISOString(), T1.toISOString());
            assert.equal((await stored(2)).firstSeenAt.toISOString(), T2.toISOString());
        });

        it("never deletes: an item that left the source stays", async () => {
            quiet();
            await sync([item(1), item(2)], T1);

            await sync([item(2)], T2);

            assert.equal(await PariveshUpdate.countDocuments(), 2);
            assert.ok(await stored(1));
        });

        it("skips (and counts) items without a /publicdocument/ path or that are unusable; saves the rest", async () => {
            quiet();
            const outcome = await sync([
                item(1),
                item(2, { documentPath: "https://forestsclearance.nic.in/writereaddata/public_display/schemes/875875603$Guidelines.pdf" }),
                item(3, { documentPath: `${PATH_ROOT}/other/doc.pdf` }),
                item(4, { fileName: "" }),
                item(5, { uploadedOn: "not a date" }),
                { ...item(6), id: undefined },
                { ...item(7), documentPath: undefined },
                "a string", null,
            ]);

            assert.equal(outcome.ok, true);
            assert.equal(outcome.received, 9);
            assert.equal(outcome.saved, 1);
            assert.equal(outcome.skippedNoPublicDocument, 2);
            assert.equal(outcome.skippedInvalid, 6);
            assert.equal(outcome.skipped, 8);
            assert.deepEqual((await everything()).map((doc) => doc.pariveshId), [1]);
        });

        it("a published false item is stored, and not published when the flag is missing", async () => {
            quiet();
            await sync([item(1, { published: false }), item(2, { published: undefined }), item(3)]);

            assert.equal(await PariveshUpdate.countDocuments(), 3);
            assert.equal((await stored(1)).published, false);
            assert.equal((await stored(2)).published, false);
            assert.equal((await stored(3)).published, true);
        });

        it("two syncs started together share one run", async () => {
            quiet();
            let calls = 0;
            const fetchImpl = async () => { calls++; await new Promise((done) => setImmediate(done)); return answer([item(1)]); };

            const [a, b] = await Promise.all([syncParivesh({ fetchImpl, now: T1 }), syncParivesh({ fetchImpl, now: T1 })]);

            assert.equal(calls, 1);
            assert.deepEqual(a, b);
        });
    });

    describe("a sync that fails writes nothing", () => {
        const FAILURES = [
            ["an HTTP error", async () => answer([], 503), "http_503"],
            ["a network error", async () => { throw new TypeError("fetch failed"); }, "network"],
            ["a timeout", async () => { const error = new Error("timed out"); error.name = "TimeoutError"; throw error; }, "timeout"],
            ["an answer that is not JSON", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } }), "bad_response"],
            ["an object instead of a list", feed({ data: [item(1)] }), "bad_response"],
            ["null", feed(null), "bad_response"],
            ["an empty list", feed([]), "no_valid_items"],
            ["a list with no usable item", feed([{ id: "x" }, item(2, { fileName: "" }), item(3, { documentPath: "https://elsewhere/x.pdf" })]), "no_valid_items"],
        ];

        for (const [name, fetchImpl, reason] of FAILURES) {
            it(`${name}: reason ${reason}, nothing changes, the failure is recorded`, async () => {
                quiet();
                await sync([item(1), item(2)], T1);
                const before = await everything();

                const outcome = await syncParivesh({ fetchImpl, now: T2 });

                assert.equal(outcome.ok, false);
                assert.equal(outcome.reason, reason);
                assert.deepEqual(await everything(), before);
                const status = await getSyncStatus();
                assert.equal(status.lastAttemptAt.toISOString(), T2.toISOString());
                assert.equal(status.lastSuccessAt.toISOString(), T1.toISOString(), "the last success is not touched");
                assert.equal(typeof status.lastError, "string");
                assert.ok(status.lastError.length > 0 && status.lastError.length <= 300);
                assert.equal(status.itemsReceived, 2, "the counts are those of the last good sync");
            });
        }

        it("a first-ever failure leaves the collection empty and the status without a success", async () => {
            quiet();

            await syncParivesh({ fetchImpl: feed([]), now: T1 });

            assert.equal(await PariveshUpdate.countDocuments(), 0);
            const status = await getSyncStatus();
            assert.equal(status.lastSuccessAt, null);
            assert.ok(status.lastError);
        });

        it("a database error is a failed sync, not a crash", async () => {
            quiet();
            mock.method(PariveshUpdate, "bulkWrite", async () => { throw new Error("db down"); });

            const outcome = await sync([item(1)]);

            assert.equal(outcome.ok, false);
            assert.equal(outcome.reason, "store_failed");
            assert.equal((await getSyncStatus()).lastSuccessAt, null);
        });

        it("the error text never contains a URL, stack or the raw error", async () => {
            quiet();

            await syncParivesh({ fetchImpl: async () => { throw new TypeError("fetch failed https://parivesh.nic.in/secret?token=abc"); }, now: T1 });

            assert.equal((await getSyncStatus()).lastError, "PARIVESH could not be reached");
        });
    });

    describe("the sync status", () => {
        it("is all null before the first sync", async () => {
            assert.deepEqual(await getSyncStatus(), {
                lastSuccessAt: null, lastAttemptAt: null, lastError: null, itemsReceived: null, itemsSkipped: null,
            });
        });

        it("after a good sync holds the times, the counts and no error", async () => {
            quiet();
            await syncParivesh({ fetchImpl: feed([item(1), item(2, { documentPath: "https://x.nic.in/a.pdf" })]), now: T1 });

            const status = await getSyncStatus();

            assert.equal(status.lastSuccessAt.toISOString(), T1.toISOString());
            assert.equal(status.lastAttemptAt.toISOString(), T1.toISOString());
            assert.equal(status.lastError, null);
            assert.equal(status.itemsReceived, 2);
            assert.equal(status.itemsSkipped, 1);
            assert.equal(await SyncStatus.countDocuments(), 1, "one document, however many syncs");
        });

        it("a later good sync clears the error", async () => {
            quiet();
            await syncParivesh({ fetchImpl: feed([]), now: T1 });
            await syncParivesh({ fetchImpl: feed([item(1)]), now: T2 });

            assert.equal((await getSyncStatus()).lastError, null);
            assert.equal(await SyncStatus.countDocuments(), 1);
        });

        it("isSyncDue: yes with no sync, no inside 6 hours, yes after", async () => {
            quiet();
            assert.equal(await isSyncDue({ now: T1 }), true);

            await sync([item(1)], T1);

            assert.equal(await isSyncDue({ now: new Date(T1.getTime() + 5 * 60 * 60 * 1000) }), false);
            assert.equal(await isSyncDue({ now: new Date(T1.getTime() + 6 * 60 * 60 * 1000) }), false, "exactly 6 hours is not older");
            assert.equal(await isSyncDue({ now: new Date(T1.getTime() + 6 * 60 * 60 * 1000 + 1) }), true);
        });

        it("a failed attempt does not make a fresh success look old", async () => {
            quiet();
            await sync([item(1)], T1);
            await syncParivesh({ fetchImpl: feed([]), now: new Date(T1.getTime() + 60 * 60 * 1000) });

            assert.equal(await isSyncDue({ now: new Date(T1.getTime() + 2 * 60 * 60 * 1000) }), false);
        });
    });

    // ── The public endpoints ─────────────────────────────────────────────────
    describe("GET /api/v1/updates/latest", () => {
        const latest = () => request(getApp()).get("/api/v1/updates/latest");

        it("is the 5 newest published items (same date: later upload first), in the documented shape", async () => {
            await seed([9, 1, 5, 3, 7, 2, 30]);

            const res = await latest();

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.deepEqual(Object.keys(res.body.data), ["items"]);
            assert.deepEqual(res.body.data.items.map((entry) => entry.id), [1001, 1005, 1003, 1002, 1004]);   // 1, 2, 3, 5, 7 days ago
            for (const entry of res.body.data.items) {
                assert.deepEqual(Object.keys(entry), ["id", "title", "category", "date", "sizeLabel", "pdfUrl", "isNew"]);
            }
            assert.deepEqual(res.body.data.items[0], {
                id: 1001, title: "Order 1001", category: "Industry-I", date: "2026-10-19", sizeLabel: "1 MB",
                pdfUrl: "https://parivesh.nic.in/publicdocument/x/1001.pdf", isNew: true,
            });
        });

        it("hides unpublished items", async () => {
            await seed([1, 2]);
            await seed([0], new Date(), { published: false, pariveshId: 5000 });

            const res = await latest();

            assert.deepEqual(res.body.data.items.map((entry) => entry.id), [1000, 1001]);
        });

        it("is an empty list before the first sync", async () => {
            const res = await latest();

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { items: [] });
        });

        it("is cacheable for 10 minutes", async () => {
            assert.equal((await latest()).headers["cache-control"], "public, max-age=600");
        });

        it("takes no input: a query key is 400", async () => {
            const res = await request(getApp()).get("/api/v1/updates/latest?page=2");

            assert.equal(res.status, 400);
            assert.equal(res.body.code, "VALIDATION_FAILED");
        });

        it("the raw documentPath is never in the answer, even after a real sync", async () => {
            quiet();
            await sync([item(1)]);

            const res = await latest();

            const text = JSON.stringify(res.body);
            assert.ok(!text.includes("documentPath"));
            assert.ok(!text.includes("apache-tomcat"));
            assert.ok(!text.includes("firstSeenAt"));
            assert.equal(res.body.data.items[0].pdfUrl, "https://parivesh.nic.in/publicdocument/UPLOAD_OM_NOTIFICATION/IA_DOCS/doc_1.pdf");
        });
    });

    describe("GET /api/v1/updates", () => {
        const page = (query = "") => request(getApp()).get(`/api/v1/updates${query}`);

        it("pages of 10: totals, pageSize and totalPages", async () => {
            await seed(Array.from({ length: 23 }, (_, index) => index + 1));

            const first = (await page("?page=1")).body.data;
            const second = (await page("?page=2")).body.data;
            const third = (await page("?page=3")).body.data;

            assert.deepEqual([first.page, first.pageSize, first.total, first.totalPages], [1, 10, 23, 3]);
            assert.deepEqual([first.items.length, second.items.length, third.items.length], [10, 10, 3]);
            assert.deepEqual(Object.keys(first), ["items", "page", "pageSize", "total", "totalPages"]);
            const ids = [...first.items, ...second.items, ...third.items].map((entry) => entry.id);
            assert.equal(new Set(ids).size, 23, "no item repeats or is missed across pages");
            assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "newest upload first");
        });

        it("the page defaults to 1", async () => {
            await seed([1, 2, 3]);

            const res = await page();

            assert.equal(res.body.data.page, 1);
            assert.equal(res.body.data.items.length, 3);
        });

        it("exactly 10 items is one page, 11 is two", async () => {
            await seed(Array.from({ length: 10 }, (_, index) => index + 1));
            assert.equal((await page()).body.data.totalPages, 1);

            await seed([20], new Date(), { pariveshId: 9999 });
            assert.equal((await page()).body.data.totalPages, 2);
            assert.equal((await page("?page=2")).body.data.items.length, 1);
        });

        it("a page past the end is empty, with the totals", async () => {
            await seed([1, 2, 3]);

            const res = await page("?page=5");

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { items: [], page: 5, pageSize: 10, total: 3, totalPages: 1 });
        });

        it("with nothing synced yet: no items, total 0, totalPages 0", async () => {
            const res = await page();

            assert.deepEqual(res.body.data, { items: [], page: 1, pageSize: 10, total: 0, totalPages: 0 });
        });

        it("the totals count published items only, and unpublished ones are never listed", async () => {
            await seed([1, 2, 3]);
            await PariveshUpdate.insertMany([4, 5].map((n) => ({
                pariveshId: 7000 + n, title: "Hidden", pdfUrl: "https://parivesh.nic.in/publicdocument/h.pdf",
                uploadedOn: new Date(), published: false, firstSeenAt: new Date(),
            })));

            const res = await page();

            assert.equal(res.body.data.total, 3);
            assert.ok(res.body.data.items.every((entry) => entry.title !== "Hidden"));
        });

        it("a bad page or an unknown query key is 400", async () => {
            for (const query of ["?page=0", "?page=-1", "?page=abc", "?page=1.5", "?page=", "?page=100000", "?page[$gt]=", "?page=1&x=1", "?size=50"]) {
                const res = await page(query);

                assert.equal(res.status, 400, query);
                assert.equal(res.body.code, "VALIDATION_FAILED", query);
            }
        });

        it("is cacheable for 10 minutes", async () => {
            assert.equal((await page()).headers["cache-control"], "public, max-age=600");
        });
    });

    describe("the order: newest date first", () => {
        // orderDate is the date each item is shown with; uploadedOn is when PARIVESH published it.
        const doc = (id, orderDate, uploadedOn, overrides = {}) => ({
            pariveshId: id, title: `Item ${id}`, category: "c", orderDate: orderDate ? new Date(`${orderDate}T00:00:00Z`) : null,
            uploadedOn: new Date(`${uploadedOn}T06:00:00Z`), sizeLabel: null, pdfUrl: `https://parivesh.nic.in/publicdocument/${id}.pdf`,
            published: true, firstSeenAt: new Date(), ...overrides,
        });
        const dates = (res) => res.body.data.items.map((entry) => entry.date);
        const ids = (res) => res.body.data.items.map((entry) => entry.id);
        const latest = () => request(getApp()).get("/api/v1/updates/latest");
        const list = (query = "") => request(getApp()).get(`/api/v1/updates${query}`);

        it("an order with an old date uploaded recently is listed by its date, not by when it was uploaded", async () => {
            // the real case: an order dated 2023, uploaded in October 2026
            await PariveshUpdate.insertMany([
                doc(1, "2026-10-19", "2026-10-19"),
                doc(2, "2026-10-14", "2026-10-14"),
                doc(3, "2023-10-13", "2026-10-11"),
                doc(4, "2026-10-06", "2026-10-06"),
                doc(5, "2026-09-29", "2026-10-09"),
            ]);

            const res = await latest();

            assert.deepEqual(dates(res), ["2026-10-19", "2026-10-14", "2026-10-06", "2026-09-29", "2023-10-13"]);
            assert.deepEqual(ids(res), [1, 2, 4, 5, 3]);
        });

        it("the whole list, page after page, never shows a newer date below an older one", async () => {
            const days = [19, 3, 27, 8, 14, 1, 22, 11, 30, 5, 17, 9, 25, 2, 13, 28, 6, 20, 12, 24, 4, 16, 10, 26, 7];
            await PariveshUpdate.insertMany(days.map((day, index) => doc(100 + index, `2026-09-${String(day).padStart(2, "0")}`, "2026-10-01")));

            const all = [];
            for (const page of [1, 2, 3]) all.push(...dates(await list(`?page=${page}`)));

            assert.equal(all.length, 25);
            assert.deepEqual(all, [...all].sort().reverse());
        });

        it("items with no date come last, after every dated item", async () => {
            await PariveshUpdate.insertMany([
                doc(1, null, "2026-10-19"),
                doc(2, "2026-01-05", "2026-01-05"),
                doc(3, null, "2026-10-18"),
                doc(4, "2022-02-02", "2022-02-02"),
            ]);

            const res = await latest();

            assert.deepEqual(ids(res), [2, 4, 1, 3]);   // dated newest first, then the undated, later upload first
            assert.deepEqual(dates(res), ["2026-01-05", "2022-02-02", null, null]);
        });

        it("the same date: the later upload first, then the higher id", async () => {
            await PariveshUpdate.insertMany([
                doc(1, "2026-10-10", "2026-10-10"),
                doc(2, "2026-10-10", "2026-10-12"),
                doc(3, "2026-10-10", "2026-10-12"),
                doc(4, "2026-10-11", "2026-10-01"),
            ]);

            assert.deepEqual(ids(await latest()), [4, 3, 2, 1]);
        });

        it("the page list and the latest list agree", async () => {
            await PariveshUpdate.insertMany([doc(1, "2026-10-01", "2026-10-30"), doc(2, "2026-10-20", "2026-10-02"), doc(3, "2026-10-10", "2026-10-15")]);

            assert.deepEqual(ids(await list()), ids(await latest()));
            assert.deepEqual(ids(await list()), [2, 3, 1]);
        });

        it("the index serves this order", async () => {
            await PariveshUpdate.init();
            const keys = (await PariveshUpdate.collection.indexes()).map((index) => JSON.stringify(index.key));

            assert.ok(keys.includes(JSON.stringify({ published: 1, orderDate: -1, uploadedOn: -1 })), keys.join(" "));
        });
    });

    describe("an item's date and isNew", () => {
        const document = (overrides) => ({
            pariveshId: 1, title: "t", category: "c", sizeLabel: null, pdfUrl: "u",
            orderDate: new Date("2026-10-19T00:00:00Z"), uploadedOn: new Date("2026-10-19T00:00:00Z"), ...overrides,
        });
        const NOW = new Date("2026-11-02T00:00:00Z");

        it("isNew: uploaded within the last 14 days, the 14 day mark included", () => {
            const at = (offsetMs) => toPublicItem(document({ uploadedOn: new Date(NOW.getTime() - 14 * DAY + offsetMs) }), NOW).isNew;

            assert.equal(at(1), true, "14 days minus 1 ms");
            assert.equal(at(0), true, "exactly 14 days");
            assert.equal(at(-1), false, "14 days plus 1 ms");
            assert.equal(toPublicItem(document({ uploadedOn: NOW }), NOW).isNew, true);
            assert.equal(toPublicItem(document({ uploadedOn: new Date(NOW.getTime() - 60 * DAY) }), NOW).isNew, false);
        });

        it("isNew through the API: 13 days old is new, 15 days old is not", async () => {
            await seed([13, 15]);

            const res = await request(getApp()).get("/api/v1/updates/latest");

            assert.deepEqual(res.body.data.items.map((entry) => entry.isNew), [true, false]);
        });

        it("date is the order date as an IST calendar day", () => {
            assert.equal(toPublicItem(document({ orderDate: new Date("2026-10-19T00:00:00Z") }), NOW).date, "2026-10-19");
            assert.equal(toPublicItem(document({ orderDate: new Date("2026-10-18T20:00:00Z") }), NOW).date, "2026-10-19", "20:00 UTC is already the next day in IST");
            assert.equal(toPublicItem(document({ orderDate: new Date("2026-10-19T18:29:59Z") }), NOW).date, "2026-10-19");
            assert.equal(toPublicItem(document({ orderDate: new Date("2026-10-19T18:30:00Z") }), NOW).date, "2026-10-20");
        });

        it("no order date is null, not a made-up date", () => {
            assert.equal(toPublicItem(document({ orderDate: null }), NOW).date, null);
        });

        it("getLatestUpdates and getUpdatesPage honour the given clock", async () => {
            await seed([10]);
            const later = new Date(Date.now() + 10 * DAY);

            assert.equal((await getLatestUpdates({ now: new Date() }))[0].isNew, true);
            assert.equal((await getLatestUpdates({ now: later }))[0].isNew, false);
            assert.equal((await getUpdatesPage(1, { now: later })).items[0].isNew, false);
        });
    });

    // ── Admin ────────────────────────────────────────────────────────────────
    describe("admin: GET /api/v1/admin/updates/sync-status", () => {
        it("needs an admin session", async () => {
            const res = await request(getApp()).get("/api/v1/admin/updates/sync-status");

            assert.equal(res.status, 401);
            assert.equal(res.body.code, "ADMIN_UNAUTHORIZED");
        });

        it("is all null before the first sync", async () => {
            const res = await adminGet("sync-status");

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { lastSuccessAt: null, lastAttemptAt: null, lastError: null, itemsReceived: null, itemsSkipped: null });
        });

        it("reports the last sync", async () => {
            quiet();
            await sync([item(1), item(2, { documentPath: "https://x.nic.in/a.pdf" })], T1);

            const res = await adminGet("sync-status");

            assert.deepEqual(res.body.data, {
                lastSuccessAt: T1.toISOString(), lastAttemptAt: T1.toISOString(), lastError: null, itemsReceived: 2, itemsSkipped: 1,
            });
        });

        it("takes no input: a query key is 400", async () => {
            const res = await adminGet("sync-status?x=1");

            assert.equal(res.status, 400);
        });
    });

    describe("admin: POST /api/v1/admin/updates/sync", () => {
        it("needs an admin session and a trusted Origin", async () => {
            const noSession = await request(getApp()).post("/api/v1/admin/updates/sync")
                .set("Origin", TEST_ORIGIN).set("Content-Type", "application/json").send({});
            const badOrigin = await request(getApp()).post("/api/v1/admin/updates/sync")
                .set("Cookie", sessionCookie()).set("Origin", "https://evil.example").set("Content-Type", "application/json").send({});

            assert.equal(noSession.status, 401);
            assert.equal(badOrigin.status, 403);
            assert.equal(await PariveshUpdate.countDocuments(), 0);
        });

        it("runs a sync now and answers how it went", async () => {
            quiet();
            setPariveshFetch(feed([item(1), item(2), item(3, { documentPath: "https://x.nic.in/a.pdf" })]));

            const res = await adminSync();

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { received: 3, saved: 2, inserted: 2, updated: 0, skipped: 1 });
            assert.equal(await PariveshUpdate.countDocuments(), 2);
            assert.ok((await getSyncStatus()).lastSuccessAt);
        });

        it("a failing source is 502 PARIVESH_SYNC_FAILED, nothing changes, the failure is recorded", async () => {
            quiet();
            await sync([item(1)], T1);
            setPariveshFetch(feed([], 503));

            const res = await adminSync();

            assert.equal(res.status, 502);
            assert.equal(res.body.code, "PARIVESH_SYNC_FAILED");
            assert.match(res.body.message, /503/);
            assert.equal(await PariveshUpdate.countDocuments(), 1);
            assert.ok((await getSyncStatus()).lastError);
        });

        it("takes no input: any body key is 400 and runs nothing", async () => {
            setPariveshFetch(async () => { throw new Error("must not be called"); });

            const res = await adminSync({ force: true });

            assert.equal(res.status, 400);
            assert.equal(res.body.code, "VALIDATION_FAILED");
            assert.equal(await SyncStatus.countDocuments(), 0);
        });

        it("only once per 5 minutes: the second is 429 RATE_LIMITED with Retry-After", async () => {
            quiet();
            rateLimiting.enable();
            setPariveshFetch(feed([item(1)]));

            const first = await adminSync();
            const second = await adminSync();

            assert.equal(first.status, 200);
            assert.equal(second.status, 429);
            assert.equal(second.body.code, "RATE_LIMITED");
            assert.match(second.body.message, /5 minutes/);
            assert.ok(Number(second.headers["retry-after"]) > 0 && Number(second.headers["retry-after"]) <= 300);
        });

        it("the limit is 5 minutes for everyone, not per address", async () => {
            quiet();
            rateLimiting.enable();
            setPariveshFetch(feed([item(1)]));
            const app = getApp();
            const trustProxy = app.get("trust proxy");
            app.set("trust proxy", 1);   // so X-Forwarded-For decides the address the limiter sees

            try {
                const first = await adminSync().set("X-Forwarded-For", "203.0.113.1");
                const fromElsewhere = await adminSync().set("X-Forwarded-For", "203.0.113.9");

                assert.equal(first.status, 200);
                assert.equal(fromElsewhere.status, 429);
            } finally {
                app.set("trust proxy", trustProxy);
            }
        });

        it("an unauthorised request does not use up the 5 minutes", async () => {
            quiet();
            rateLimiting.enable();
            setPariveshFetch(feed([item(1)]));

            await request(getApp()).post("/api/v1/admin/updates/sync").set("Origin", TEST_ORIGIN).set("Content-Type", "application/json").send({});
            const real = await adminSync();

            assert.equal(real.status, 200);
        });
    });

    // ── The schedule ─────────────────────────────────────────────────────────
    describe("the job schedule", () => {
        const fakeCron = () => {
            const calls = [];
            const stop = mock.fn();
            const schedule = (expression, task, options) => { calls.push({ expression, task, options }); return { stop }; };
            return { calls, stop, schedule };
        };
        const tick = () => new Promise((done) => setImmediate(done));
        // For the real start-up check, which reads the database: wait until the job has had its say.
        const settle = () => new Promise((done) => setTimeout(done, 150));
        const base = { run: async () => {} };    // the AQI job is not under test here

        it("syncs at minute 5 of every 6th hour, on the Indian clock, and node-cron accepts it", async () => {
            quiet();
            const { calls, schedule } = fakeCron();

            startJobs({ schedule, ...base, runParivesh: async () => {}, isPariveshDue: async () => false });

            const job = calls.filter((call) => call.expression === "5 */6 * * *");
            assert.equal(job.length, 1);
            assert.deepEqual(job[0].options, { timezone: "Asia/Kolkata" });
            assert.equal((await import("node-cron")).default.validate("5 */6 * * *"), true);
        });

        it("runs a sync at start-up when one is due", async () => {
            quiet();
            const { schedule } = fakeCron();
            const runParivesh = mock.fn(async () => {});

            startJobs({ schedule, ...base, runParivesh, isPariveshDue: async () => true });
            await tick();

            assert.equal(runParivesh.mock.callCount(), 1);
        });

        it("does not sync at start-up when the last good sync is recent", async () => {
            quiet();
            const { schedule } = fakeCron();
            const runParivesh = mock.fn(async () => {});

            startJobs({ schedule, ...base, runParivesh, isPariveshDue: async () => false });
            await tick();

            assert.equal(runParivesh.mock.callCount(), 0);
        });

        it("the real start-up check: due with no sync, not due right after one", async () => {
            quiet();
            const { schedule } = fakeCron();
            const runParivesh = mock.fn(async () => {});

            startJobs({ schedule, ...base, runParivesh });
            await settle();
            assert.equal(runParivesh.mock.callCount(), 1, "nothing synced yet");

            await sync([item(1)], new Date());
            startJobs({ schedule, ...base, runParivesh });
            await settle();
            assert.equal(runParivesh.mock.callCount(), 1, "just synced");
        });

        it("the scheduled run syncs whatever the start-up check said", async () => {
            quiet();
            const { calls, schedule } = fakeCron();
            const runParivesh = mock.fn(async () => {});

            startJobs({ schedule, ...base, runParivesh, isPariveshDue: async () => false });
            await calls.find((call) => call.expression === "5 */6 * * *").task();
            await calls.find((call) => call.expression === "5 */6 * * *").task();

            assert.equal(runParivesh.mock.callCount(), 2);
        });

        it("a sync that throws is logged and the schedule carries on", async () => {
            quiet();
            const { calls, schedule } = fakeCron();
            const runParivesh = mock.fn(async () => { throw new Error("boom"); });

            startJobs({ schedule, ...base, runParivesh, isPariveshDue: async () => true });
            await tick();
            await calls.find((call) => call.expression === "5 */6 * * *").task();

            assert.equal(runParivesh.mock.callCount(), 2);
        });

        it("a failing start-up check does not stop the server or the schedule", async () => {
            quiet();
            const { calls, schedule } = fakeCron();

            assert.doesNotThrow(() => startJobs({ schedule, ...base, runParivesh: async () => {}, isPariveshDue: async () => { throw new Error("db down"); } }));
            await tick();

            assert.equal(calls.length, 2);
        });

        it("skips a scheduled sync while the previous one is still going", async () => {
            quiet();
            const { calls, schedule } = fakeCron();
            let finish;
            const runParivesh = mock.fn(() => new Promise((done) => { finish = done; }));

            startJobs({ schedule, ...base, runParivesh, isPariveshDue: async () => true });
            await tick();
            await calls.find((call) => call.expression === "5 */6 * * *").task();
            assert.equal(runParivesh.mock.callCount(), 1);

            finish();
            await tick(); await tick();
            const next = calls.find((call) => call.expression === "5 */6 * * *").task();
            await tick();
            assert.equal(runParivesh.mock.callCount(), 2, "runs again once the first has finished");
            finish();
            await next;
        });

        it("stopping stops both schedules", () => {
            quiet();
            const { schedule, stop } = fakeCron();

            const stopJobs = startJobs({ schedule, ...base, runParivesh: async () => {}, isPariveshDue: async () => false });
            stopJobs();

            assert.equal(stop.mock.callCount(), 2);
        });
    });
});
