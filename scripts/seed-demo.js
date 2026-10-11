// Fills a DEVELOPMENT database with demo VM bookings, VM slot blocks, callback requests and
// a few blocked callback periods over the next 7 working days, so the admin panel has
// something to show.
//
//   npm run seed:demo
//
// - Refuses to run unless NODE_ENV=development (it reads .env, so check that file).
// - Bookings and requests go through the same service functions the public API uses
//   (createVmBooking, createCallbackRequest), so every rule and the capacity counters apply.
// - Nothing leaves this machine: EMAIL_MODE is forced to "test" (an in-memory outbox) and the
//   Google credentials are removed before any service is loaded, so no real email is sent
//   and no calendar event is created. Every address ends in @example.com.
// - Safe to run again: anything that already exists is reported as skipped.
// - Blocks are written with the models directly, following AGENT_CONTEXT.md section 7,
//   because the block services arrive with the admin write endpoints.
//
// Demo data lives in the same collections as real data. Remove it by dropping the database
// or letting the retention (TTL) clean it up 30 days after each date.

import "dotenv/config";

import { pathToFileURL } from "node:url";

// ── What gets created (days are the next 7 working days, in order) ────────────

const DEMO_DOMAIN = "example.com";

// VM meetings: day index -> slot times to book.
const VM_PLAN = [
    ["10:00", "14:00"],
    ["12:00"],
    ["10:00", "12:00", "16:00"],
    ["14:00"],
    ["10:00", "16:00"],
    [],
    ["12:00", "14:00"],
];

// VM blocks made by staff: day index -> [{ time, by, reason }].
const VM_BLOCKS = {
    1: [{ time: "16:00", by: "Anita", reason: "Site visit" }],
    3: [{ time: "10:00", by: "Rohan", reason: "Internal training" }],
    5: ["10:00", "12:00", "14:00", "16:00"].map((time) => ({ time, by: "Anita", reason: "Office closed for audit" })),
};

// Callback requests: day index -> { period: how many }. Day 3 fills the evening (capacity 3).
const CALLBACK_PLAN = [
    { morning: 2, afternoon: 1 },
    { morning: 3, evening: 1 },
    { afternoon: 2 },
    { evening: 3 },
    { morning: 1, afternoon: 2, evening: 1 },
    {},
    {},
];

// Callback periods blocked by staff (existing requests stay): day index -> [{ period, by, reason }].
const CALLBACK_BLOCKS = {
    2: [{ period: "afternoon", by: "Rohan", reason: "Team meeting" }],
    5: ["morning", "afternoon", "evening"].map((period) => ({ period, by: "Anita", reason: "Office closed for audit" })),
    6: [{ period: "morning", by: "Rohan", reason: "Team offsite" }],
};

