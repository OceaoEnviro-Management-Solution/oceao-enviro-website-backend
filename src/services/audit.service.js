// Audit trail for admin writes (AGENT_CONTEXT.md section 12): one entry per write.
//
// recordAudit is called AFTER the change it describes has been saved. It never throws: the
// admin's action has already happened, so a failed audit write is logged loudly (with the
// action and target, never the request body) instead of turning a done action into an error.

import { BOOKING } from "../config/booking.js";
import { AuditLog } from "../models/auditLog.model.js";
import { logger } from "../utils/logger.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * @param {{ action: string, targetType: string, targetId: string, date?: string,
 *           detail?: object, performedBy: string, reason?: string }} entry
 * @param {{ now?: Date }} [options] pass `now` to freeze time in tests
 * @returns {Promise<boolean>} true when the entry was saved
 */
const recordAudit = async (entry, { now = new Date() } = {}) => {
    try {
        await AuditLog.create({
            ...entry,
            expireAt: new Date(now.getTime() + BOOKING.auditRetentionDays * MS_PER_DAY),
        });
        return true;
    } catch (error) {
        logger.error("Audit entry could not be saved", {
            action: entry?.action,
            targetType: entry?.targetType,
            targetId: entry?.targetId,
            reason: error?.code ?? error?.name ?? "unknown",
        });
        return false;
    }
};

export { recordAudit };
