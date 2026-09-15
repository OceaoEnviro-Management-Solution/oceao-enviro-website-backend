import { handleNewQueryService } from "../services/query.services.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";

const handleNewQueryController = asyncHandler(async (req, res) => {

    await handleNewQueryService(req.body);

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                null,
                "Query received successfully"
            )
        );
});

export { handleNewQueryController };