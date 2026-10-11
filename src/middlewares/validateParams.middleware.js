import { ApiError } from "../utils/ApiError.js";
import { validationErrors } from "../utils/validationErrors.js";

/**
 * Validates req.params against a zod schema. The parsed value is stored on
 * req.validatedParams. On failure responds 400 VALIDATION_FAILED with { field: [messages] }.
 *
 * The middleware carries `validates` and `schema` so tests can audit every route.
 */
const validateParams = (schema) => {
    const middleware = (req, res, next) => {
        const result = schema.safeParse(req.params ?? {});

        if (!result.success) {
            return next(
                new ApiError(400, "VALIDATION_FAILED", "Validation failed", validationErrors(result.error))
            );
        }

        req.validatedParams = result.data;
        next();
    };

    return Object.assign(middleware, { validates: "params", schema });
};

export { validateParams };
