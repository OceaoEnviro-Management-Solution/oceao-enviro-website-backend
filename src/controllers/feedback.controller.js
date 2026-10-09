import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import { handleNewFeedbackService } from "../services/feedback.services.js";


const handleNewFeedbackController = asyncHandler(async (req, res) => {

    await handleNewFeedbackService({ ...req.body, attachment: req.file });

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                null,
                "Feedback received successfully"
            )
        );
});

export { handleNewFeedbackController };