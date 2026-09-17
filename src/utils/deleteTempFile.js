import fs from "fs/promises";

const deleteTempFile = async (filePath) => {
    if (!filePath) return;
    try {
        await fs.unlink(filePath);
        return;
    } catch (error) {
        console.error("Error deleting temporary file:", error);
        return;
    }
}

export { deleteTempFile };