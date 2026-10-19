import { Router } from "express";
import { handleGetHero } from "../controllers/hero.controller.js";
import { validateQuery } from "../middlewares/validateQuery.middleware.js";
import { noInputSchema } from "../validators/common.js";

const router = Router();

// Takes no input: a query key is a 400.
router.get("/", validateQuery(noInputSchema), handleGetHero);

export { router as heroRouter };
