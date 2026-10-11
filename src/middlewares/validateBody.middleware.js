import { ApiError } from "../utils/ApiError.js";
import { validationErrors } from "../utils/validationErrors.js";

/**
 * Validates req.body against a zod schema. On success req.body becomes the parsed value;
 * on failure responds 400 VALIDATION_FAILED with { field: [messages] }.
 *
 * The middleware carries `validates` and `schema` so tests can audit every route
 * (tests/security.test.js checks that each schema is .strict()).
 */
const validateBody = (schema) => {
    const middleware = (req, res, next) => {
        const result = schema.safeParse(req.body ?? {});

        if (!result.success) {
            return next(
                new ApiError(400, "VALIDATION_FAILED", "Validation failed", validationErrors(result.error))
            );
        }

        req.body = result.data;
        next();
    };

    return Object.assign(middleware, { validates: "body", schema });
};

export { validateBody };
