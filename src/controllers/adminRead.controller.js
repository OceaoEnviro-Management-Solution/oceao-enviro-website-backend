import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import {
    getDashboard,
    listBookings,
    getVmMonth,
    getVmDay,
    getCallbackDay,
    listCallbackRequests,
    getAdminSettings,
    listHolidays,
} from "../services/adminRead.service.js";

const handleDashboard = asyncHandler(async (req, res) => {
    const data = await getDashboard(req.validatedQuery.date);

    return res.status(200).json(new ApiResponse(200, data, "Dashboard loaded"));
});

const handleBookings = asyncHandler(async (req, res) => {
    const data = await listBookings(req.validatedQuery);

    return res.status(200).json(new ApiResponse(200, data, "Bookings loaded"));
});

const handleVmCalendar = asyncHandler(async (req, res) => {
    const data = await getVmMonth(req.validatedQuery.month);

    return res.status(200).json(new ApiResponse(200, data, "Calendar loaded"));
});

const handleVmAvailability = asyncHandler(async (req, res) => {
    const data = await getVmDay(req.validatedQuery.date);

    return res.status(200).json(new ApiResponse(200, data, "Availability loaded"));
});

const handleCallbackAvailability = asyncHandler(async (req, res) => {
    const data = await getCallbackDay(req.validatedQuery.date);

    return res.status(200).json(new ApiResponse(200, data, "Availability loaded"));
});

const handleCallbackRequests = asyncHandler(async (req, res) => {
    const data = await listCallbackRequests(req.validatedQuery);

    return res.status(200).json(new ApiResponse(200, data, "Callback requests loaded"));
});

const handleSettings = asyncHandler(async (req, res) => {
    const data = await getAdminSettings();

    return res.status(200).json(new ApiResponse(200, data, "Settings loaded"));
});

const handleHolidays = asyncHandler(async (req, res) => {
    const data = await listHolidays(req.validatedQuery.year);

    return res.status(200).json(new ApiResponse(200, data, "Holidays loaded"));
});

export {
    handleDashboard,
    handleBookings,
    handleVmCalendar,
    handleVmAvailability,
    handleCallbackAvailability,
    handleCallbackRequests,
    handleSettings,
    handleHolidays,
};
