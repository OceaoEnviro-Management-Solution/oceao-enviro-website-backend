// Runs the careers retention clean-up right now: deletes job applications older than
// CAREERS_RETENTION_DAYS (default 365) and their resumes on Cloudinary, and says how many it removed.
//
//   npm run careers:cleanup
//
// It works on the database named by MONGODB_URI in .env (the host is printed first). The same
// clean-up runs by itself every day at 03:30 IST while the server is up. Exit code 1 when it failed.

import "dotenv/config";

const main = async () => {
    const { config } = await import("../src/config/env.js");
    const { default: connectDB, disconnectDB } = await import("../src/db/index.js");
    const { cleanupOldApplications } = await import("../src/services/careers/retention.service.js");

    const host = config.MONGODB_URI.replace(/^mongodb(\+srv)?:\/\/([^@/]*@)?/, "").split(/[/?]/)[0];
    console.log(`Database: ${host} (NODE_ENV=${config.NODE_ENV})`);
    console.log(`Keeping applications for ${config.CAREERS_RETENTION_DAYS} days`);

    await connectDB();
    try {
        const { removed, cutoff } = await cleanupOldApplications();
        console.log(`Removed ${removed} application(s) made before ${cutoff.toISOString()}, with their resumes.`);
    } finally {
        await disconnectDB();
    }
};

main().catch((error) => {
    console.error(`careers-cleanup failed: ${error.message}`);
    process.exit(1);
});
