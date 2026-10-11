import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import { blockVmSlots, unblockVmSlots, cancelVmBooking, retryVmMeet } from "../services/adminVm.service.js";

const handleVmBlock = asyncHandler(async (req, res) => {
    const data = await blockVmSlots(req.body);

    return res.status(200).json(new ApiResponse(200, data, "Slots blocked"));
});

const handleVmUnblock = asyncHandler(async (req, res) => {
    const data = await unblockVmSlots(req.body);

    return res.status(200).json(new ApiResponse(200, data, "Slots unblocked"));
});

const handleVmCancel = asyncHandler(async (req, res) => {
    const data = await cancelVmBooking(req.validatedParams.bookingId, req.body);

    return res.status(200).json(new ApiResponse(200, data, "Booking cancelled"));
});

const handleVmRetryMeet = asyncHandler(async (req, res) => {
    const data = await retryVmMeet(req.validatedParams.bookingId, req.body);

    return res.status(200).json(new ApiResponse(200, data, "Meet link created"));
});

export { handleVmBlock, handleVmUnblock, handleVmCancel, handleVmRetryMeet };
