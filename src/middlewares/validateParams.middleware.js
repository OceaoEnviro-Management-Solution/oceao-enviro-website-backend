import { z } from "zod";
import { ApiError } from "../utils/ApiError.js";

/**
 * Validates req.params against a zod schema. The parsed value is stored on
 * req.validatedParams. On failure responds 400 VALIDATION_FAILED with { field: [messages] }.
 */
const validateParams = (schema) => (req, res, next) => {
    const result = schema.safeParse(req.params ?? {});

    if (!result.success) {
        return next(
            new ApiError(400, "VALIDATION_FAILED", "Validation failed", z.flattenError(result.error).fieldErrors)
        );
    }

    req.validatedParams = result.data;
    next();
};

export { validateParams };
