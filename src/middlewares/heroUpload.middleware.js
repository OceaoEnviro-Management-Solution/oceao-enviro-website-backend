import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { SECURITY } from "../config/security.js";
import { HERO } from "../config/hero.js";

const INVALID_IMAGE_MESSAGE = "Invalid file type. Only JPG, PNG and WebP images are allowed.";
const TOO_LARGE_MESSAGE = `Image is too large. Maximum size is ${HERO.maxImageBytes / (1024 * 1024)} MB.`;

// First gate: the type the browser says. It is client-controlled, so verifyHeroImage checks the bytes.
const fileFilter = (req, file, cb) => {
    if (HERO.allowedMimeTypes.includes(file.mimetype)) return cb(null, true);
    cb(new ApiError(400, "INVALID_FILE_TYPE", INVALID_IMAGE_MESSAGE), false);
};

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: HERO.maxImageBytes,
        files: 1,
        fields: SECURITY.upload.maxFields,
        fieldSize: SECURITY.upload.maxFieldBytes,
    },
    fileFilter,
});

/** Reads one multipart file called "image" into memory (req.file) and the text fields into req.body. */
export const heroUpload = (req, res, next) => {
    upload.single("image")(req, res, (error) => {
        if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
            return next(new ApiError(413, "FILE_TOO_LARGE", TOO_LARGE_MESSAGE));
        }
        next(error);
    });
};

/** After heroUpload: an image must be there, and its real type (from the bytes) must be jpg, png or webp. */
export const verifyHeroImage = asyncHandler(async (req, res, next) => {
    if (!req.file) {
        throw new ApiError(400, "VALIDATION_FAILED", "Validation failed", { image: ["An image is required"] });
    }

    const detected = await fileTypeFromBuffer(req.file.buffer);
    if (!detected || !HERO.allowedMimeTypes.includes(detected.mime)) {
        throw new ApiError(400, "INVALID_FILE_TYPE", INVALID_IMAGE_MESSAGE);
    }

    next();
});
