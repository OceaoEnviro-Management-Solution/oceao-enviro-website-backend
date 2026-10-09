import multer from "multer"
import { fileTypeFromBuffer } from "file-type"
import { ApiError } from "../utils/ApiError.js"
import { asyncHandler } from "../utils/asyncHandler.js"

const INVALID_FILE_MESSAGE = "Invalid file type. Only PDF, JPG, JPEG and PNG files are allowed.";

const allowedMimeTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png"
];

const fileFilter = (req, file, cb) => {
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new ApiError(400, "INVALID_FILE_TYPE", INVALID_FILE_MESSAGE), false);
  }
};

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,   // 5 MB
    files: 1,
    fields: 10,
    fieldSize: 10 * 1024         // 10 KB
  },
  fileFilter: fileFilter,
})

// Runs after multer: the declared mimetype is client-controlled, so check the real type from the bytes.
// Sets req.file.detectedExt ("pdf" | "jpg" | "png") for the caller.
export const verifyFileType = asyncHandler(async (req, res, next) => {
  if (!req.file) return next();

  const detected = await fileTypeFromBuffer(req.file.buffer);

  if (!detected || !allowedMimeTypes.includes(detected.mime) || detected.mime !== req.file.mimetype) {
    throw new ApiError(400, "INVALID_FILE_TYPE", INVALID_FILE_MESSAGE);
  }

  req.file.detectedExt = detected.ext;
  next();
});
