// Station AQI from the readings of fetch.js.
//
// The data.gov.in feed does not publish concentrations: each pollutant's avg_value is already the
// CPCB sub-index (0-500) worked out from the 24 hour average (8 hour for CO and ozone). So there
// are no breakpoints to apply here. As in the CPCB National AQI, the station AQI is the highest
// sub-index, and the pollutant that produced it is the dominant one. Applying the breakpoint
// tables to these values again would treat a score as a concentration and give wrong results.

import { AQI_CATEGORIES, AQI_MIN_POLLUTANTS, AQI_POLLUTANTS } from "../../config/aqi.js";

const MAX_AQI = AQI_CATEGORIES.at(-1).max;
const PARTICULATES = ["PM2.5", "PM10"];

/** "Good" ... "Severe" for an AQI, or null when there is none. Anything above 500 is Severe. */
export const categoryFor = (aqi) => {
    if (!Number.isFinite(aqi) || aqi < 0) return null;
    return (AQI_CATEGORIES.find((category) => aqi <= category.max) ?? AQI_CATEGORIES.at(-1)).name;
};

/**
 * @param {Record<string, number>} subIndices pollutant id -> sub-index, as fetch.js returns them
 * @returns {{ aqi: number, category: string, dominantPollutant: string } | null}
 *   null when fewer than 3 pollutants are known, or neither PM2.5 nor PM10 is.
 */
export const calculateAqi = (subIndices) => {
    const known = AQI_POLLUTANTS.filter((id) => Number.isFinite(subIndices?.[id]) && subIndices[id] >= 0);

    if (known.length < AQI_MIN_POLLUTANTS) return null;
    if (!PARTICULATES.some((id) => known.includes(id))) return null;

    // The first pollutant in AQI_POLLUTANTS order wins a tie.
    const dominantPollutant = known.reduce((best, id) => (subIndices[id] > subIndices[best] ? id : best));
    const aqi = Math.min(MAX_AQI, Math.round(subIndices[dominantPollutant]));

    return { aqi, category: categoryFor(aqi), dominantPollutant };
};
