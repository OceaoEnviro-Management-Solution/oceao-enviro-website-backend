import { runWithRequestId } from "./requestContext.js";

// Handlers run inside the request context, so everything they log (and everything they start
// without awaiting) carries the request ID even after multer or a body parser.
const asyncHandler = (requestHandler) => {
    return (req, res, next) => {
        runWithRequestId(req.id, () => {
            Promise.resolve(requestHandler(req, res, next)).catch((error) =>
                next(error)
            );
        });
    };
};

export { asyncHandler };
