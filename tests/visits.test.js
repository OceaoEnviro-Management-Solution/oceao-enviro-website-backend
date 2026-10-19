import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
import {
    startTestEnv, stopTestEnv, resetState, getApp, rateLimiting,
    TEST_ADMIN_PASSWORD_HASH, TEST_ADMIN_JWT_SECRET,
} from "./helpers/setup.js";
import { VisitStat } from "../src/models/visitStat.model.js";
import { recordVisit, getTotal, getDaily } from "../src/services/visits.service.js";

const VISITS = "/api/v1/visits";
const TOTAL = "/api/v1/visits/total";
const ADMIN_VISITS = "/api/v1/admin/visits";

// Wed 14 Oct 2026, 10:30 IST
const NOW = "2026-10-14T05:00:00Z";
const TODAY = "2026-10-14";

const BROWSER =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const freezeTime = (iso = NOW) => mock.timers.enable({ apis: ["Date"], now: new Date(iso) });

const visit = (userAgent = BROWSER) => {
    const req = request(getApp()).post(VISITS);
    return userAgent === null ? req.unset("User-Agent") : req.set("User-Agent", userAgent);
};
const total = () => request(getApp()).get(TOTAL);

const passwordVersion = crypto.createHash("sha256").update(TEST_ADMIN_PASSWORD_HASH).digest("hex").slice(0, 12);
const sessionCookie = () =>
    `oe_admin=${jwt.sign({ sub: "admin", pwv: passwordVersion }, TEST_ADMIN_JWT_SECRET, { algorithm: "HS256", expiresIn: 3600 })}`;
const adminVisits = (query = "") => request(getApp()).get(`${ADMIN_VISITS}${query}`).set("Cookie", sessionCookie());

const totalDoc = () => VisitStat.findOne({ key: "total" }).lean();
const dayDoc = (date) => VisitStat.findOne({ key: "day", date }).lean();

