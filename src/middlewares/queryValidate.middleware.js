import { validateBody } from "./validateBody.middleware.js";
import { querySchema } from "../validators/query.validator.js";

// POST /query/new-query body (multipart text fields). Unknown fields are a 400.
const queryValidate = validateBody(querySchema);

export { queryValidate };