const PEOPLE = [
    ["Rahul Kumar", "ABC Industries Pvt Ltd", "Plant Head"],
    ["Priya Sharma", "GreenTech Solutions", "Sustainability Manager"],
    ["Amit Verma", "Verma Constructions", "Director"],
    ["Sneha Iyer", "Iyer Textiles", "EHS Officer"],
    ["Vikram Singh", "Singh Cement Works", "General Manager"],
    ["Neha Gupta", "Gupta Brick Kilns", "Owner"],
    ["Arjun Nair", "Nair Marine Foods", "Operations Head"],
    ["Kavita Joshi", "Joshi Pharma Ltd", "Quality Head"],
    ["Sanjay Mehta", "Mehta Steel Rolling", "Plant Manager"],
    ["Divya Reddy", "Reddy Power Projects", "Project Lead"],
    ["Manish Tiwari", "Tiwari Dairy Cooperative", "Secretary"],
    ["Pooja Bansal", "Bansal Paper Mills", "Technical Head"],
    ["Rakesh Yadav", "Yadav Infrastructure", "Site Engineer"],
    ["Anjali Desai", "Desai Chemicals", "Compliance Officer"],
    ["Suresh Pillai", "Pillai Estates", "Managing Partner"],
    ["Meera Kapoor", "Kapoor Hospitality", "Admin Manager"],
    ["Imran Khan", "Khan Leather Exports", "Director"],
    ["Ritu Malhotra", "Malhotra Hospitals", "Facility Head"],
    ["Deepak Chauhan", "Chauhan Mining Co", "Mine Manager"],
    ["Sunita Rao", "Rao Agro Processing", "Founder"],
    ["Harish Patel", "Patel Dyes and Pigments", "Plant Head"],
    ["Tanvi Shah", "Shah Real Estate", "Project Director"],
    ["Ashok Menon", "Menon Hydro Works", "Chief Engineer"],
    ["Farah Siddiqui", "Siddiqui Packaging", "Operations Manager"],
    ["Gaurav Saxena", "Saxena Auto Components", "EHS Head"],
    ["Lakshmi Narayan", "Narayan Sugar Mills", "Manager"],
    ["Mohit Arora", "Arora Warehousing", "Partner"],
    ["Shalini Bose", "Bose Tea Estates", "Estate Manager"],
    ["Karan Oberoi", "Oberoi Realty Services", "Head Projects"],
    ["Nandini Das", "Das Fisheries", "Proprietor"],
    ["Yash Thakur", "Thakur Granite Works", "Director"],
    ["Bhavna Kulkarni", "Kulkarni Distillery", "Plant In-charge"],
    ["Tarun Goel", "Goel Plastics", "Production Head"],
    ["Rekha Pandey", "Pandey Rice Mills", "Owner"],
    ["Vivek Agarwal", "Agarwal Fertilisers", "GM Operations"],
    ["Seema Chopra", "Chopra Garments", "Director"],
    ["Naveen Kumar", "Kumar Brickworks", "Proprietor"],
    ["Pallavi Jain", "Jain Hospitals Group", "Administrator"],
    ["Rohit Bhatia", "Bhatia Industrial Parks", "Estate Officer"],
    ["Alka Mishra", "Mishra Cold Storage", "Manager"],
];

const VM_TOPICS = [
    "EIA for a new unit",
    "Consent to Operate renewal",
    "Stack emission monitoring",
    "ETP design review",
    "Groundwater NOC",
    "Environmental audit",
    "Hazardous waste authorisation",
    "Water quality testing",
];

const CALLBACK_REASONS = [
    "Water testing quote",
    "Need help with CTE application",
    "Ambient air monitoring for our site",
    "Environmental clearance timeline",
    "STP commissioning support",
    "Annual environmental statement filing",
    "Noise survey for a new plant",
    "",
];

const personAt = (index) => {
    const [name, organisation, designation] = PEOPLE[index % PEOPLE.length];
    const slug = name.toLowerCase().replace(/[^a-z]+/g, ".");
    return {
        name,
        organisation,
        designation,
        email: `demo.${slug}${index >= PEOPLE.length ? `.${index}` : ""}@${DEMO_DOMAIN}`,
        mobileNumber: `+91${String(9876500100 + index)}`,
    };
};

const tally = () => ({ created: 0, skipped: 0 });

