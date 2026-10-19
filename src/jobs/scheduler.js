// Background jobs. index.js starts them once MongoDB is connected; tests never import index.js,
// so nothing is scheduled while they run.

import cron from "node-cron";
import { AQI_SCHEDULE, AQI_TIMEZONE } from "../config/aqi.js";
import { refreshAqi } from "../services/aqi/readings.js";
import { logger } from "../utils/logger.js";

/**
 * Starts the AQI job: once right away, then at minute 15 of every hour (IST).
 * A run that is still going when the next one is due is skipped, never doubled.
 * @returns {() => void} stops the schedule
 */
export const startJobs = ({ schedule = cron.schedule, run = refreshAqi } = {}) => {
    let running = false;

    const runAqiJob = async () => {
        if (running) {
            logger.warn("AQI job skipped: the previous run is still going");
            return;
        }
        running = true;
        try {
            await run();
        } catch (error) {
            logger.error("AQI job failed", error);
        } finally {
            running = false;
        }
    };

    const task = schedule(AQI_SCHEDULE, runAqiJob, { timezone: AQI_TIMEZONE });
    runAqiJob();
    logger.info(`AQI job scheduled (${AQI_SCHEDULE} ${AQI_TIMEZONE}) and started`);

    return () => task.stop();
};
