// Stores and serves the station readings.
//
//   refreshAqi()      the hourly job: reads every station, works out its AQI, stores it
//   getAqiStations()  what GET /aqi answers, always the configured stations in the configured order

import { AQI_STALE_AFTER_HOURS, AQI_STATIONS } from "../../config/aqi.js";
import { AqiReading } from "../../models/aqiReading.model.js";
import { logger } from "../../utils/logger.js";
import { calculateAqi } from "./calculate.js";
import { fetchAllStations } from "./fetch.js";

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Reads every station once and stores each result. A station that could not be read (or stored)
 * keeps its previous reading untouched. A station that was read but has too little data for an
 * AQI is stored with aqi null, so the website never shows an old number under a new time.
 * Never throws.
 * @returns {Promise<{ updated: number, failed: number }>}
 */
export const refreshAqi = async ({ fetchOptions = {}, now = new Date() } = {}) => {
    const results = await fetchAllStations(fetchOptions);
    let updated = 0;
    let failed = 0;

    for (const result of results) {
        if (!result.ok) {
            failed++;
            continue;
        }

        const { city, station, sourceLastUpdate, pollutants } = result;
        const calculated = calculateAqi(pollutants);

        try {
            await AqiReading.updateOne(
                { station },
                {
                    $set: {
                        city,
                        aqi: calculated?.aqi ?? null,
                        category: calculated?.category ?? null,
                        dominantPollutant: calculated?.dominantPollutant ?? null,
                        sourceLastUpdate,
                        fetchedAt: now,
                    },
                },
                { upsert: true, runValidators: true }
            );
            updated++;
        } catch (error) {
            failed++;
            logger.error("AQI reading could not be stored", { station }, error);
        }
    }

    logger.info(`AQI refreshed: ${updated} stored, ${failed} kept their previous reading`);
    return { updated, failed };
};

/**
 * The four stations as GET /aqi shows them. A station that has never been stored still appears,
 * with null values and stale true.
 */
export const getAqiStations = async ({ now = new Date() } = {}) => {
    const stored = await AqiReading.find({ station: { $in: AQI_STATIONS.map((target) => target.station) } }).lean();
    const byStation = new Map(stored.map((reading) => [reading.station, reading]));
    const staleBefore = now.getTime() - AQI_STALE_AFTER_HOURS * MS_PER_HOUR;

    return AQI_STATIONS.map(({ city, station }) => {
        const reading = byStation.get(station);
        const sourceLastUpdate = reading?.sourceLastUpdate ?? null;

        return {
            city,
            station,
            aqi: reading?.aqi ?? null,
            category: reading?.category ?? null,
            sourceLastUpdate,
            stale: sourceLastUpdate === null || sourceLastUpdate.getTime() < staleBefore,
        };
    });
};
