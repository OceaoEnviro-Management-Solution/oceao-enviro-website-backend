import multer from "multer";
import { ZodError, z } from "zod";
import { ApiError } from "../utils/ApiError.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

const GENERIC_MESSAGE = "Something went wrong. Please try again later.";

const toErrorResponse = (err) => {
    if (err instanceof ApiError) {
        return { statusCode: err.statusCode, code: err.code, message: err.message, errors: err.errors };
    }
    if (err instanceof ZodError) {
        return {
            statusCode: 400,
            code: "VALIDATION_FAILED",
            message: "Validation failed",
            errors: z.flattenError(err).fieldErrors,
        };
    }
    if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
            return { statusCode: 413, code: "FILE_TOO_LARGE", message: "File is too large. Maximum size is 5 MB.", errors: {} };
        }
        return { statusCode: 400, code: "UPLOAD_ERROR", message: "File upload failed.", errors: {} };
    }
    if (err.type === "entity.parse.failed") {
        return { statusCode: 400, code: "INVALID_JSON", message: "Request body is not valid JSON.", errors: {} };
    }
    if (err.type === "entity.too.large") {
        return { statusCode: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body is too large.", errors: {} };
    }
    if (err.code === 11000) {
        return { statusCode: 409, code: "CONFLICT", message: "That record already exists.", errors: {} };
    }

    const status = Number(err.statusCode || err.status);
    const statusCode = status >= 400 && status <= 599 ? status : 500;
    return {
        statusCode,
        code: statusCode >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
        message: err.message || GENERIC_MESSAGE,
        errors: {},
    };
};

const notFoundHandler = (req, res, next) => {
    next(new ApiError(404, "NOT_FOUND", "Route not found."));
};

const errorHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);

    const { statusCode, code, message, errors } = toErrorResponse(err);

    if (statusCode >= 500) {
        logger.error(`${req.method} ${req.originalUrl.split("?")[0]} failed with ${statusCode}`, err);
    }

    const hideDetails = statusCode >= 500 && config.NODE_ENV === "production";

    return res.status(statusCode).json({
        success: false,
        message: hideDetails ? GENERIC_MESSAGE : message,
        code: hideDetails ? "INTERNAL_ERROR" : code,
        errors: hideDetails ? {} : errors,
    });
};

export {
    errorHandler,
    notFoundHandler
}
