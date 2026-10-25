// Cloudinary storage for the homepage hero images and the job applicants' resumes.
//
//   uploadImage(buffer)        -> { publicId, url, width, height }   (folder oceao/hero; throws on failure)
//   deleteImage(publicId)      -> void                               (never throws: a failure is logged)
//   buildDeliveryUrl(publicId) -> the https link the website shows   (f_auto,q_auto,w_1920,c_limit)
//   uploadResume(buffer, applicationId, ext) -> { publicId, bytes }  (PRIVATE, folder oceao/resumes; throws)
//   deleteResume(publicId)     -> void                               (never throws: a failure is logged)
//   getResumeDownloadUrl(publicId) -> a signed download link that works for 5 minutes
//   setCloudinaryClient(fake)  tests put a fake client here; null puts the real one back
//
// Resumes are uploaded as resource_type "raw" with type "private": they have no public link at all.
// The only way to get one is getResumeDownloadUrl, which only admin routes call.
//
// The API secret stays inside the SDK configuration: it is never logged, put in an error message
// or returned. Failures are reported with a short fixed message and the public id only.

import { v2 as cloudinarySdk } from "cloudinary";
import { config } from "../config/env.js";
import { CAREERS } from "../config/careers.js";
import { logger } from "../utils/logger.js";

export const HERO_FOLDER = "oceao/hero";
export const DELIVERY_TRANSFORMATION = "f_auto,q_auto,w_1920,c_limit";
export const RESUME_FOLDER = CAREERS.resume.folder;
const RESUME_OPTIONS = Object.freeze({ resource_type: "raw", type: "private" });

// Only pictures are accepted; Cloudinary checks the real content, not just the file name.
const ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp"];

let override = null;
let configured = false;

// Whatever the SDK says, the account key and secret never reach a log line.
const scrub = (text) =>
    String(text ?? "")
        .replaceAll(config.CLOUDINARY_API_SECRET, "[redacted]")
        .replaceAll(config.CLOUDINARY_API_KEY, "[redacted]")
        .slice(0, 200);

/** Tests: use `fake` instead of Cloudinary (the shape of the SDK's `v2`: uploader.upload_stream / uploader.destroy). null restores it. */
export const setCloudinaryClient = (fake) => {
    override = fake ?? null;
};

const client = () => {
    if (override) return override;
    if (!configured) {
        cloudinarySdk.config({
            cloud_name: config.CLOUDINARY_CLOUD_NAME,
            api_key: config.CLOUDINARY_API_KEY,
            api_secret: config.CLOUDINARY_API_SECRET,
            secure: true,
        });
        configured = true;
    }
    return cloudinarySdk;
};

/**
 * Uploads one image to the hero folder.
 * @param {Buffer} buffer the file's bytes
 * @returns {Promise<{ publicId: string, url: string, width: number, height: number }>}
 * @throws {Error} "Image upload failed" when the file is not a usable image or Cloudinary fails
 */
export const uploadImage = (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return Promise.reject(new Error("Image upload failed: no image data"));
    }

    return new Promise((resolve, reject) => {
        const fail = (reason) => {
            logger.error("Cloudinary upload failed", { reason: scrub(reason) });
            reject(new Error("Image upload failed"));
        };

        let stream;
        try {
            stream = client().uploader.upload_stream(
                { folder: HERO_FOLDER, resource_type: "image", allowed_formats: ALLOWED_FORMATS },
                (error, result) => {
                    if (error || !result?.public_id || !result?.secure_url) {
                        return fail(error?.message ?? "no result");
                    }
                    resolve({
                        publicId: result.public_id,
                        url: result.secure_url,
                        width: result.width,
                        height: result.height,
                    });
                }
            );
            stream.end(buffer);
        } catch (error) {
            fail(error?.message ?? "upload could not start");
        }
    });
};

/**
 * Deletes one image. Never throws: Cloudinary being down must not break the caller's work, so a
 * failure is only logged (with the public id, which is not a secret). Anything outside the hero
 * folder is refused, so a wrong id can never delete another asset of the account.
 */
