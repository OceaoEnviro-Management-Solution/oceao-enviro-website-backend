// Air quality (AQI): the stations that are shown, where their readings come from and the timings.
// Plain constants. The API key is the only secret and lives in the environment
// (DATA_GOV_API_KEY, see config/env.js).
//
// Each station is matched by its exact CPCB station name (the `station` field of the data.gov.in
// records); the city is the label the website shows. Order here is the order of GET /aqi.

export const AQI_STATIONS = Object.freeze([
    Object.freeze({ city: "Delhi", station: "Chandni Chowk, Delhi - IITM" }),
    Object.freeze({ city: "Ghaziabad", station: "Vasundhara, Ghaziabad - UPPCB" }),
    Object.freeze({ city: "Chandigarh", station: "Sector 22, Chandigarh - CPCC" }),
    Object.freeze({ city: "Gurugram", station: "Vikas Sadan, Gurugram - HSPCB" }),
]);

export const AQI_SOURCE = Object.freeze({
    // "Real time Air Quality Index from various locations" (CPCB), data.gov.in
    url: "https://api.data.gov.in/resource/3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69",
    limit: 50,            // records per request: one station has about 8 pollutant records
    timeoutMs: 8000,      // per request
});

// node-cron expression: minute 15 of every hour (the source publishes at the top of the hour)
export const AQI_SCHEDULE = "15 * * * *";

// A reading whose source time is older than this is flagged stale in GET /aqi
export const AQI_STALE_AFTER_HOURS = 3;

// The pollutants that count toward a station's AQI (the ids used inside the service; the source
// calls ozone OZONE, see services/aqi/fetch.js). Order matters: it breaks ties, PM first.
export const AQI_POLLUTANTS = Object.freeze(["PM2.5", "PM10", "NO2", "O3", "CO", "SO2", "NH3"]);

// A station gets an AQI only from at least this many pollutants, one of them PM2.5 or PM10
export const AQI_MIN_POLLUTANTS = 3;

// CPCB National AQI categories: the highest AQI each one covers
export const AQI_CATEGORIES = Object.freeze([
    Object.freeze({ name: "Good", max: 50 }),
    Object.freeze({ name: "Satisfactory", max: 100 }),
    Object.freeze({ name: "Moderate", max: 200 }),
    Object.freeze({ name: "Poor", max: 300 }),
    Object.freeze({ name: "Very Poor", max: 400 }),
    Object.freeze({ name: "Severe", max: 500 }),
]);

// The schedule runs on the Indian clock, the same as the source's last_update times
export const AQI_TIMEZONE = "Asia/Kolkata";
