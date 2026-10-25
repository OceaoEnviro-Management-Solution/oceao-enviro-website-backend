// General applications: a resume sent from the careers page without a job ("Don't see the right
// role?"). Nothing is stored and nothing is uploaded: the HR email (with the resume attached from
// memory) is the application. So that email is sent first and awaited; only when it went out is the
// candidate thanked, and a failure is reported to the candidate instead of being lost.

import { generateGeneralApplicationId } from "../../utils/ids.js";
import { nowIST } from "../../utils/time.js";
import { notifyGeneralApplicationCandidate, sendGeneralApplicationEmail } from "../notify.service.js";
import { sanitizeFileName } from "./applications.service.js";

/**
 * `fields` are the validated form fields (consent included), `file` is multer's memory file with
 * detectedExt set by careersUpload.
 * @returns {Promise<{ referenceId: string }>}
 * @throws {ApiError} 502 APPLICATION_SEND_FAILED when the HR email could not be sent
 */
export const sendGeneralApplication = async ({ consent, ...fields }, file, now = new Date()) => {
    const application = {
        ...fields,
        referenceId: generateGeneralApplicationId(nowIST(now).dateKey),
        submittedAt: now,
        consentAt: now,
        resume: { originalName: sanitizeFileName(file.originalname, file.detectedExt), sizeBytes: file.size, ext: file.detectedExt },
    };

    await sendGeneralApplicationEmail(application, file.buffer);
    notifyGeneralApplicationCandidate(application);

    return { referenceId: application.referenceId };
};
