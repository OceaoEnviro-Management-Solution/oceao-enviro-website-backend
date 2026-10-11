import { ApiError } from "../utils/ApiError.js";
import { validationErrors } from "../utils/validationErrors.js";

/**
 * Validates req.query against a zod schema. The parsed value is stored on
 * req.validatedQuery (Express 5 makes req.query read-only). On failure responds
 * 400 VALIDATION_FAILED with { field: [messages] }.
 *
 * The middleware carries `validates` and `schema` so tests can audit every route.
 */
const validateQuery = (schema) => {
    const middleware = (req, res, next) => {
        const result = schema.safeParse(req.query ?? {});

        if (!result.success) {
            return next(
                new ApiError(400, "VALIDATION_FAILED", "Validation failed", validationErrors(result.error))
            );
        }

        req.validatedQuery = result.data;
        next();
    };

    return Object.assign(middleware, { validates: "query", schema });
};

export { validateQuery };
