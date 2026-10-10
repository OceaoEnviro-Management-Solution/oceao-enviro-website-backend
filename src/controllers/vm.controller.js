import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import { sendOtp, verifyOtp } from "../services/otp.service.js";

const handleSendOtp = asyncHandler(async (req, res) => {
    const data = await sendOtp(req.body.email);

    return res.status(200).json(new ApiResponse(200, data, "Verification code sent"));
});

const handleVerifyOtp = asyncHandler(async (req, res) => {
    const data = await verifyOtp(req.body.email, req.body.otp);

    return res.status(200).json(new ApiResponse(200, data, "Email verified"));
});

export { handleSendOtp, handleVerifyOtp };
