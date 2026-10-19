import { Router } from "express";
import { handleRecordVisit, handleGetTotal } from "../controllers/visits.controller.js";
import { validateBody } from "../middlewares/validateBody.middleware.js";
import { validateQuery } from "../middlewares/validateQuery.middleware.js";
import { visitLimiter } from "../middlewares/rateLimit.js";
import { noInputSchema } from "../validators/common.js";

const router = Router();

// Neither route takes any input: a body or query key is a 400.
router.post("/", visitLimiter, validateBody(noInputSchema), handleRecordVisit);
router.get("/total", validateQuery(noInputSchema), handleGetTotal);

export { router as visitsRouter };
