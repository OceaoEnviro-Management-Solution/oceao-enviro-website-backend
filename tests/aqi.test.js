// AQI tests: fetching, calculating, storing, the hourly job and GET /aqi.
// Nothing here touches the network: every fetch is a fake.

import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { startTestEnv, stopTestEnv, resetState, getApp } from "./helpers/setup.js";

const API_KEY = "secret-data-gov-key-1234567890";

let fetchStation;
let fetchAllStations;
let parseSourceTime;
let parseValue;
let AQI_STATIONS;
let calculateAqi;
let categoryFor;
let AqiReading;
let refreshAqi;
let getAqiStations;
let startJobs;

const record = (station, pollutant, avg, overrides = {}) => ({
    country: "India",
    state: "Delhi",
    city: "Delhi",
    station,
    last_update: "19-10-2026 21:00:00",
    latitude: "28.656756",
    longitude: "77.227234",
    pollutant_id: pollutant,
    min_value: "1",
    max_value: "999",
    avg_value: avg,
    ...overrides,
});

const answer = (records, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ message: "Resource lists", total: records.length, count: records.length, records }),
});

const CHANDNI = "Chandni Chowk, Delhi - IITM";
const TARGET = { city: "Delhi", station: CHANDNI };

describe("AQI", () => {
    before(async () => {
        await startTestEnv();
        ({ fetchStation, fetchAllStations, parseSourceTime, parseValue } = await import("../src/services/aqi/fetch.js"));
        ({ AQI_STATIONS } = await import("../src/config/aqi.js"));
        ({ calculateAqi, categoryFor } = await import("../src/services/aqi/calculate.js"));
        ({ AqiReading } = await import("../src/models/aqiReading.model.js"));
        ({ refreshAqi, getAqiStations } = await import("../src/services/aqi/readings.js"));
        ({ startJobs } = await import("../src/jobs/scheduler.js"));
    });
    after(stopTestEnv);
    afterEach(() => mock.restoreAll());

    describe("fetching: the stations", () => {
        it("are the four requested ones, in order, with the exact CPCB names", () => {
            assert.deepEqual(AQI_STATIONS.map(({ city, station }) => [city, station]), [
                ["Delhi", "Chandni Chowk, Delhi - IITM"],
                ["Ghaziabad", "Vasundhara, Ghaziabad - UPPCB"],
                ["Chandigarh", "Sector 22, Chandigarh - CPCC"],
                ["Gurugram", "Vikas Sadan, Gurugram - HSPCB"],
            ]);
        });
    });

    describe("the request", () => {
        it("asks for json, 50 records and the exact station, with the key as api-key", async () => {
            const seen = [];
            const fetchImpl = async (url, init) => {
                seen.push({ url: new URL(url), signal: init?.signal });
                return answer([record(CHANDNI, "PM2.5", "140")]);
            };

            await fetchStation(TARGET, { fetchImpl, apiKey: API_KEY });

            assert.equal(seen.length, 1);
            const { url, signal } = seen[0];
            assert.equal(url.origin + url.pathname, "https://api.data.gov.in/resource/3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69");
            assert.equal(url.searchParams.get("api-key"), API_KEY);
            assert.equal(url.searchParams.get("format"), "json");
            assert.equal(url.searchParams.get("limit"), "50");
            assert.equal(url.searchParams.get("filters[station]"), CHANDNI);
            assert.ok(signal instanceof AbortSignal, "every call carries a timeout signal");
        });

        it("gives up after the timeout (8 seconds in production) with reason timeout", async () => {
            const fetchImpl = (url, { signal }) =>
                new Promise((resolve, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason));
                });

            const result = await fetchStation(TARGET, { fetchImpl, apiKey: API_KEY, timeoutMs: 30 });

            assert.deepEqual(result, { city: "Delhi", station: CHANDNI, ok: false, reason: "timeout" });
        });

        it("the production timeout is 8 seconds", async () => {
            const { AQI_SOURCE } = await import("../src/config/aqi.js");

            assert.equal(AQI_SOURCE.timeoutMs, 8000);
        });
    });

    describe("the answer", () => {
        it("turns records into numbers per pollutant, with OZONE named O3", async () => {
            const fetchImpl = async () => answer([
                record(CHANDNI, "PM2.5", "140"),
                record(CHANDNI, "PM10", "204"),
                record(CHANDNI, "NO2", "47"),
                record(CHANDNI, "SO2", "12"),
                record(CHANDNI, "CO", "61"),
                record(CHANDNI, "NH3", "10"),
                record(CHANDNI, "OZONE", "18"),
            ]);

            const result = await fetchStation(TARGET, { fetchImpl, apiKey: API_KEY });

            assert.equal(result.ok, true);
            assert.deepEqual(result.pollutants, { "PM2.5": 140, PM10: 204, NO2: 47, SO2: 12, CO: 61, NH3: 10, O3: 18 });
        });

        it("treats NA, blank and unreadable values as missing", async () => {
            const fetchImpl = async () => answer([
                record(CHANDNI, "PM2.5", "140"),
                record(CHANDNI, "NH3", "NA"),
                record(CHANDNI, "SO2", "na"),
                record(CHANDNI, "NO2", ""),
                record(CHANDNI, "PM10", "abc"),
                record(CHANDNI, "CO", "-5"),
                record(CHANDNI, "OZONE", null),
            ]);

            const result = await fetchStation(TARGET, { fetchImpl, apiKey: API_KEY });

            assert.deepEqual(result.pollutants, { "PM2.5": 140 });
        });

        it("a value of 0 is a value, not a missing one", async () => {
            const fetchImpl = async () => answer([record(CHANDNI, "SO2", "0")]);

            const result = await fetchStation(TARGET, { fetchImpl, apiKey: API_KEY });

            assert.deepEqual(result.pollutants, { SO2: 0 });
        });

        it("reads last_update (IST, DD-MM-YYYY HH:mm:ss) as the right instant, using the newest record", async () => {
            const fetchImpl = async () => answer([
                record(CHANDNI, "PM2.5", "140", { last_update: "19-10-2026 20:00:00" }),
                record(CHANDNI, "PM10", "204", { last_update: "19-10-2026 21:00:00" }),
            ]);

            const result = await fetchStation(TARGET, { fetchImpl, apiKey: API_KEY });

            assert.equal(result.sourceLastUpdate.toISOString(), "2026-10-19T15:30:00.000Z");   // 21:00 IST
        });

        it("ignores pollutants it does not know and rows of another station", async () => {
            const fetchImpl = async () => answer([
                record(CHANDNI, "PM2.5", "140"),
                record(CHANDNI, "BENZENE", "3"),
                record("Somewhere Else, Delhi - DPCC", "PM10", "999"),
            ]);

            const result = await fetchStation(TARGET, { fetchImpl, apiKey: API_KEY });

            assert.deepEqual(result.pollutants, { "PM2.5": 140 });
        });
    });

    describe("failures never throw", () => {
        const cases = [
            ["an HTTP error", async () => answer([], 500), "http_500"],
            ["a rate limit", async () => answer([], 429), "http_429"],
            ["a network error", async () => { throw new TypeError("fetch failed"); }, "network"],
            ["an answer that is not JSON", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } }), "bad_response"],
            ["JSON without records", async () => ({ ok: true, status: 200, json: async () => ({ message: "x" }) }), "bad_response"],
            ["no records for the station", async () => answer([]), "no_records"],
            ["records of another station only", async () => answer([record("Other, Delhi - X", "PM10", "1")]), "no_records"],
        ];

        for (const [name, fetchImpl, reason] of cases) {
            it(`${name}: { ok: false, reason: "${reason}" }`, async () => {
                const result = await fetchStation(TARGET, { fetchImpl, apiKey: API_KEY });

                assert.deepEqual(result, { city: "Delhi", station: CHANDNI, ok: false, reason });
            });
        }
    });

    describe("the API key", () => {
        it("is never logged or returned, even when everything fails", async () => {
            const logged = [];
            for (const method of ["log", "info", "warn", "error"]) {
                mock.method(console, method, (...args) => logged.push(args.map(String).join(" ")));
            }
            const failures = [
                async () => { throw new TypeError(`fetch failed for https://api.data.gov.in/?api-key=${API_KEY}`); },
                async () => answer([], 500),
                async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(`bad ${API_KEY}`); } }),
            ];

            const results = [];
            for (const fetchImpl of failures) results.push(await fetchStation(TARGET, { fetchImpl, apiKey: API_KEY }));

            assert.ok(logged.length >= 3, "each failure is logged");
            assert.ok(!logged.join("\n").includes(API_KEY), `the key was logged:\n${logged.join("\n")}`);
            assert.ok(!JSON.stringify(results).includes(API_KEY));
        });
    });

    describe("fetchAllStations", () => {
        it("reads the four stations in order; one failing station does not affect the others", async () => {
            const names = AQI_STATIONS.map((s) => s.station);
            const fetchImpl = async (url) => {
                const station = new URL(url).searchParams.get("filters[station]");
                if (station === names[1]) throw new TypeError("fetch failed");
                return answer([record(station, "PM2.5", "100")]);
            };

            const results = await fetchAllStations({ fetchImpl, apiKey: API_KEY });

            assert.deepEqual(results.map((r) => r.station), names);
            assert.deepEqual(results.map((r) => r.ok), [true, false, true, true]);
            assert.equal(results[1].reason, "network");
            assert.deepEqual(results[0].pollutants, { "PM2.5": 100 });
        });
    });

    describe("parsers", () => {
        it("parseSourceTime accepts the source format only", () => {
            assert.equal(parseSourceTime("01-01-2027 00:00:00").toISOString(), "2026-12-31T18:30:00.000Z");
            assert.equal(parseSourceTime("31-12-2026 23:59:59").toISOString(), "2026-12-31T18:29:59.000Z");
            for (const bad of ["2026-10-19 21:00:00", "19-10-2026", "31-02-2026 10:00:00", "19-10-2026 24:00:00", "", null, undefined, 5]) {
                assert.equal(parseSourceTime(bad), null, String(bad));
            }
        });

        it("parseValue", () => {
            assert.equal(parseValue("140"), 140);
            assert.equal(parseValue(" 12.5 "), 12.5);
            assert.equal(parseValue(0), 0);
            for (const bad of ["NA", "na", "", " ", "x", "-1", null, undefined, "Infinity"]) {
                assert.equal(parseValue(bad), null, String(bad));
            }
        });
    });

    describe("calculating the station AQI", () => {
        // The feed's values are CPCB sub-indices already, so the station AQI is the highest one.
        // These are the real readings of the four stations at 23:00 on 19 Oct 2026.
        const REAL = {
            Delhi: [{ O3: 15, "PM2.5": 141, PM10: 201, NH3: 9, SO2: 12, NO2: 40, CO: 81 }, 201, "Poor", "PM10"],
            Ghaziabad: [{ "PM2.5": 175, PM10: 199, NH3: 6, NO2: 73, SO2: 17, O3: 34, CO: 59 }, 199, "Moderate", "PM10"],
            Chandigarh: [{ "PM2.5": 32, CO: 34, PM10: 39, NH3: 7, NO2: 11, SO2: 6, O3: 67 }, 67, "Satisfactory", "O3"],
            Gurugram: [{ SO2: 17, CO: 32, O3: 11, PM10: 126, "PM2.5": 143, NO2: 6 }, 143, "Moderate", "PM2.5"],
        };

        it("is the highest sub-index and names the pollutant that produced it", () => {
            assert.deepEqual(
                calculateAqi({ "PM2.5": 140, PM10: 204, NO2: 47, SO2: 12, CO: 61, NH3: 10, O3: 18 }),
                { aqi: 204, category: "Poor", dominantPollutant: "PM10" }
            );
        });

        for (const [city, [values, aqi, category, dominantPollutant]] of Object.entries(REAL)) {
            it(`${city}: the real 19 Oct 23:00 reading gives ${aqi} ${category}`, () => {
                assert.deepEqual(calculateAqi(values), { aqi, category, dominantPollutant });
            });
        }

        it("uses the feed's values as they are: they are not converted a second time", () => {
            // As a concentration, PM2.5 31 would be sub-index 51. As the sub-index it is, it stays 31.
            assert.deepEqual(calculateAqi({ "PM2.5": 31, PM10: 20, NO2: 10 }), { aqi: 31, category: "Good", dominantPollutant: "PM2.5" });
            assert.equal(calculateAqi({ "PM2.5": 30, PM10: 20, NO2: 10 }).aqi, 30);
        });

        it("a tie goes to the first pollutant in the order PM2.5, PM10, NO2, O3, CO, SO2, NH3", () => {
            assert.equal(calculateAqi({ NH3: 80, PM10: 80, "PM2.5": 80 }).dominantPollutant, "PM2.5");
            assert.equal(calculateAqi({ NH3: 80, PM10: 80, CO: 80 }).dominantPollutant, "PM10");
        });

        it("rounds to a whole number and never goes above 500", () => {
            assert.equal(calculateAqi({ PM10: 100.4, NO2: 1, CO: 1 }).aqi, 100);
            assert.equal(calculateAqi({ PM10: 100.5, NO2: 1, CO: 1 }).aqi, 101);
            assert.deepEqual(calculateAqi({ PM10: 742, NO2: 1, CO: 1 }), { aqi: 500, category: "Severe", dominantPollutant: "PM10" });
        });

        it("fewer than 3 pollutants is null", () => {
            assert.equal(calculateAqi({ PM10: 150, NO2: 40 }), null);
            assert.equal(calculateAqi({ PM10: 150 }), null);
            assert.equal(calculateAqi({}), null);
            assert.equal(calculateAqi(undefined), null);
            assert.notEqual(calculateAqi({ PM10: 150, NO2: 40, CO: 5 }), null, "3 is enough");
        });

        it("only the seven known pollutants and real numbers count towards the 3", () => {
            assert.equal(calculateAqi({ PM10: 150, NO2: 40, BENZENE: 99, NOX: 99 }), null);
            assert.equal(calculateAqi({ PM10: 150, NO2: 40, CO: Number.NaN, SO2: null, NH3: undefined, O3: -4 }), null);
        });

        it("without PM2.5 or PM10 it is null, however many other pollutants there are", () => {
            assert.equal(calculateAqi({ NO2: 40, O3: 60, CO: 70, SO2: 20, NH3: 10 }), null);
            assert.notEqual(calculateAqi({ "PM2.5": 20, O3: 60, CO: 70 }), null, "PM2.5 alone is enough");
            assert.notEqual(calculateAqi({ PM10: 20, O3: 60, CO: 70 }), null, "PM10 alone is enough");
        });

        it("the category edges: Good 0-50, Satisfactory 51-100, Moderate 101-200, Poor 201-300, Very Poor 301-400, Severe 401-500", () => {
            const expected = [
                [0, "Good"], [50, "Good"], [51, "Satisfactory"], [100, "Satisfactory"], [101, "Moderate"], [200, "Moderate"],
                [201, "Poor"], [300, "Poor"], [301, "Very Poor"], [400, "Very Poor"], [401, "Severe"], [500, "Severe"],
            ];
            for (const [aqi, category] of expected) {
                assert.equal(categoryFor(aqi), category, `categoryFor(${aqi})`);
                assert.equal(calculateAqi({ PM10: aqi, NO2: 0, CO: 0 }).category, category, `calculateAqi PM10 ${aqi}`);
            }
        });

        it("categoryFor of nothing is null", () => {
            for (const bad of [null, undefined, Number.NaN, -1, "50"]) assert.equal(categoryFor(bad), null, String(bad));
        });
    });

    describe("the stored reading (model)", () => {
        beforeEach(resetState);

        const doc = (overrides = {}) => ({
            city: "Delhi", station: CHANDNI, aqi: 201, category: "Poor", dominantPollutant: "PM10",
            sourceLastUpdate: new Date("2026-10-19T17:30:00Z"), fetchedAt: new Date("2026-10-19T18:00:00Z"), ...overrides,
        });

        it("has one document per station", async () => {
            await AqiReading.create(doc());

            await assert.rejects(AqiReading.create(doc({ aqi: 150 })), (error) => error.code === 11000);
            await AqiReading.create(doc({ city: "Ghaziabad", station: "Vasundhara, Ghaziabad - UPPCB" }));
            assert.equal(await AqiReading.countDocuments(), 2);
            assert.equal(AqiReading.collection.name, "aqi_readings");
        });

        it("accepts a reading without an AQI (null values)", async () => {
            const saved = await AqiReading.create(doc({ aqi: null, category: null, dominantPollutant: null, sourceLastUpdate: null }));

            assert.equal(saved.aqi, null);
            assert.equal(saved.category, null);
            assert.equal(saved.dominantPollutant, null);
        });

        it("refuses an AQI that is not a whole number from 0 to 500, an unknown category or pollutant", async () => {
            for (const bad of [{ aqi: 501 }, { aqi: -1 }, { aqi: 20.5 }, { category: "Terrible" }, { dominantPollutant: "Benzene" }, { fetchedAt: undefined }]) {
                await assert.rejects(AqiReading.create(doc(bad)), (error) => error.name === "ValidationError", JSON.stringify(bad));
            }
        });
    });

    describe("the hourly refresh", () => {
        beforeEach(resetState);
        afterEach(() => mock.restoreAll());

        const T1 = new Date("2026-10-19T18:00:00Z");
        const T2 = new Date("2026-10-19T19:00:00Z");

        const feedFor = (valuesByStation, lastUpdate = "19-10-2026 23:00:00") => async (url) => {
            const station = new URL(url).searchParams.get("filters[station]");
            const values = valuesByStation[station];
            if (values instanceof Error) throw values;
            return answer(Object.entries(values).map(([id, value]) =>
                record(station, id === "O3" ? "OZONE" : id, String(value), { last_update: lastUpdate })));
        };

        const GOOD = { "PM2.5": 100, PM10: 150, NO2: 30 };
        const everyStation = (values) => Object.fromEntries(AQI_STATIONS.map((s) => [s.station, values]));
        const quiet = () => { for (const method of ["log", "warn", "error"]) mock.method(console, method, () => {}); };
        const stored = (station) => AqiReading.findOne({ station }).lean();

        it("stores the four stations from the feed", async () => {
            quiet();

            const outcome = await refreshAqi({ fetchOptions: { fetchImpl: feedFor(everyStation(GOOD)), apiKey: API_KEY }, now: T1 });

            assert.deepEqual(outcome, { updated: 4, failed: 0 });
            assert.equal(await AqiReading.countDocuments(), 4);
            const delhi = await stored(CHANDNI);
            assert.equal(delhi.city, "Delhi");
            assert.equal(delhi.aqi, 150);
            assert.equal(delhi.category, "Moderate");
            assert.equal(delhi.dominantPollutant, "PM10");
            assert.equal(delhi.sourceLastUpdate.toISOString(), "2026-10-19T17:30:00.000Z");   // 23:00 IST
            assert.equal(delhi.fetchedAt.toISOString(), T1.toISOString());
        });

        it("the next run replaces each station's document instead of adding one", async () => {
            quiet();
            await refreshAqi({ fetchOptions: { fetchImpl: feedFor(everyStation(GOOD)), apiKey: API_KEY }, now: T1 });

            await refreshAqi({
                fetchOptions: { fetchImpl: feedFor(everyStation({ ...GOOD, PM10: 260 }), "20-10-2026 00:00:00"), apiKey: API_KEY },
                now: T2,
            });

            assert.equal(await AqiReading.countDocuments(), 4);
            const delhi = await stored(CHANDNI);
            assert.equal(delhi.aqi, 260);
            assert.equal(delhi.category, "Poor");
            assert.equal(delhi.fetchedAt.toISOString(), T2.toISOString());
            assert.equal(delhi.sourceLastUpdate.toISOString(), "2026-10-19T18:30:00.000Z");
        });

        it("a station that cannot be read keeps its previous reading; the others still update", async () => {
            quiet();
            await refreshAqi({ fetchOptions: { fetchImpl: feedFor(everyStation(GOOD)), apiKey: API_KEY }, now: T1 });
            const before = await stored(AQI_STATIONS[1].station);

            const outcome = await refreshAqi({
                fetchOptions: {
                    fetchImpl: feedFor({ ...everyStation({ ...GOOD, PM10: 260 }), [AQI_STATIONS[1].station]: new TypeError("fetch failed") }),
                    apiKey: API_KEY,
                },
                now: T2,
            });

            assert.deepEqual(outcome, { updated: 3, failed: 1 });
            assert.deepEqual(await stored(AQI_STATIONS[1].station), before, "unchanged, including fetchedAt");
            assert.equal((await stored(AQI_STATIONS[0].station)).aqi, 260);
        });

        it("a station that has never been read stays absent until it can be", async () => {
            quiet();

            await refreshAqi({
                fetchOptions: { fetchImpl: feedFor({ ...everyStation(GOOD), [AQI_STATIONS[2].station]: new TypeError("x") }), apiKey: API_KEY },
                now: T1,
            });

            assert.equal(await AqiReading.countDocuments(), 3);
            assert.equal(await stored(AQI_STATIONS[2].station), null);
        });

        it("when every station fails nothing changes and nothing throws", async () => {
            quiet();
            await refreshAqi({ fetchOptions: { fetchImpl: feedFor(everyStation(GOOD)), apiKey: API_KEY }, now: T1 });
            const before = await AqiReading.find().sort({ station: 1 }).lean();

            const outcome = await refreshAqi({
                fetchOptions: { fetchImpl: async () => { throw new TypeError("offline"); }, apiKey: API_KEY },
                now: T2,
            });

            assert.deepEqual(outcome, { updated: 0, failed: 4 });
            assert.deepEqual(await AqiReading.find().sort({ station: 1 }).lean(), before);
        });

        it("a station read with too little data is stored with no AQI, not left with an old number", async () => {
            quiet();
            await refreshAqi({ fetchOptions: { fetchImpl: feedFor(everyStation(GOOD)), apiKey: API_KEY }, now: T1 });

            await refreshAqi({
                fetchOptions: { fetchImpl: feedFor(everyStation({ PM10: 150, NO2: 30 }), "20-10-2026 00:00:00"), apiKey: API_KEY },
                now: T2,
            });

            const delhi = await stored(CHANDNI);
            assert.equal(delhi.aqi, null);
            assert.equal(delhi.category, null);
            assert.equal(delhi.dominantPollutant, null);
            assert.equal(delhi.sourceLastUpdate.toISOString(), "2026-10-19T18:30:00.000Z");
        });
    });

    describe("GET /api/v1/aqi", () => {
        beforeEach(resetState);

        const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000);
        const seed = (index, overrides = {}) => AqiReading.create({
            city: AQI_STATIONS[index].city, station: AQI_STATIONS[index].station,
            aqi: 120, category: "Moderate", dominantPollutant: "PM2.5",
            sourceLastUpdate: hoursAgo(1), fetchedAt: new Date(), ...overrides,
        });
        const get = (query = "") => request(getApp()).get(`/api/v1/aqi${query}`);

        it("answers the four stations in the configured order, in the documented shape", async () => {
            const sourceLastUpdate = hoursAgo(1);
            // stored in reverse order on purpose
            for (const index of [3, 2, 1, 0]) await seed(index, { aqi: 100 + index, sourceLastUpdate });

            const res = await get();

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.deepEqual(Object.keys(res.body.data), ["stations"]);
            assert.deepEqual(res.body.data.stations.map((s) => s.city), ["Delhi", "Ghaziabad", "Chandigarh", "Gurugram"]);
            assert.deepEqual(res.body.data.stations[1], {
                city: "Ghaziabad",
                station: "Vasundhara, Ghaziabad - UPPCB",
                aqi: 101,
                category: "Moderate",
                sourceLastUpdate: sourceLastUpdate.toISOString(),
                stale: false,
            });
            for (const station of res.body.data.stations) {
                assert.deepEqual(Object.keys(station), ["city", "station", "aqi", "category", "sourceLastUpdate", "stale"]);
            }
        });

        it("is cacheable for five minutes", async () => {
            const res = await get();

            assert.equal(res.headers["cache-control"], "public, max-age=300");
        });

        it("before the first run it still lists the four stations, empty and stale", async () => {
            const res = await get();

            assert.equal(res.status, 200);
            assert.equal(res.body.data.stations.length, 4);
            for (const station of res.body.data.stations) {
                assert.equal(station.aqi, null);
                assert.equal(station.category, null);
                assert.equal(station.sourceLastUpdate, null);
                assert.equal(station.stale, true);
            }
        });

        it("stale means the source time is more than 3 hours old", async () => {
            await seed(0, { sourceLastUpdate: hoursAgo(2.9) });
            await seed(1, { sourceLastUpdate: hoursAgo(3.1) });

            const res = await get();

            assert.equal(res.body.data.stations[0].stale, false);
            assert.equal(res.body.data.stations[1].stale, true);
        });

        it("the 3 hour limit itself is not yet stale", async () => {
            const now = new Date("2026-10-20T12:00:00Z");
            await seed(0, { sourceLastUpdate: new Date("2026-10-20T09:00:00Z") });
            await seed(1, { sourceLastUpdate: new Date("2026-10-20T08:59:59.999Z") });

            const stations = await getAqiStations({ now });

            assert.equal(stations[0].stale, false);
            assert.equal(stations[1].stale, true);
        });

        it("a station with no AQI shows nulls (and keeps its time)", async () => {
            await seed(0, { aqi: null, category: null, dominantPollutant: null });

            const res = await get();

            assert.equal(res.body.data.stations[0].aqi, null);
            assert.equal(res.body.data.stations[0].category, null);
            assert.equal(res.body.data.stations[0].stale, false);
        });

        it("never shows a station that is not configured", async () => {
            await seed(0);
            await AqiReading.create({ city: "Mumbai", station: "Somewhere, Mumbai - MPCB", aqi: 90, category: "Satisfactory", fetchedAt: new Date() });

            const res = await get();

            assert.deepEqual(res.body.data.stations.map((s) => s.city), ["Delhi", "Ghaziabad", "Chandigarh", "Gurugram"]);
        });

        it("takes no input: any query key is 400", async () => {
            const res = await get("?city=Delhi");

            assert.equal(res.status, 400);
            assert.equal(res.body.code, "VALIDATION_FAILED");
            assert.deepEqual(res.body.errors.city, ["Unexpected field"]);
        });
    });

    describe("the job schedule", () => {
        afterEach(() => mock.restoreAll());

        const quiet = () => { for (const method of ["log", "warn", "error"]) mock.method(console, method, () => {}); };
        const fakeCron = () => {
            const calls = [];
            const stop = mock.fn();
            const schedule = (expression, task, options) => { calls.push({ expression, task, options }); return { stop }; };
            return { calls, stop, schedule };
        };
        // The PARIVESH job (tested in parivesh.test.js) is switched off here: never the real network.
        const start = (options) => startJobs({ runParivesh: async () => {}, isPariveshDue: async () => false, ...options });
        const deferred = () => {
            let resolve;
            const promise = new Promise((done) => { resolve = done; });
            return { promise, resolve };
        };

        it("runs at minute 15 of every hour, on the Indian clock, and node-cron accepts the expression", async () => {
            quiet();
            const { calls, schedule } = fakeCron();

            start({ schedule, run: async () => {} });

            const aqi = calls.filter((call) => call.expression === "15 * * * *");
            assert.equal(aqi.length, 1);
            assert.deepEqual(aqi[0].options, { timezone: "Asia/Kolkata" });
            assert.equal((await import("node-cron")).default.validate("15 * * * *"), true);
        });

        it("also runs once at start-up, and again at each scheduled time", async () => {
            quiet();
            const { calls, schedule } = fakeCron();
            const run = mock.fn(async () => {});

            start({ schedule, run });
            assert.equal(run.mock.callCount(), 1, "at start-up");
            await new Promise((done) => setImmediate(done));   // let the start-up run finish

            await calls[0].task();
            await calls[0].task();
            assert.equal(run.mock.callCount(), 3);
        });

        it("skips a run while the previous one is still going", async () => {
            quiet();
            const { calls, schedule } = fakeCron();
            const slow = deferred();
            const run = mock.fn(() => slow.promise);

            start({ schedule, run });          // start-up run begins and is still going
            await calls[0].task();                 // the hourly tick arrives meanwhile
            assert.equal(run.mock.callCount(), 1);

            slow.resolve();
            await slow.promise;
            await new Promise((done) => setImmediate(done));
            await calls[0].task();
            assert.equal(run.mock.callCount(), 2, "runs again once the first has finished");
        });

        it("a run that throws is logged and the schedule carries on", async () => {
            quiet();
            const { calls, schedule } = fakeCron();
            const run = mock.fn(async () => { throw new Error("database gone"); });

            start({ schedule, run });
            await new Promise((done) => setImmediate(done));
            await calls[0].task();

            assert.equal(run.mock.callCount(), 2);
        });

        it("returns a function that stops the schedule", () => {
            quiet();
            const { schedule, stop } = fakeCron();

            const stopJobs = start({ schedule, run: async () => {} });
            stopJobs();

            assert.equal(stop.mock.callCount(), 2, "the AQI and the PARIVESH schedule");
        });

        it("only src/index.js starts the jobs, so tests (which load app.js) never schedule anything", async () => {
            const { readdirSync, readFileSync, statSync } = await import("node:fs");
            const { join } = await import("node:path");
            const root = new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
            const importers = [];
            const walk = (dir) => {
                for (const name of readdirSync(dir)) {
                    const path = join(dir, name);
                    if (statSync(path).isDirectory()) walk(path);
                    else if (/jobs\/scheduler\.js/.test(readFileSync(path, "utf8"))) importers.push(name);
                }
            };
            walk(decodeURIComponent(root));

            assert.deepEqual(importers, ["index.js"]);
        });
    });
});
