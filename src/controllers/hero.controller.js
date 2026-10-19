import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import { logger } from "../utils/logger.js";
import { getLiveSlides, promoteIfDue } from "../services/hero.service.js";

// GET /hero: switches the slide sets first when the planned date has come, then lists the live
// slides. A switch that fails is logged and the visitor still gets the slides that exist (the
// switch tries again on the next request). Cacheable for 5 minutes, except after a failed switch:
// that answer may be incomplete, so it is not cached and the next request gets a fresh one.
const handleGetHero = asyncHandler(async (req, res) => {
    let switchFailed = false;
    try {
        await promoteIfDue();
    } catch (error) {
        switchFailed = true;
        logger.error("Hero switch failed", error);
    }

    const slides = await getLiveSlides();

    res.set("Cache-Control", switchFailed ? "no-store" : "public, max-age=300");
    return res.status(200).json(new ApiResponse(200, { slides }, "Hero slides loaded"));
});

export { handleGetHero };
