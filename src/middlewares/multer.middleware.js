// import express from "express"
import multer from "multer"

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "./public/temp")
  },
  filename: function (req, file, cb) {

    const extension =
      file.originalname.split(".").pop().toLowerCase();

    const filename =
      `${Date.now()}-${Math.round(Math.random() * 1E9)}.${extension}`;

    cb(null, filename);
  }
})

const allowedMimeTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png"
];

const fileFilter = (req, file, cb) => {

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        "Invalid file type. Only PDF, JPG, JPEG and PNG files are allowed."
      ),
      false
    );
  }
};

export const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024   // 5 MB
  },
  fileFilter: fileFilter,
})