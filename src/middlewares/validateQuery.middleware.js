import { z } from "zod";
import { ApiError } from "../utils/ApiError.js";

/**
 * Validates req.query against a zod schema. The parsed value is stored on
 * req.validatedQuery (Express 5 makes req.query read-only). On failure responds
 * 400 VALIDATION_FAILED with { field: [messages] }.
 */
const validateQuery = (schema) => (req, res, next) => {
    const result = schema.safeParse(req.query ?? {});

    if (!result.success) {
        return next(
            new ApiError(400, "VALIDATION_FAILED", "Validation failed", z.flattenError(result.error).fieldErrors)
        );
    }

    req.validatedQuery = result.data;
    next();
};

export { validateQuery };
