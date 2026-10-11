// Registry of every model. Importing this file registers them all with mongoose.

import { VmSlot } from "./vmSlot.model.js";
import { VmBooking } from "./vmBooking.model.js";
import { CallbackBucket } from "./callbackBucket.model.js";
import { CallbackRequest } from "./callbackRequest.model.js";
import { OtpChallenge } from "./otpChallenge.model.js";
import { Holiday } from "./holiday.model.js";
import { Settings } from "./settings.model.js";
import { AuditLog } from "./auditLog.model.js";

export const models = Object.freeze({
    VmSlot,
    VmBooking,
    CallbackBucket,
    CallbackRequest,
    OtpChallenge,
    Holiday,
    Settings,
    AuditLog,
});

/**
 * Builds every model's indexes (unique and TTL) and waits for them.
 * Needs an open connection. Creates missing indexes; never drops any.
 */
export const initModels = () => Promise.all(Object.values(models).map((model) => model.init()));

export { VmSlot, VmBooking, CallbackBucket, CallbackRequest, OtpChallenge, Holiday, Settings, AuditLog };
