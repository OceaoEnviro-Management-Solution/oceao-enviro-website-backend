import "dotenv/config";

import { config } from "./config/env.js"
import connectDB, { disconnectDB } from "./db/index.js"
import { app } from "./app.js"
import { emailConnectionVerify } from "./services/email/email.connections.js"
import { meetBootWarning } from "./services/googleCalendar.service.js"
import { logger } from "./utils/logger.js"

const SHUTDOWN_TIMEOUT_MS = 10000;

const start = async () => {
    try {
        await connectDB();
    } catch (error) {
        logger.error("MongoDB connection failed", error);
        process.exit(1);
    }

    const meetWarning = meetBootWarning();
    if (meetWarning) {
        logger.warn(meetWarning);
    }

    const server = app.listen(config.PORT, (error) => {
        if (error) {
            logger.error("Unable to start the HTTP server", error);
            process.exit(1);
        }
        logger.info(`Server is running on port ${config.PORT} (EMAIL_MODE=${config.EMAIL_MODE})`);

        if (config.EMAIL_MODE === "smtp") {
            emailConnectionVerify();
        }
    });

    let shuttingDown = false;
    const shutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info(`${signal} received, shutting down`);

        setTimeout(() => {
            logger.error("Shutdown timed out, forcing exit");
            process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS).unref();

        server.close(async () => {
            try {
                await disconnectDB();
                logger.info("Shutdown complete");
                process.exit(0);
            } catch (error) {
                logger.error("Error while disconnecting MongoDB", error);
                process.exit(1);
            }
        });
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start();
