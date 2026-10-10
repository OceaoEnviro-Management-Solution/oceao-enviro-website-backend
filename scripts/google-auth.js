// One-time helper that prints a Google OAuth refresh token for the Calendar account.
//
//   npm run google:auth
//
// 1. Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (an OAuth client created in
//    Google Cloud Console; a "Desktop app" client allows the loopback redirect as is, a
//    "Web application" client needs http://127.0.0.1:5555 listed as an authorised redirect URI).
// 2. Run this script, open the URL it prints and approve access with the Google account
//    whose calendar should receive the meetings.
// 3. Copy the printed refresh token into GOOGLE_REFRESH_TOKEN.
//
// Nothing is written to disk: the token is only printed.

import "dotenv/config";

import crypto from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { google } from "googleapis";
import { config } from "../src/config/env.js";

export const HOST = "127.0.0.1";
export const PORT = 5555;
export const REDIRECT_URI = `http://${HOST}:${PORT}`;
export const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const WAIT_MS = 5 * 60 * 1000;

export const buildConsentUrl = (client, state) =>
    client.generateAuthUrl({
        access_type: "offline",   // ask for a refresh token
        prompt: "consent",        // always show the consent screen so Google returns one
        scope: [SCOPE],
        state,
    });

// Starts listening on the loopback address for Google's redirect.
// Returns { listening, code }: `listening` resolves once the port is bound (only then is
// it safe to show the consent URL), `code` resolves with the authorisation code.
const startLoopback = (expectedState) => {
    let onListening;
    const listening = new Promise((resolve) => { onListening = resolve; });

    const code = new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, REDIRECT_URI);
            if (url.pathname !== "/") {
                res.writeHead(404).end();
                return;
            }

            const finish = (status, message, outcome) => {
                res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
                res.end(message, () => {
                    server.close();
                    clearTimeout(timer);
                    outcome();
                });
            };

            if (url.searchParams.get("state") !== expectedState) {
                finish(400, "Invalid state. You can close this tab and run the script again.",
                    () => reject(new Error("The response did not match this session (state mismatch).")));
            } else if (url.searchParams.get("error")) {
                const reason = url.searchParams.get("error");
                finish(400, `Access was not granted (${reason}). You can close this tab.`,
                    () => reject(new Error(`Google reported: ${reason}`)));
            } else if (!url.searchParams.get("code")) {
                finish(400, "No authorisation code was returned. You can close this tab.",
                    () => reject(new Error("No authorisation code was returned.")));
            } else {
                const code = url.searchParams.get("code");
                finish(200, "Done. You can close this tab and return to the terminal.", () => resolve(code));
            }
        });

        const timer = setTimeout(() => {
            server.close();
            reject(new Error("Timed out after 5 minutes waiting for the Google redirect."));
        }, WAIT_MS);

        server.once("error", (error) => {
            clearTimeout(timer);
            reject(
                error.code === "EADDRINUSE"
                    ? new Error(`Port ${PORT} is already in use. Free it and run the script again.`)
                    : error
            );
        });
        server.listen(PORT, HOST, onListening);
    });

    return { listening, code };
};

const main = async () => {
    const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = config;
    if (!clientId || !clientSecret) {
        throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.");
    }

    const client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
    const state = crypto.randomBytes(16).toString("hex");
    const loopback = startLoopback(state);
    loopback.code.catch(() => {});   // reported by the await below; avoids an unhandled rejection
    await Promise.race([loopback.listening, loopback.code]);   // show the URL only once the port is bound

    console.log("Open this URL in your browser and approve access:\n");
    console.log(buildConsentUrl(client, state));
    console.log(`\nWaiting for Google to redirect to ${REDIRECT_URI} ...`);

    const code = await loopback.code;
    const { tokens } = await client.getToken(code);

    if (!tokens.refresh_token) {
        throw new Error(
            "Google returned no refresh token. Remove this app's access at " +
            "https://myaccount.google.com/permissions and run the script again."
        );
    }

    console.log("\nRefresh token (put this in GOOGLE_REFRESH_TOKEN in .env):\n");
    console.log(tokens.refresh_token);
    console.log("\nNothing was saved to disk.");
};

// Run only when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(`\nFailed: ${error.message}`);
        process.exit(1);
    });
}
