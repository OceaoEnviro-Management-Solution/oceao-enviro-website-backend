import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import { getAqiStations } from "../services/aqi/readings.js";

// GET /aqi: the latest AQI of each station. Cacheable for 5 minutes (it changes hourly).
const handleGetAqi = asyncHandler(async (req, res) => {
    const stations = await getAqiStations();

    res.set("Cache-Control", "public, max-age=300");
    return res.status(200).json(new ApiResponse(200, { stations }, "Air quality loaded"));
});

export { handleGetAqi };
