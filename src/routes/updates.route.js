import { Router } from "express";
import { handleLatestUpdates, handleUpdates } from "../controllers/updates.controller.js";
import { validateQuery } from "../middlewares/validateQuery.middleware.js";
import { noInputSchema } from "../validators/common.js";
import { updatesQuerySchema } from "../validators/updates.validator.js";

const router = Router();

router.get("/latest", validateQuery(noInputSchema), handleLatestUpdates);
router.get("/", validateQuery(updatesQuerySchema), handleUpdates);

export { router as updatesRouter };
