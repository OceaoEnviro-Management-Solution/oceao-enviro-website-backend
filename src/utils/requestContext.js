// Carries the current request's ID to anything that logs while handling it, including work
// started without awaiting (emails, Calendar clean-up). The logger reads it from here.
//
// On some Node versions body parsers and multer resume on the HTTP parser's async context,
// which drops the store, so bindRequestContext (app.js) and asyncHandler enter it again from req.id.

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

/** Runs fn with `requestId` as the current request ID. */
const runWithRequestId = (requestId, fn) => (requestId ? storage.run({ requestId }, fn) : fn());

/** The ID of the request being handled, or undefined outside a request (startup, scripts). */
const getRequestId = () => storage.getStore()?.requestId;

export { runWithRequestId, getRequestId };
