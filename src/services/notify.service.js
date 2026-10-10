// Booking emails. One function per event; each builds the email, sends it, and
// catches and logs any failure.
//
// Failure policy:
//   - Every notify* function NEVER throws and never rejects, so callers can fire them
//     without awaiting (a booking must not fail because an email did).
//   - sendOtpEmail is the one exception: with no code delivered the customer cannot
//     continue, so it throws ApiError 502 EMAIL_SEND_FAILED.
//   - Logs carry an email name and a booking/request ID, never addresses, codes or bodies.

import { config } from "../config/env.js";
import { ApiError } from "../utils/ApiError.js";
import { logger } from "../utils/logger.js";
import { sendMailService } from "./email/email.services.js";
import {
    otpCodeTemplate,
    vmConfirmationCustomerTemplate,
    vmNotificationCompanyTemplate,
    vmCancellationCustomerTemplate,
    vmMeetLinkFollowupTemplate,
    callbackConfirmationCustomerTemplate,
    callbackNotificationCompanyTemplate,
    callbackCancellationCustomerTemplate,
} from "./email/templates/booking/index.js";

const toPlain = (doc) => (doc && typeof doc.toObject === "function" ? doc.toObject() : doc);

const failureReason = (error) => error?.code || error?.name || "unknown";

const send = ({ to, replyTo, template }) =>
    sendMailService({
        from: config.MAIL_FROM,
        to,
        replyTo,
        subject: template.subject,
        text: template.text,
        html: template.html,
    });

/**
 * Runs the given sends in order. Each one is independent: if one fails the next still
 * goes out. Resolves with which emails were sent and which failed; never rejects.
 *
 * @param {string} event   notify function name, for logs
 * @param {string} id      bookingId or requestId, for logs
 * @param {Array<{ name: string, build: () => Promise<unknown> }>} steps
 */
const runSteps = async (event, id, steps) => {
    const result = { sent: [], failed: [] };

    for (const { name, build } of steps) {
        try {
            await build();
            result.sent.push(name);
        } catch (error) {
            result.failed.push(name);
            logger.error(`Email not sent: ${name}`, { event, id, reason: failureReason(error) });
        }
    }
    return result;
};

// Guards against a malformed argument (e.g. undefined) so the "never throws" promise holds.
const safely = async (event, id, buildSteps) => {
    try {
        return await runSteps(event, id, buildSteps());
    } catch (error) {
        logger.error(`Notification failed: ${event}`, { id, reason: failureReason(error) });
        return { sent: [], failed: [event] };
    }
};

/** The OTP email. Throws ApiError 502 EMAIL_SEND_FAILED if it cannot be sent. */
const sendOtpEmail = async ({ email, code }) => {
    try {
        await send({ to: email, template: otpCodeTemplate({ code }) });
    } catch (error) {
        logger.error("OTP email could not be sent", { reason: failureReason(error) });
        throw new ApiError(
            502,
            "EMAIL_SEND_FAILED",
            "We could not send the verification code. Please try again."
        );
    }
};

/** A VM booking was created: company notification (Reply-To the customer) and customer confirmation. */
const notifyVmBooked = (booking) => {
    const b = toPlain(booking);
    return safely("notifyVmBooked", b?.bookingId, () => [
        {
            name: "vmNotificationCompany",
            build: () => send({ to: config.COMPANY_MAIL, replyTo: b.email, template: vmNotificationCompanyTemplate(b) }),
        },
        {
            name: "vmConfirmationCustomer",
            build: () => send({ to: b.email, template: vmConfirmationCustomerTemplate(b) }),
        },
    ]);
};

/** Staff cancelled a VM booking: tell the customer (no internal reason). */
const notifyVmCancelled = (booking) => {
    const b = toPlain(booking);
    return safely("notifyVmCancelled", b?.bookingId, () => [
        {
            name: "vmCancellationCustomer",
            build: () => send({ to: b.email, template: vmCancellationCustomerTemplate(b) }),
        },
    ]);
};

/** Staff created the missing Meet link: send it to the customer. */
const notifyVmMeetLink = (booking) => {
    const b = toPlain(booking);
    return safely("notifyVmMeetLink", b?.bookingId, () => [
        {
            name: "vmMeetLinkFollowup",
            build: () => send({ to: b.email, template: vmMeetLinkFollowupTemplate(b) }),
        },
    ]);
};

/** A callback was requested: company notification (Reply-To the customer) and customer confirmation. */
const notifyCallbackRequested = (request) => {
    const r = toPlain(request);
    return safely("notifyCallbackRequested", r?.requestId, () => [
        {
            name: "callbackNotificationCompany",
            build: () => send({ to: config.COMPANY_MAIL, replyTo: r.email, template: callbackNotificationCompanyTemplate(r) }),
        },
        {
            name: "callbackConfirmationCustomer",
            build: () => send({ to: r.email, template: callbackConfirmationCustomerTemplate(r) }),
        },
    ]);
};

/** Staff cancelled a callback request: tell the customer (no internal reason). */
const notifyCallbackCancelled = (request) => {
    const r = toPlain(request);
    return safely("notifyCallbackCancelled", r?.requestId, () => [
        {
            name: "callbackCancellationCustomer",
            build: () => send({ to: r.email, template: callbackCancellationCustomerTemplate(r) }),
        },
    ]);
};

export {
    sendOtpEmail,
    notifyVmBooked,
    notifyVmCancelled,
    notifyVmMeetLink,
    notifyCallbackRequested,
    notifyCallbackCancelled,
};
