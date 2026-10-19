// Runs one PARIVESH sync right now and says how many items it saved.
//
//   npm run parivesh:sync
//
// It works on the database named by MONGODB_URI in .env (the host is printed first), and only
// adds or updates items: it never deletes. Exit code 1 when the sync failed.

import "dotenv/config";

const main = async () => {
    const { config } = await import("../src/config/env.js");
    const { default: connectDB, disconnectDB } = await import("../src/db/index.js");
    const { syncParivesh, getSyncStatus } = await import("../src/services/parivesh/sync.js");
    const { PariveshUpdate } = await import("../src/models/pariveshUpdate.model.js");

    const host = config.MONGODB_URI.replace(/^mongodb(\+srv)?:\/\/([^@/]*@)?/, "").split(/[/?]/)[0];
    console.log(`Database: ${host} (NODE_ENV=${config.NODE_ENV})`);

    await connectDB();
    let exitCode = 0;
    try {
        const outcome = await syncParivesh();

        if (!outcome.ok) {
            console.error(`Sync FAILED (${outcome.reason}): ${outcome.message}. Nothing was changed.`);
            exitCode = 1;
        } else {
            console.log(`Received from PARIVESH : ${outcome.received}`);
            console.log(`Saved                  : ${outcome.saved} (${outcome.inserted} new, ${outcome.updated} changed)`);
            console.log(`Skipped                : ${outcome.skipped} (${outcome.skippedNoPublicDocument} not on PARIVESH's own document server, ${outcome.skippedInvalid} invalid)`);
        }

        const [stored, shown, status] = await Promise.all([
            PariveshUpdate.countDocuments(),
            PariveshUpdate.countDocuments({ published: true }),
            getSyncStatus(),
        ]);
        console.log(`In the database now    : ${stored} items, ${shown} published`);
        console.log(`Status                 : ${JSON.stringify(status)}`);
    } finally {
        await disconnectDB();
    }
    process.exit(exitCode);
};

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
