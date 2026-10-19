// Fetches the latest CPCB air quality readings of the configured stations from data.gov.in.
//
// One request per station (filters[station]=<exact name>, 8 second timeout each). A request
// never throws: a station that could not be read comes back as { ok: false, reason } so the job
// can keep that station's previous reading. Values the source marks "NA" are treated as missing.
//
// The API key travels only in the request URL. It is never logged, put in an error message or
// returned: failures are reported as a short reason code.

import { config } from "../../config/env.js";
import { AQI_SOURCE, AQI_STATIONS } from "../../config/aqi.js";
import { logger } from "../../utils/logger.js";
import { isValidDateKey, istToDate } from "../../utils/time.js";

// The source's pollutant ids -> the ids used inside this service. Anything else is ignored.
const POLLUTANT_IDS = Object.freeze({
    "PM2.5": "PM2.5",
    PM10: "PM10",
    NO2: "NO2",
    SO2: "SO2",
    CO: "CO",
    OZONE: "O3",
    NH3: "NH3",
});

const LAST_UPDATE = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * "19-10-2026 21:00:00" (IST, as the source writes it) -> the real instant, or null.
 */
export const parseSourceTime = (text) => {
    const match = LAST_UPDATE.exec(typeof text === "string" ? text.trim() : "");
    if (!match) return null;

    const [, day, month, year, hours, minutes, seconds] = match;
    const dateKey = `${year}-${month}-${day}`;
    if (!isValidDateKey(dateKey) || Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) return null;

    return new Date(istToDate(dateKey, `${hours}:${minutes}`).getTime() + Number(seconds) * 1000);
};

/** The average of a record as a number, or null when the source has none ("NA", blank ...). */
export const parseValue = (raw) => {
    if (raw === null || raw === undefined) return null;
    const text = String(raw).trim();
    if (text === "" || /^na$/i.test(text)) return null;

    const value = Number(text);
    return Number.isFinite(value) && value >= 0 ? value : null;
};

const buildUrl = (station, apiKey) => {
    const url = new URL(AQI_SOURCE.url);
    url.searchParams.set("api-key", apiKey);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(AQI_SOURCE.limit));
    url.searchParams.set("filters[station]", station);
    return url;
};

const failed = ({ city, station }, reason) => {
    logger.warn("AQI station could not be read", { station, reason });
    return { city, station, ok: false, reason };
};

/**
 * Reads one station.
 * @returns {Promise<
 *   { city: string, station: string, ok: true, sourceLastUpdate: Date | null, pollutants: Record<string, number> } |
 *   { city: string, station: string, ok: false, reason: string }>}
 */
export const fetchStation = async (
    target,
    { fetchImpl = fetch, apiKey = config.DATA_GOV_API_KEY, timeoutMs = AQI_SOURCE.timeoutMs } = {}
) => {
    const { city, station } = target;

    let response;
    try {
        response = await fetchImpl(buildUrl(station, apiKey), { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        return failed(target, timedOut ? "timeout" : "network");
    }

    if (!response.ok) return failed(target, `http_${response.status}`);

    let body;
    try {
        body = await response.json();
    } catch {
        return failed(target, "bad_response");
    }

    if (!body || !Array.isArray(body.records)) return failed(target, "bad_response");

    // The filter is the source's job; matching the exact name here keeps a wrong row out anyway.
    const records = body.records.filter((record) => record?.station === station);
    if (records.length === 0) return failed(target, "no_records");

    const pollutants = {};
    let sourceLastUpdate = null;

    for (const record of records) {
        const id = POLLUTANT_IDS[record.pollutant_id];
        const value = parseValue(record.avg_value);
        if (id && value !== null) pollutants[id] = value;

        const updatedAt = parseSourceTime(record.last_update);
        if (updatedAt && (!sourceLastUpdate || updatedAt > sourceLastUpdate)) sourceLastUpdate = updatedAt;
    }

    return { city, station, ok: true, sourceLastUpdate, pollutants };
};

/** Reads every configured station in parallel, in the configured order. Never rejects. */
export const fetchAllStations = (options = {}) =>
    Promise.all(AQI_STATIONS.map((target) => fetchStation(target, options)));
