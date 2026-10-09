import mongoose from "mongoose";
import { DB_NAME } from "../constant.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

const connectDB = async () => {
    const connectionInstance = await mongoose.connect(config.MONGODB_URI, {
        dbName: DB_NAME
    });

    logger.info(`MongoDB connected (host: ${connectionInstance.connection.host})`);
}

const disconnectDB = async () => {
    await mongoose.disconnect();
}

export default connectDB;
export { disconnectDB };
