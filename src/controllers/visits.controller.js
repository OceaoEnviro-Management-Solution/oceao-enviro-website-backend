import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import {
    DEFAULT_DAILY_DAYS,
    getDaily,
    getTotal,
    isCountableUserAgent,
    recordVisit,
} from "../services/visits.service.js";

// POST /visits: counts the visit unless the caller is a bot (or has no User-Agent), and answers
// with the total either way, so the footer always has a number to show.
const handleRecordVisit = asyncHandler(async (req, res) => {
    if (isCountableUserAgent(req.get("user-agent"))) {
        await recordVisit();
    }
    const total = await getTotal();

    return res.status(200).json(new ApiResponse(200, { total }, "Visit recorded"));
});

// GET /visits/total: cacheable for a minute (the footer asks on every page load).
const handleGetTotal = asyncHandler(async (req, res) => {
    const total = await getTotal();

    res.set("Cache-Control", "public, max-age=60");
    return res.status(200).json(new ApiResponse(200, { total }, "Total loaded"));
});

// GET /admin/visits?days: the total and one entry per day, oldest first.
const handleAdminVisits = asyncHandler(async (req, res) => {
    const days = req.validatedQuery.days ?? DEFAULT_DAILY_DAYS;
    const [total, daily] = await Promise.all([getTotal(), getDaily(days)]);

    return res.status(200).json(new ApiResponse(200, { total, daily }, "Visits loaded"));
});

export { handleRecordVisit, handleGetTotal, handleAdminVisits };
