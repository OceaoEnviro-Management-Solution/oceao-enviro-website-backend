import { Router } from "express";
import { handleNewFeedbackController } from "../controllers/feedback.controller.js";
import { upload } from "../middlewares/multer.middleware.js";
import { feedbackValidate } from "../middlewares/feedbackValidate.middleware.js";

const router = Router();

router.route("/new-feedback").post(
    upload.single("attachment"),
    feedbackValidate,
    handleNewFeedbackController
);

export { router as feedbackRouter };