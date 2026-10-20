import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import {
    addSlide,
    clearSchedule,
    deleteSlide,
    getAdminHero,
    setOrder,
    setSchedule,
    updateSlide,
} from "../services/adminHero.service.js";

const handleHeroGet = asyncHandler(async (req, res) => {
    const data = await getAdminHero();

    return res.status(200).json(new ApiResponse(200, data, "Hero slides loaded"));
});

const handleSlideAdd = asyncHandler(async (req, res) => {
    const slide = await addSlide(req.body, req.file);

    return res.status(201).json(new ApiResponse(201, { slide }, "Slide added"));
});

const handleSlideUpdate = asyncHandler(async (req, res) => {
    const slide = await updateSlide(req.validatedParams.id, req.body);

    return res.status(200).json(new ApiResponse(200, { slide }, "Slide updated"));
});

const handleSlideDelete = asyncHandler(async (req, res) => {
    const data = await deleteSlide(req.validatedParams.id, req.body);

    return res.status(200).json(new ApiResponse(200, data, "Slide deleted"));
});

const handleOrder = asyncHandler(async (req, res) => {
    const data = await setOrder(req.body);

    return res.status(200).json(new ApiResponse(200, data, "Order saved"));
});

const handleScheduleSet = asyncHandler(async (req, res) => {
    const data = await setSchedule(req.body);

    return res.status(200).json(new ApiResponse(200, data, "Switch date saved"));
});

const handleScheduleClear = asyncHandler(async (req, res) => {
    const data = await clearSchedule(req.body);

    return res.status(200).json(new ApiResponse(200, data, "Switch date removed"));
});

export { handleHeroGet, handleSlideAdd, handleSlideUpdate, handleSlideDelete, handleOrder, handleScheduleSet, handleScheduleClear };
