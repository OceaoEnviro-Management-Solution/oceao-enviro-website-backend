import { handleNewQueryService } from "../services/query.services.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import { ApiError } from "../utils/ApiError.js";

const handleNewQueryController = asyncHandler(async (req, res) => {
    const queryData = req.body;
    const result = await handleNewQueryService(queryData);
    if (!result) {
        throw new ApiError(500, "Internal Server Error");
    }

    return res.status(200).json(new ApiResponse(200, "Query Received Successfully", {}));

});
export { handleNewQueryController }