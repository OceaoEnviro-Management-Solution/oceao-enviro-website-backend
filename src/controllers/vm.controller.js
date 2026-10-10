import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import { sendOtp, verifyOtp } from "../services/otp.service.js";
import { getVmCalendar, getVmAvailability } from "../services/vmAvailability.service.js";

const handleSendOtp = asyncHandler(async (req, res) => {
    const data = await sendOtp(req.body.email);

    return res.status(200).json(new ApiResponse(200, data, "Verification code sent"));
});

const handleVerifyOtp = asyncHandler(async (req, res) => {
    const data = await verifyOtp(req.body.email, req.body.otp);

    return res.status(200).json(new ApiResponse(200, data, "Email verified"));
});

const handleGetCalendar = asyncHandler(async (req, res) => {
    const { from, to } = req.validatedQuery;
    const days = await getVmCalendar(from, to);

    return res.status(200).json(new ApiResponse(200, { days }, "Calendar loaded"));
});

const handleGetAvailability = asyncHandler(async (req, res) => {
    const data = await getVmAvailability(req.validatedQuery.date);

    return res.status(200).json(new ApiResponse(200, data, "Availability loaded"));
});

export { handleSendOtp, handleVerifyOtp, handleGetCalendar, handleGetAvailability };
