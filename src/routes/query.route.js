import { Router } from "express";
import { handleNewQueryController } from "../controllers/query.controller.js";
import { queryValidate } from "../middlewares/queryValidate.middleware.js"
import { upload } from "../middlewares/multer.middleware.js";

const router = Router();

router.route("/new-query").post(upload.none(), queryValidate, handleNewQueryController);

export { router as queryRouter }