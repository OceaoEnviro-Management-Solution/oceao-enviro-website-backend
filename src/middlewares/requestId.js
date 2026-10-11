import crypto from "node:crypto";
import { runWithRequestId } from "../utils/requestContext.js";

/**
 * First middleware. Gives every request a fresh crypto.randomUUID() as req.id and the
 * X-Request-Id response header. An incoming X-Request-Id is never trusted or echoed:
 * a client-chosen value could forge or poison log lines.
 */
const requestId = (req, res, next) => {
    req.id = crypto.randomUUID();
    res.setHeader("X-Request-Id", req.id);
    runWithRequestId(req.id, next);
};

/**
 * Enters the request context again after the body parsers, which resume on the HTTP
 * parser's async context and so lose it.
 */
const bindRequestContext = (req, res, next) => runWithRequestId(req.id, next);

export { requestId, bindRequestContext };
