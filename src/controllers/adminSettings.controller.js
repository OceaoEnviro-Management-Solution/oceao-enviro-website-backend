import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import {
    updateCallbackCapacity,
    addHoliday,
    addHolidays,
    renameHoliday,
    deleteHoliday,
} from "../services/adminSettings.service.js";

const handleCapacity = asyncHandler(async (req, res) => {
    const data = await updateCallbackCapacity(req.body);

    return res.status(200).json(new ApiResponse(200, data, "Callback capacity saved"));
});

const handleHolidayAdd = asyncHandler(async (req, res) => {
    const data = await addHoliday(req.body);

    return res.status(200).json(new ApiResponse(200, data, "Holiday added"));
});

const handleHolidayBulk = asyncHandler(async (req, res) => {
    const data = await addHolidays(req.body);

    return res.status(200).json(new ApiResponse(200, data, "Holidays added"));
});

const handleHolidayRename = asyncHandler(async (req, res) => {
    const data = await renameHoliday(req.validatedParams.date, req.body);

    return res.status(200).json(new ApiResponse(200, data, "Holiday renamed"));
});

const handleHolidayDelete = asyncHandler(async (req, res) => {
    const data = await deleteHoliday(req.validatedParams.date, req.body);

    return res.status(200).json(new ApiResponse(200, data, "Holiday removed"));
});

export { handleCapacity, handleHolidayAdd, handleHolidayBulk, handleHolidayRename, handleHolidayDelete };
