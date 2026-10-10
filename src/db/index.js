import mongoose from "mongoose";
import { DB_NAME } from "../constant.js";
import { config } from "../config/env.js";
import { initModels } from "../models/index.js";
import { logger } from "../utils/logger.js";

const connectDB = async () => {
    const connectionInstance = await mongoose.connect(config.MONGODB_URI, {
        dbName: DB_NAME
    });

    logger.info(`MongoDB connected (host: ${connectionInstance.connection.host})`);

    // In development, build and wait for the unique and TTL indexes so a problem with
    // them stops the boot. Elsewhere mongoose's default autoIndex builds them in the background.
    if (config.NODE_ENV === "development") {
        await initModels();
        logger.info("Model indexes ready");
    }
}

const disconnectDB = async () => {
    await mongoose.disconnect();
}

export default connectDB;
export { disconnectDB };