describe("Visitor counter", () => {
    before(startTestEnv);
    after(stopTestEnv);
    beforeEach(resetState);
    afterEach(() => mock.timers.reset());

    describe("it starts at 0", () => {
        it("GET /visits/total on an empty database is 0 and creates nothing", async () => {
            const res = await total();

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.deepEqual(res.body.data, { total: 0 });
            assert.equal(await VisitStat.countDocuments(), 0, "reading never creates a document");
        });

        it("the admin view of an empty database is a total of 0 and a list of zeros", async () => {
            freezeTime();

            const res = await adminVisits("?days=3");

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, {
                total: 0,
                daily: [
                    { date: "2026-10-12", count: 0 },
                    { date: "2026-10-13", count: 0 },
                    { date: "2026-10-14", count: 0 },
                ],
            });
        });
    });

    describe("POST /visits", () => {
        it("a visit increments the total document and today's day document and returns { total }", async () => {
            freezeTime();

            const first = await visit();

            assert.equal(first.status, 200);
            assert.equal(first.body.success, true);
            assert.deepEqual(first.body.data, { total: 1 });
            assert.equal((await totalDoc()).count, 1);
            assert.equal((await dayDoc(TODAY)).count, 1);

            const second = await visit();

            assert.deepEqual(second.body.data, { total: 2 });
            assert.equal((await totalDoc()).count, 2);
            assert.equal((await dayDoc(TODAY)).count, 2);
            assert.equal(await VisitStat.countDocuments(), 2, "one total document and one day document");
        });

        it("the day is the IST day: 23:59 IST and 00:01 IST fall on different days", async () => {
            freezeTime("2026-10-14T18:29:30Z");   // 23:59:30 IST on 14 Oct
            await visit();
            mock.timers.reset();

            freezeTime("2026-10-14T18:30:30Z");   // 00:00:30 IST on 15 Oct
            await visit();

            assert.equal((await dayDoc("2026-10-14")).count, 1);
            assert.equal((await dayDoc("2026-10-15")).count, 1);
            assert.equal((await totalDoc()).count, 2);
        });

        it("20 parallel visits on an empty database give exactly +20 on both documents", async () => {
            freezeTime();

            const results = await Promise.all(Array.from({ length: 20 }, () => visit()));

            for (const res of results) {
                assert.equal(res.status, 200);
                assert.ok(Number.isInteger(res.body.data.total) && res.body.data.total >= 1 && res.body.data.total <= 20);
            }
            assert.equal((await totalDoc()).count, 20);
            assert.equal((await dayDoc(TODAY)).count, 20);
            assert.equal(await VisitStat.countDocuments(), 2, "the racing first inserts left one document each");

            await Promise.all(Array.from({ length: 20 }, () => visit()));

            assert.equal((await totalDoc()).count, 40);
            assert.equal((await dayDoc(TODAY)).count, 40);
            assert.deepEqual((await total()).body.data, { total: 40 });
        });

        it("recordVisit() 60 times in parallel on an empty database loses no count (first inserts race)", async () => {
            freezeTime();

            await Promise.all(Array.from({ length: 60 }, () => recordVisit()));

            assert.equal(await getTotal(), 60);
            assert.deepEqual((await getDaily(1)), [{ date: TODAY, count: 60 }]);
            assert.equal(await VisitStat.countDocuments(), 2);
        });

        it("real browsers are counted", async () => {
            const agents = [
                BROWSER,
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
                "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
            ];
            for (const agent of agents) assert.equal((await visit(agent)).status, 200);

            assert.equal((await totalDoc()).count, 3);
        });

        it("a bot User-Agent is not counted, but the total is still returned", async () => {
            await visit();   // one real visit so the total to compare with is 1
            const bots = [
                "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
                "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
                "Baiduspider/2.0",
                "Mozilla/5.0 (compatible; Yahoo! Slurp)",
                "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
                "WhatsApp/2.23 link preview",
                "Mozilla/5.0 AppleWebKit/537.36 HeadlessChrome/120.0.0.0 Safari/537.36",
                "MyCrawler/1.0",
                "SPIDER-TEST",
            ];

            for (const agent of bots) {
                const res = await visit(agent);

                assert.equal(res.status, 200, agent);
                assert.deepEqual(res.body.data, { total: 1 }, agent);
            }
            assert.equal((await totalDoc()).count, 1);
            assert.equal((await VisitStat.findOne({ key: "day" }).lean()).count, 1);
        });

        it("a missing or empty User-Agent is not counted either", async () => {
            for (const agent of [null, "", "   "]) {
                const res = await visit(agent);

                assert.equal(res.status, 200, JSON.stringify(agent));
                assert.deepEqual(res.body.data, { total: 0 }, JSON.stringify(agent));
            }
            assert.equal(await VisitStat.countDocuments(), 0);
        });

        it("takes no input: a body key is 400 and nothing is counted", async () => {
            const res = await visit().send({ extra: 1 });

            assert.equal(res.status, 400);
            assert.equal(res.body.code, "VALIDATION_FAILED");
            assert.equal(await VisitStat.countDocuments(), 0);
        });
    });

    describe("rate limit: 10 per hour per IP", () => {
        it("over the limit it answers 200 with the current total and counts nothing", async () => {
            freezeTime();
            rateLimiting.enable();

            for (let i = 1; i <= 10; i++) {
                const res = await visit();
                assert.equal(res.status, 200);
                assert.deepEqual(res.body.data, { total: i });
            }

            for (let i = 0; i < 3; i++) {
                const over = await visit();

                assert.equal(over.status, 200, "never an error, so the footer does not break");
                assert.equal(over.body.success, true);
                assert.deepEqual(over.body.data, { total: 10 });
                assert.equal(over.headers["retry-after"], undefined);
            }
            assert.equal((await totalDoc()).count, 10);
            assert.equal((await dayDoc(TODAY)).count, 10);
        });

        it("reading the total is not limited by it", async () => {
            rateLimiting.enable();
            for (let i = 0; i < 12; i++) await visit();

            for (let i = 0; i < 5; i++) assert.equal((await total()).status, 200);
        });
    });

    describe("GET /visits/total", () => {
        it("returns { total } cacheable for 60 seconds", async () => {
            await visit();
            await visit();

            const res = await total();

            assert.equal(res.status, 200);
            assert.deepEqual(res.body.data, { total: 2 });
            assert.equal(res.headers["cache-control"], "public, max-age=60");
        });

        it("takes no input: a query key is 400", async () => {
            const res = await request(getApp()).get(`${TOTAL}?x=1`);

            assert.equal(res.status, 400);
            assert.equal(res.body.code, "VALIDATION_FAILED");
        });
    });

    describe("GET /admin/visits", () => {
        it("needs an admin session", async () => {
            const res = await request(getApp()).get(ADMIN_VISITS);

            assert.equal(res.status, 401);
            assert.equal(res.body.code, "ADMIN_UNAUTHORIZED");
        });

        it("a forged or expired cookie is not a session", async () => {
            const forged = jwt.sign({ sub: "admin", pwv: passwordVersion }, "not-the-secret-0123456789-abcdefghijklmnop", { algorithm: "HS256" });

            const res = await request(getApp()).get(ADMIN_VISITS).set("Cookie", `oe_admin=${forged}`);

            assert.equal(res.status, 401);
        });

        it("returns { total, daily }: 30 days by default, oldest first, ending today", async () => {
            freezeTime();

            const res = await adminVisits();

            assert.equal(res.status, 200);
            const { total: sum, daily } = res.body.data;
            assert.equal(sum, 0);
            assert.equal(daily.length, 30);
            assert.equal(daily[0].date, "2026-09-15");
            assert.equal(daily.at(-1).date, TODAY);
            assert.deepEqual(daily.map((d) => d.date), [...daily.map((d) => d.date)].sort());
            assert.deepEqual(Object.keys(daily[0]), ["date", "count"]);
        });

        it("days with no visits appear with count 0, and stored days outside the range are left out", async () => {
            freezeTime();
            await VisitStat.create({ key: "day", date: "2026-10-10", count: 5 });
            await VisitStat.create({ key: "day", date: "2026-09-01", count: 9 });   // before the 30 day range
            await visit();
            await visit();

            const res = await adminVisits("?days=7");

            assert.equal(res.body.data.total, 2);
            assert.deepEqual(res.body.data.daily, [
                { date: "2026-10-08", count: 0 },
                { date: "2026-10-09", count: 0 },
                { date: "2026-10-10", count: 5 },
                { date: "2026-10-11", count: 0 },
                { date: "2026-10-12", count: 0 },
                { date: "2026-10-13", count: 0 },
                { date: "2026-10-14", count: 2 },
            ]);

            const wide = await adminVisits();
            assert.ok(!wide.body.data.daily.some((d) => d.date === "2026-09-01"));
        });

        it("the range runs across a month and a year end", async () => {
            freezeTime("2027-01-02T05:00:00Z");
            await VisitStat.create({ key: "day", date: "2026-12-31", count: 3 });

            const res = await adminVisits("?days=5");

            assert.deepEqual(res.body.data.daily, [
                { date: "2026-12-29", count: 0 },
                { date: "2026-12-30", count: 0 },
                { date: "2026-12-31", count: 3 },
                { date: "2027-01-01", count: 0 },
                { date: "2027-01-02", count: 0 },
            ]);
        });

        it("days=1 is today only and days=90 is the maximum", async () => {
            freezeTime();

            assert.equal((await adminVisits("?days=1")).body.data.daily.length, 1);
            const max = await adminVisits("?days=90");
            assert.equal(max.body.data.daily.length, 90);
            assert.equal(max.body.data.daily[0].date, "2026-07-17");
        });

        it("rejects days outside 1 to 90, text and repeated values with 400", async () => {
            for (const query of ["?days=0", "?days=91", "?days=abc", "?days=1.5", "?days=-1", "?days=", "?days=1e1", "?days=7&days=8"]) {
                const res = await adminVisits(query);

                assert.equal(res.status, 400, query);
                assert.equal(res.body.code, "VALIDATION_FAILED", query);
                assert.ok(res.body.errors.days, query);
            }
        });

        it("rejects an unknown query key", async () => {
            const res = await adminVisits("?days=7&debug=1");

            assert.equal(res.status, 400);
            assert.equal(res.body.errors.debug[0], "Unexpected field");
        });

        it("the total is the counter, not the sum of the days listed", async () => {
            freezeTime();
            for (let i = 0; i < 4; i++) await visit();

            const res = await adminVisits("?days=1");

            assert.equal(res.body.data.total, 4);
            assert.deepEqual(res.body.data.daily, [{ date: TODAY, count: 4 }]);
        });
    });
});
