import { asyncHandler } from "../utils/asyncHandler.js"
import { ApiError } from "../utils/ApiError.js";
import { querySchema } from "../validators/query.validator.js";

const queryValidate = asyncHandler(async (req, res, next) => {
    // const { name, email, mobileNumber, organisation, industry, source, subject, query } = req.body;
    // console.log(name, email, mobileNumber, organisation, industry, source, subject, query);
    // const queryData = {
    //     name: name,
    //     email: email,
    //     mobileNumber: mobileNumber,
    //     organisation: organisation,
    //     industry: industry,
    //     source: source,
    //     subject: subject,
    //     query: query
    // }
    const validationResult = querySchema.safeParse(req.body);
    if (!validationResult.success) {
        console.error("Zod Validation Errors:", validationResult.error.format());
        const errorMessages = validationResult.error.flatten().fieldErrors;
        return next(new ApiError(400, "Validation failed", errorMessages));
    }
    req.body = validationResult.data;
    next();
});

export { queryValidate };
