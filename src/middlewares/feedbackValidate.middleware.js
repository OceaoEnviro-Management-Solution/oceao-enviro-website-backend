import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { feedbackSchema } from "../validators/feedback.validator.js";

const feedbackValidate = asyncHandler(async (req, res, next) => {
    const validationResult = feedbackSchema.safeParse(req.body);
    if (!validationResult.success) {
        console.error("Zod Validation Errors:", validationResult.error.format());
        await deleteTempFile(req.file?.path);
        const errorMessages = validationResult.error.flatten().fieldErrors;
        throw new ApiError(400, "Validation failed", errorMessages);
    }
    req.body = validationResult.data;
    next();
});

export { feedbackValidate };