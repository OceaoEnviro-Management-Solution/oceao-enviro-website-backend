import { asyncHandler } from "../utils/asyncHandler.js"
import { ApiError } from "../utils/ApiError.js";
import { querySchema } from "../validators/query.validator.js";

const queryValidate = asyncHandler(async (req, res, next) => {
    const validationResult = querySchema.safeParse(req.body);

    if (!validationResult.success) {
        console.log(validationResult.error);
        throw new ApiError(400, "Validation failed", validationResult.error);
    }
    next();
});

export { queryValidate };
