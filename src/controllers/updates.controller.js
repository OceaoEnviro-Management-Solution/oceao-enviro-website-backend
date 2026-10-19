import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import { ApiError } from "../utils/ApiError.js";
import { getLatestUpdates, getUpdatesPage } from "../services/parivesh/updates.js";
import { getSyncStatus, syncParivesh } from "../services/parivesh/sync.js";

// The list changes a few times a week and is synced every 6 hours: 10 minutes is plenty.
const CACHE_CONTROL = "public, max-age=600";

// GET /updates/latest: the 5 newest, for the homepage.
const handleLatestUpdates = asyncHandler(async (req, res) => {
    const items = await getLatestUpdates();

    res.set("Cache-Control", CACHE_CONTROL);
    return res.status(200).json(new ApiResponse(200, { items }, "Updates loaded"));
});

// GET /updates?page: the Updates page.
const handleUpdates = asyncHandler(async (req, res) => {
    const data = await getUpdatesPage(req.validatedQuery.page ?? 1);

    res.set("Cache-Control", CACHE_CONTROL);
    return res.status(200).json(new ApiResponse(200, data, "Updates loaded"));
});

// GET /admin/updates/sync-status
const handleSyncStatus = asyncHandler(async (req, res) => {
    const status = await getSyncStatus();

    return res.status(200).json(new ApiResponse(200, status, "Sync status loaded"));
});

// POST /admin/updates/sync: runs a sync now and answers how it went.
const handleSyncNow = asyncHandler(async (req, res) => {
    const outcome = await syncParivesh();

    if (!outcome.ok) {
        throw new ApiError(502, "PARIVESH_SYNC_FAILED", `Sync failed: ${outcome.message}. Nothing was changed.`);
    }

    const { received, saved, inserted, updated, skipped } = outcome;
    return res.status(200).json(new ApiResponse(200, { received, saved, inserted, updated, skipped }, "Sync finished"));
});

export { handleLatestUpdates, handleUpdates, handleSyncStatus, handleSyncNow };