const main = async () => {
    if (process.env.NODE_ENV !== "development") {
        throw new Error(
            `seed:demo only runs with NODE_ENV=development (it is "${process.env.NODE_ENV ?? ""}"). ` +
            "Nothing was changed."
        );
    }

    // Nothing may leave this machine. Set before any service (and so the config) is loaded.
    process.env.EMAIL_MODE = "test";
    for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]) {
        delete process.env[key];
    }

    const { default: connectDB, disconnectDB } = await import("../src/db/index.js");
    const { VmSlot } = await import("../src/models/vmSlot.model.js");
    const { VmBooking } = await import("../src/models/vmBooking.model.js");
    const { CallbackBucket } = await import("../src/models/callbackBucket.model.js");
    const { createVmBooking } = await import("../src/services/vmBooking.service.js");
    const { createCallbackRequest } = await import("../src/services/callbackRequest.service.js");
    const { getVmDayStatuses } = await import("../src/services/calendar.service.js");
    const { ApiError } = await import("../src/utils/ApiError.js");
    const { addDays, expireAtFor, nowIST } = await import("../src/utils/time.js");
    const { logger } = await import("../src/utils/logger.js");

    // A booking or request that already exists is not an error when re-running.
    const tryCreate = async (counter, create) => {
        try {
            const result = await create();
            counter.created += 1;
            return result;
        } catch (error) {
            if (error instanceof ApiError && error.statusCode === 409) {
                counter.skipped += 1;
                return null;
            }
            throw error;
        }
    };

    await connectDB();
    try {
        // The next 7 working days (tomorrow onwards, so no slot is inside the 2 hour lead time).
        const today = nowIST().dateKey;
        const candidates = Array.from({ length: 21 }, (_, index) => addDays(today, index + 1));
        const statuses = await getVmDayStatuses(candidates);
        const days = candidates.filter((_, index) => statuses[index].bookable).slice(0, 7);
        if (days.length < 7) throw new Error(`Only ${days.length} working days found in the next 21 days.`);

        const vm = tally();
        const vmBlocks = tally();
        const callbacks = tally();
        const callbackBlocks = tally();
        let person = 0;

        for (const [dayIndex, date] of days.entries()) {
            // VM meetings through the booking service.
            for (const time of VM_PLAN[dayIndex]) {
                const details = personAt(person);
                const topic = VM_TOPICS[person % VM_TOPICS.length];
                const booked = await tryCreate(vm, () => createVmBooking({ ...details, topic, date, time }));

                // With Google off every booking says meetStatus "failed". Give every other one a
                // clearly fake link so the admin screens show both states.
                if (booked && person % 2 === 0) {
                    await VmBooking.updateOne(
                        { bookingId: booked.bookingId },
                        {
                            $set: {
                                meetStatus: "created",
                                meetLink: `https://meet.google.com/demo-seed-${String(person).padStart(3, "0")}`,
                            },
                        }
                    );
                }
                person += 1;
            }

            // Callback requests through the request service.
            for (const [period, howMany] of Object.entries(CALLBACK_PLAN[dayIndex])) {
                for (let n = 0; n < howMany; n++) {
                    const { name, email, mobileNumber } = personAt(person);
                    const reason = CALLBACK_REASONS[person % CALLBACK_REASONS.length];
                    await tryCreate(callbacks, () =>
                        createCallbackRequest({ name, email, mobileNumber, date, period, ...(reason ? { reason } : {}) })
                    );
                    person += 1;
                }
            }

            // VM blocks (AGENT_CONTEXT.md section 7: create the slot; a duplicate key means it is taken).
            for (const { time, by, reason } of VM_BLOCKS[dayIndex] ?? []) {
                await tryCreate(vmBlocks, async () => {
                    try {
                        return await VmSlot.create({
                            date, time, state: "blocked", blockedBy: by, blockReason: reason,
                            blockedAt: new Date(), expireAt: expireAtFor(date),
                        });
                    } catch (error) {
                        if (error?.code === 11000) throw new ApiError(409, "SLOT_TAKEN", "Slot already taken");
                        throw error;
                    }
                });
            }

            // Callback blocks: existing requests stay; the period just stops taking new ones.
            for (const { period, by, reason } of CALLBACK_BLOCKS[dayIndex] ?? []) {
                await tryCreate(callbackBlocks, async () => {
                    const bucket = await CallbackBucket.findOneAndUpdate(
                        { date, period },
                        {
                            $set: { blocked: true, blockedBy: by, blockReason: reason, blockedAt: new Date() },
                            $setOnInsert: { booked: 0, expireAt: expireAtFor(date) },
                        },
                        { upsert: true, returnDocument: "after" }
                    );
                    return bucket;
                });
            }
        }

        logger.info(`Demo data for ${days[0]} to ${days[days.length - 1]} (${days.length} working days):`);
        logger.info(`  VM bookings:        ${vm.created} created, ${vm.skipped} skipped`);
        logger.info(`  VM slot blocks:     ${vmBlocks.created} created, ${vmBlocks.skipped} skipped`);
        logger.info(`  Callback requests:  ${callbacks.created} created, ${callbacks.skipped} skipped`);
        logger.info(`  Callback blocks:    ${callbackBlocks.created} created, ${callbackBlocks.skipped} skipped`);
        logger.info(`All demo addresses end in @${DEMO_DOMAIN}. No email was sent and no Google event was created.`);
    } finally {
        await disconnectDB();
    }
};

// Run only when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(`\nseed:demo failed: ${error.message}`);
        process.exit(1);
    });
}
