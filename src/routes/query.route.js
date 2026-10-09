import { Router } from "express";
import { handleNewQueryController } from "../controllers/query.controller.js";
import { queryValidate } from "../middlewares/queryValidate.middleware.js"
import { upload } from "../middlewares/multer.middleware.js";
import { publicFormLimiter } from "../middlewares/rateLimit.js";

const router = Router();

router.route("/new-query").post(
    publicFormLimiter,
    upload.none(),
    queryValidate,
    handleNewQueryController
);

export { router as queryRouter }