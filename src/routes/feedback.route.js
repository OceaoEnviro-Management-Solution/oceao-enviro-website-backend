import { Router } from "express";
import { handleNewFeedbackController } from "../controllers/feedback.controller.js";
import { upload, verifyFileType } from "../middlewares/multer.middleware.js";
import { publicFormLimiter } from "../middlewares/rateLimit.js";
import { feedbackValidate } from "../middlewares/feedbackValidate.middleware.js";

const router = Router();

router.route("/new-feedback").post(
    publicFormLimiter,
    upload.single("attachment"),
    verifyFileType,
    feedbackValidate,
    handleNewFeedbackController
);

export { router as feedbackRouter };