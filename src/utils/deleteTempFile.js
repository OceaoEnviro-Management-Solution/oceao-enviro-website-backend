import fs from "fs/promises";
import { logger } from "./logger.js";

const deleteTempFile = async (filePath) => {
    if (!filePath) return;
    try {
        await fs.unlink(filePath);
        return;
    } catch (error) {
        logger.error("Error deleting temporary file", error);
        return;
    }
}

export { deleteTempFile };