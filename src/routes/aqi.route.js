import { Router } from "express";
import { handleGetAqi } from "../controllers/aqi.controller.js";
import { validateQuery } from "../middlewares/validateQuery.middleware.js";
import { noInputSchema } from "../validators/common.js";

const router = Router();

// Takes no input: a query key is a 400.
router.get("/", validateQuery(noInputSchema), handleGetAqi);

export { router as aqiRouter };
