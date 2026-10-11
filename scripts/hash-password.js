// Makes the bcrypt hash for ADMIN_PASSWORD_HASH.
//
//   npm run admin:hash
//
// Type the password when asked (nothing is echoed) and confirm it. The script prints a
// bcrypt hash (cost 12); copy it into ADMIN_PASSWORD_HASH in .env or your host's settings.
// Nothing is written to disk and the password is never printed.
//
// If input is piped (not a terminal) the first line is used as the password:
//   echo "my password" | npm run admin:hash

import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";

export const COST = 12;
// bcrypt only uses the first 72 bytes of a password.
export const MAX_PASSWORD_BYTES = 72;
const RECOMMENDED_LENGTH = 12;

/**
 * Asks `question` and returns what was typed, without echoing it.
 * Works on a terminal (raw mode, handles backspace, Enter, Ctrl+C, Ctrl+D) and, when input is
 * piped, returns the first line.
 */
export const promptHidden = (question, { input = process.stdin, output = process.stdout } = {}) =>
    new Promise((resolve, reject) => {
        output.write(question);

        if (!input.isTTY) {
            let buffered = "";
            const finish = () => {
                input.removeListener("data", onData);
                input.removeListener("end", finish);
                output.write("\n");
                resolve(buffered.split(/\r?\n/)[0]);
            };
            const onData = (chunk) => {
                buffered += chunk;
                if (/\r?\n/.test(buffered)) finish();
            };
            input.setEncoding("utf8");
            input.on("data", onData);
            input.on("end", finish);
            input.resume();
            return;
        }

        let typed = "";
        const restore = () => {
            input.removeListener("data", onData);
            input.setRawMode(false);
            input.pause();
            output.write("\n");
        };
        const onData = (chunk) => {
            for (const char of chunk) {
                if (char === "\r" || char === "\n" || char === "\u0004") {
                    restore();
                    resolve(typed);
                    return;
                }
                if (char === "\u0003") {            // Ctrl+C
                    restore();
                    reject(new Error("Cancelled."));
                    return;
                }
                if (char === "\u007f" || char === "\b") {   // backspace
                    typed = Array.from(typed).slice(0, -1).join("");
                } else if (char >= " ") {
                    typed += char;
                }
            }
        };

        input.setEncoding("utf8");
        input.setRawMode(true);
        input.resume();
        input.on("data", onData);
    });

/** Returns the bcrypt hash for `password`, or throws an Error with a message fit to show. */
export const hashPassword = async (password, cost = COST) => {
    if (typeof password !== "string" || password.length === 0) {
        throw new Error("The password cannot be empty.");
    }
    if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
        throw new Error(`The password is longer than ${MAX_PASSWORD_BYTES} bytes, which is the most bcrypt uses. Choose a shorter one.`);
    }
    return bcrypt.hash(password, cost);
};

const main = async () => {
    const password = await promptHidden("Admin password: ");
    const interactive = Boolean(process.stdin.isTTY);

    if (interactive) {
        const again = await promptHidden("Type it again: ");
        if (again !== password) {
            throw new Error("The two entries do not match. Run the script again.");
        }
    }

    const hash = await hashPassword(password);

    if (password.length < RECOMMENDED_LENGTH) {
        console.warn(`Warning: that password is shorter than ${RECOMMENDED_LENGTH} characters. A longer one is safer.`);
    }

    console.log(`\nPut this in ADMIN_PASSWORD_HASH (bcrypt, cost ${COST}):\n`);
    console.log(hash);
    console.log("\nIf your shell or host expands $ in values, wrap the hash in single quotes.");
    console.log("Nothing was saved to disk, and the password was not printed.");
};

// Run only when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(`\nFailed: ${error.message}`);
        process.exit(1);
    });
}
