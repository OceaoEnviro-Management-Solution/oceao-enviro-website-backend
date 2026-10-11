import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import {
    blockCallbackPeriods,
    unblockCallbackPeriods,
    cancelCallbackRequests,
    setCallbackRequestStatus,
} from "../services/adminCallback.service.js";

const handleCallbackBlock = asyncHandler(async (req, res) => {
    const data = await blockCallbackPeriods(req.body);

    return res.status(200).json(new ApiResponse(200, data, "Periods blocked"));
});

const handleCallbackUnblock = asyncHandler(async (req, res) => {
    const data = await unblockCallbackPeriods(req.body);

    return res.status(200).json(new ApiResponse(200, data, "Periods unblocked"));
});

const handleCallbackCancel = asyncHandler(async (req, res) => {
    const data = await cancelCallbackRequests(req.body);

    return res.status(200).json(new ApiResponse(200, data, "Requests cancelled"));
});

const handleCallbackStatus = asyncHandler(async (req, res) => {
    const data = await setCallbackRequestStatus(req.validatedParams.requestId, req.body);

    return res.status(200).json(new ApiResponse(200, data, "Status updated"));
});

export { handleCallbackBlock, handleCallbackUnblock, handleCallbackCancel, handleCallbackStatus };
