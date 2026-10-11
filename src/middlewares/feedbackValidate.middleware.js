import { validateBody } from "./validateBody.middleware.js";
import { feedbackSchema } from "../validators/feedback.validator.js";

// POST /feedback/new-feedback text fields (the file is in req.file, not in the body).
const feedbackValidate = validateBody(feedbackSchema);

export { feedbackValidate };
