import { z } from "zod";
import { ApiError } from "../utils/ApiError.js";

/**
 * Validates req.body against a zod schema. On success req.body becomes the parsed value;
 * on failure responds 400 VALIDATION_FAILED with { field: [messages] }.
 */
const validateBody = (schema) => (req, res, next) => {
    const result = schema.safeParse(req.body ?? {});

    if (!result.success) {
        return next(
            new ApiError(400, "VALIDATION_FAILED", "Validation failed", z.flattenError(result.error).fieldErrors)
        );
    }

    req.body = result.data;
    next();
};

export { validateBody };
