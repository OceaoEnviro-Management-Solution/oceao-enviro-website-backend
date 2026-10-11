import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import { getCallbackCalendar, getCallbackAvailability } from "../services/callbackAvailability.service.js";
import { createCallbackRequest } from "../services/callbackRequest.service.js";

const handleGetCalendar = asyncHandler(async (req, res) => {
    const { from, to } = req.validatedQuery;
    const days = await getCallbackCalendar(from, to);

    return res.status(200).json(new ApiResponse(200, { days }, "Calendar loaded"));
});

const handleGetAvailability = asyncHandler(async (req, res) => {
    const data = await getCallbackAvailability(req.validatedQuery.date);

    return res.status(200).json(new ApiResponse(200, data, "Availability loaded"));
});

const handleCreateRequest = asyncHandler(async (req, res) => {
    const data = await createCallbackRequest(req.body);

    return res.status(201).json(new ApiResponse(201, data, "Callback requested"));
});

export { handleGetCalendar, handleGetAvailability, handleCreateRequest };
