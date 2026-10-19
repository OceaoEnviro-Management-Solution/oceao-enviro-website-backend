// PARIVESH "What's New": where the items come from, how often they are synced and how they are shown.
// Plain constants. The source needs no key.

export const PARIVESH = Object.freeze({
    // The whole list as one JSON array (no wrapper object, no paging)
    sourceUrl: "https://parivesh.nic.in/ua/parivesh/StatePortal/GetStatePortalData/ALL/",
    timeoutMs: 20000,

    // Documents are served from here. The feed's documentPath is a server path on their side
    // ("/opt/apache-tomcat.../webapps/publicdocument/..."); only the part from this marker on is public.
    siteOrigin: "https://parivesh.nic.in",
    documentMarker: "/publicdocument/",

    // node-cron: minute 5 of every 6th hour, Indian time (00:05, 06:05, 12:05, 18:05)
    schedule: "5 */6 * * *",
    timezone: "Asia/Kolkata",
    // At start-up a sync also runs when the last successful one is older than this
    syncEveryHours: 6,

    // POST /admin/updates/sync: at most one per this many minutes
    manualSyncCooldownMinutes: 5,

    // What the public endpoints show
    pageSize: 10,
    latestCount: 5,
    newWithinDays: 14,
});
