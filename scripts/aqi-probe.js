// Prints the RAW records data.gov.in returns for each AQI station, so the field names, the
// station names, the pollutant ids and the value format can be checked with your own eyes
// before anything is calculated from them.
//
//   npm run aqi:probe
//
// Needs DATA_GOV_API_KEY in .env. Read-only: nothing is stored. The API key is never printed.

import "dotenv/config";

import { config } from "../src/config/env.js";
import { AQI_STATIONS, AQI_SOURCE } from "../src/config/aqi.js";

// The probe waits longer than the job does (8 s), to see slow answers instead of cutting them off
const PROBE_TIMEOUT_MS = 40000;

const probe = async ({ city, station }) => {
    const url = new URL(AQI_SOURCE.url);
    url.searchParams.set("api-key", config.DATA_GOV_API_KEY);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(AQI_SOURCE.limit));
    url.searchParams.set("filters[station]", station);

    console.log(`\n=== ${city}: ${station} ===`);

    let response;
    try {
        const startedAt = Date.now();
        response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        console.log(`answered in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
    } catch (error) {
        console.log(`request failed: ${error?.name ?? "error"} (${error?.cause?.code ?? error?.message ?? ""})`);
        return { ok: false };
    }

    const text = await response.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        console.log(`HTTP ${response.status}, the answer is not JSON: ${text.slice(0, 200)}`);
        return { ok: false };
    }

    const records = Array.isArray(body.records) ? body.records : [];
    console.log(`HTTP ${response.status}, total=${body.total}, count=${body.count}, records returned=${records.length}`);
    if (body.message || body.error) console.log(`message: ${body.message ?? body.error}`);
    console.log(`field names of the answer: ${(body.field ?? []).map((f) => f.id ?? f.name).join(", ") || "(none listed)"}`);

    for (const record of records) console.log(JSON.stringify(record));

    const names = [...new Set(records.map((record) => record.station))];
    console.log(`station names returned: ${JSON.stringify(names)}`);
    console.log(names.length === 1 && names[0] === station ? "station name: exact match" : "station name: MISMATCH or no records");
    return { ok: true };
};

const main = async () => {
    for (const station of AQI_STATIONS) await probe(station);
};

main().catch((error) => {
    console.error(`\naqi-probe failed: ${error.message}`);
    process.exit(1);
});
