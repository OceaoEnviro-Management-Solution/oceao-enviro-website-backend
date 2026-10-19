// Cloudinary storage for the homepage hero images.
//
//   uploadImage(buffer)        -> { publicId, url, width, height }   (folder oceao/hero; throws on failure)
//   deleteImage(publicId)      -> void                               (never throws: a failure is logged)
//   buildDeliveryUrl(publicId) -> the https link the website shows   (f_auto,q_auto,w_1920,c_limit)
//   setCloudinaryClient(fake)  tests put a fake client here; null puts the real one back
//
// The API secret stays inside the SDK configuration: it is never logged, put in an error message
// or returned. Failures are reported with a short fixed message and the public id only.

import { v2 as cloudinarySdk } from "cloudinary";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

export const HERO_FOLDER = "oceao/hero";
export const DELIVERY_TRANSFORMATION = "f_auto,q_auto,w_1920,c_limit";

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
