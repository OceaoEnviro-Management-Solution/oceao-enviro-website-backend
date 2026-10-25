import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import { ApiError } from "../utils/ApiError.js";
import { SECURITY } from "../config/security.js";
import { CAREERS } from "../config/careers.js";

const { resume } = CAREERS;

const INVALID_RESUME_MESSAGE = "Only PDF or Word (.docx) resumes are allowed.";
const TOO_LARGE_MESSAGE = `Resume is too large. Maximum size is ${resume.maxBytes / (1024 * 1024)} MB.`;

// No filter on the type the browser declares (browsers send .docx under several names): the real
// type is read from the bytes below. Browsers send file names as UTF-8, so a Hindi file name arrives intact.
const upload = multer({
    storage: multer.memoryStorage(),
    defParamCharset: "utf8",
    limits: {
        fileSize: resume.maxBytes,
        files: 1,
        fields: CAREERS.applyMaxFields,
        fieldSize: SECURITY.upload.maxFieldBytes,
    },
});

/**
 * POST /careers/jobs/:slug/apply: reads the multipart form (the file "resume" into memory as
 * req.file, the text fields into req.body), then checks the file's real type from its bytes: PDF or
 * DOCX only (400 INVALID_FILE_TYPE). Sets req.file.detectedExt ("pdf" | "docx"). Larger than 5 MB is
 * 413 FILE_TOO_LARGE. A missing resume is reported by requireResume, after the other fields.
 */
export const careersUpload = (req, res, next) => {
    upload.single(resume.field)(req, res, async (error) => {
        if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
            return next(new ApiError(413, "FILE_TOO_LARGE", TOO_LARGE_MESSAGE));
        }
        if (error) return next(error);
        if (!req.file) return next();

        try {
            const detected = await fileTypeFromBuffer(req.file.buffer);
            const ext = detected ? resume.allowedTypes[detected.mime] : undefined;
            if (!ext) return next(new ApiError(400, "INVALID_FILE_TYPE", INVALID_RESUME_MESSAGE));

            req.file.detectedExt = ext;
            next();
        } catch (sniffError) {
            next(sniffError);
        }
    });
};

/** After validation: the resume is required. */
export const requireResume = (req, res, next) => {
    if (!req.file) {
        return next(new ApiError(400, "VALIDATION_FAILED", "Validation failed", {
            resume: ["Please attach your resume (PDF or Word .docx, up to 5 MB)"],
        }));
    }
    next();
};
