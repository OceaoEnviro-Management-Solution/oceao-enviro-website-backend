import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import { sendOtp, verifyOtp } from "../services/otp.service.js";
import { getVmCalendar, getVmAvailability } from "../services/vmAvailability.service.js";
import { createVmBooking } from "../services/vmBooking.service.js";

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

const handleCreateBooking = asyncHandler(async (req, res) => {
    // The email comes only from the verified booking token, never from the body.
    const data = await createVmBooking({ ...req.body, email: req.verifiedEmail });

    return res.status(201).json(new ApiResponse(201, data, "Virtual meeting booked"));
});

export { handleSendOtp, handleVerifyOtp, handleGetCalendar, handleGetAvailability, handleCreateBooking };
