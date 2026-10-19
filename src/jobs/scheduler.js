// Background jobs. index.js starts them once MongoDB is connected; tests never import index.js,
// so nothing is scheduled while they run.
//
//   AQI       once at start-up, then at minute 15 of every hour (IST)
//   PARIVESH  at minute 5 of every 6th hour (IST), and at start-up when the last good sync is
//             more than 6 hours old (so restarting the server does not hit PARIVESH every time)

import cron from "node-cron";
import { AQI_SCHEDULE, AQI_TIMEZONE } from "../config/aqi.js";
import { PARIVESH } from "../config/parivesh.js";
import { refreshAqi } from "../services/aqi/readings.js";
import { isSyncDue, syncParivesh } from "../services/parivesh/sync.js";
import { logger } from "../utils/logger.js";

// A run that is still going when the next one is due is skipped, never doubled; a run that
// throws is logged and the schedule carries on.
const guarded = (name, run) => {
    let running = false;

    return async () => {
        if (running) {
            logger.warn(`${name} job skipped: the previous run is still going`);
            return;
        }
        running = true;
        try {
            await run();
        } catch (error) {
            logger.error(`${name} job failed`, error);
        } finally {
            running = false;
        }
    };
};

/**
 * Starts the jobs.
 * @returns {() => void} stops the schedules
 */
export const startJobs = ({
    schedule = cron.schedule,
    run = refreshAqi,
    runParivesh = syncParivesh,
    isPariveshDue = isSyncDue,
} = {}) => {
    const runAqiJob = guarded("AQI", run);
    const aqiTask = schedule(AQI_SCHEDULE, runAqiJob, { timezone: AQI_TIMEZONE });
    runAqiJob();
    logger.info(`AQI job scheduled (${AQI_SCHEDULE} ${AQI_TIMEZONE}) and started`);

    const runPariveshJob = guarded("PARIVESH", runParivesh);
    const pariveshTask = schedule(PARIVESH.schedule, runPariveshJob, { timezone: PARIVESH.timezone });
    guarded("PARIVESH start-up check", async () => {
        if (await isPariveshDue()) await runPariveshJob();
    })();
    logger.info(`PARIVESH job scheduled (${PARIVESH.schedule} ${PARIVESH.timezone})`);

    return () => {
        aqiTask.stop();
        pariveshTask.stop();
    };
};