export const deleteImage = async (publicId) => {
    if (typeof publicId !== "string" || !publicId.startsWith(`${HERO_FOLDER}/`)) {
        logger.warn("Cloudinary delete skipped: not a hero image", { publicId: scrub(publicId) });
        return;
    }

    try {
        const outcome = await client().uploader.destroy(publicId, { resource_type: "image", invalidate: true });
        if (outcome?.result !== "ok" && outcome?.result !== "not found") {
            logger.warn("Cloudinary did not delete an image", { publicId, result: String(outcome?.result) });
        }
    } catch (error) {
        logger.error("Cloudinary delete failed", { publicId, reason: scrub(error?.message ?? "unknown") });
    }
};

/** The link the website uses for an image: HTTPS, best format and quality, at most 1920 px wide. */
export const buildDeliveryUrl = (publicId) => {
    const path = String(publicId).split("/").map(encodeURIComponent).join("/");
    return `https://res.cloudinary.com/${encodeURIComponent(config.CLOUDINARY_CLOUD_NAME)}/image/upload/${DELIVERY_TRANSFORMATION}/${path}`;
};

/**
 * Uploads one resume PRIVATELY: resource_type "raw", type "private", in the resumes folder, named
 * after the application ("OE-JA-251025-K7Q2.pdf"). Never overwrites an existing file.
 * @returns {Promise<{ publicId: string, bytes: number }>}
 * @throws {Error} "Resume upload failed"
 */
export const uploadResume = (buffer, applicationId, ext) => {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return Promise.reject(new Error("Resume upload failed: no file data"));
    }

    return new Promise((resolve, reject) => {
        const fail = (reason) => {
            logger.error("Cloudinary resume upload failed", { applicationId, reason: scrub(reason) });
            reject(new Error("Resume upload failed"));
        };

        try {
            const stream = client().uploader.upload_stream(
                { ...RESUME_OPTIONS, folder: RESUME_FOLDER, public_id: `${applicationId}.${ext}`, overwrite: false },
                (error, result) => {
                    if (error || !result?.public_id) return fail(error?.message ?? "no result");
                    resolve({ publicId: result.public_id, bytes: result.bytes ?? buffer.length });
                }
            );
            stream.end(buffer);
        } catch (error) {
            fail(error?.message ?? "upload could not start");
        }
    });
};

/**
 * Deletes one resume. Never throws (a failure is logged with the public id, which is not a secret).
 * Anything outside the resumes folder is refused.
 */
export const deleteResume = async (publicId) => {
    if (typeof publicId !== "string" || !publicId.startsWith(`${RESUME_FOLDER}/`)) {
        logger.warn("Cloudinary delete skipped: not a resume", { publicId: scrub(publicId) });
        return;
    }

    try {
        const outcome = await client().uploader.destroy(publicId, { ...RESUME_OPTIONS, invalidate: true });
        if (outcome?.result !== "ok" && outcome?.result !== "not found") {
            logger.warn("Cloudinary did not delete a resume", { publicId, result: String(outcome?.result) });
        }
    } catch (error) {
        logger.error("Cloudinary resume delete failed", { publicId, reason: scrub(error?.message ?? "unknown") });
    }
};

/**
 * A signed link that downloads the private resume as an attachment and stops working after
 * CAREERS.resume.downloadLinkMinutes (5). Only for admins: never stored, never on a public route.
 */
export const getResumeDownloadUrl = (publicId, now = new Date()) => {
    if (typeof publicId !== "string" || !publicId.startsWith(`${RESUME_FOLDER}/`)) {
        throw new Error("Not a resume");
    }
    const expiresAt = Math.floor(now.getTime() / 1000) + CAREERS.resume.downloadLinkMinutes * 60;
    return client().utils.private_download_url(publicId, "", { ...RESUME_OPTIONS, expires_at: expiresAt, attachment: true });
};
