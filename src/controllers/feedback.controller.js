import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiRes.js";
import { handleNewFeedbackService } from "../services/feedback.services.js";
import { deleteTempFile } from "../utils/deleteTempFile.js";


const handleNewFeedbackController = asyncHandler(async (req, res) => {

    const feedbackData = req.body;
    const attachment = req.file;
    console.log(feedbackData);
    console.log("FILE BEFORE SERVICE:", attachment);

    try {
        await handleNewFeedbackService({ ...feedbackData, attachment });
    } catch (error) {
        throw error;
    } finally {
        console.log("CLEANUP PATH:", attachment?.path);

        await deleteTempFile(attachment?.path);

        console.log("CLEANUP FINISHED");
    }

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