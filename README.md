# Oceao Enviro Website Backend

REST API for the Oceao Enviro (environmental consulting, India) website: query and feedback forms, Virtual Meeting booking with email OTP and Google Meet, callback requests, and the admin panel.
Built with Node.js, Express 5, MongoDB (Mongoose), Zod and Nodemailer.

## Prerequisites

- Node.js 20 or newer
- MongoDB, either a local instance or a MongoDB Atlas cluster

## Setup

```bash
npm install
cp .env.example .env     # Windows PowerShell: Copy-Item .env.example .env
npm run admin:hash       # prints a bcrypt hash; put it in ADMIN_PASSWORD_HASH
# edit .env: MONGODB_URI, ADMIN_EMAIL, ADMIN_PASSWORD_HASH and the three secrets at minimum
npm run dev
```

The server refuses to start until every required variable in `.env` is valid (`ADMIN_PASSWORD_HASH` must be a real bcrypt hash, each secret at least 32 characters). Each variable is documented in `.env.example`, including the values to use in production.

The API runs at `http://localhost:8000` (API base: `http://localhost:8000/api/v1`). The frontend is expected at `http://localhost:5173`.

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Starts the server with nodemon and loads `.env` |
| `npm start` | Starts the server with `node` |
| `npm test` | Runs every test against an in-memory MongoDB (nothing is read from `.env`; no network) |
| `npm run seed:holidays` | Loads `data/holidays.json` into the `holidays` collection (safe to repeat) |
| `npm run seed:demo` | Fills a development database with demo bookings, blocks and requests (NODE_ENV=development only) |
| `npm run admin:hash` | Asks for the admin password and prints the bcrypt hash for `ADMIN_PASSWORD_HASH` |
| `npm run google:auth` | One-time helper that prints the Google refresh token for Meet link creation |
| `npm run check:concurrency` | Fires parallel bookings and callback requests at a running local server and prints the success counts (see below) |

### Concurrency check

`npm run check:concurrency` proves that capacity cannot be oversold. Against a server that is already running on this machine it signs 20 booking tokens with `BOOKING_TOKEN_SECRET`, books one free virtual meeting slot 20 times in parallel (expect 1 success), then sends 20 parallel callback requests for one period (expect as many successes as that period has capacity left). It then reads the database back and exits with code 1 if any count is wrong.

- It refuses to run when `NODE_ENV=production` and only talks to `localhost`, `127.0.0.1` or `::1`.
- It writes real rows. Use a throwaway local database; they expire with the normal 30 day retention.
- Start the server it checks with the limiters off and the Turnstile test key (`TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA`), and leave the `GOOGLE_*` variables empty so the winning booking does not create a real calendar event:

```bash
npx cross-env NODE_ENV=test EMAIL_MODE=test node src/index.js      # terminal 1
npm run check:concurrency                                          # terminal 2
```

Use `--url http://localhost:9000` (or `CHECK_BASE_URL`) when the server is not on port 8000.

## Folder structure

```
src/
  app.js              Express app (no DB connect, so tests can import it)
  index.js            loads env, connects DB, starts the server
  config/             env.js (validated env), booking.js (business rules), security.js (fixed security settings)
  routes/  controllers/  services/  models/  middlewares/  validators/  utils/
  services/email/     transporter, sendMail, templates
scripts/              seed, admin password, Google auth and concurrency check scripts
data/                 static data such as holidays.json
tests/                backend tests
docs/                 AGENT_CONTEXT.md, API_CONTRACT.md, SECURITY_CHECKLIST.md
```

Request flow: request ID, helmet, CORS, rate limit, body parsers, route, then multer, Turnstile, Zod validation (`.strict()`), controller, service, model or email.

## Security and operations

- Every request gets a new `X-Request-Id` (a UUID, never taken from the client). It is in the response header and in every log line written for that request (`requestId=<id>`), so a failure a user reports can be found by its ID.
- `GET /health` returns `{ status, db, uptime }`: 200 with `db: "up"`, or 503 with `db: "down"` when MongoDB is not connected. Use it for the host's health check.
- With `NODE_ENV=production`, 5xx responses are always `INTERNAL_ERROR` with a generic message. The detail and stack stay in the server log under the request ID.
- Request bodies, OTP codes, passwords, tokens and phone numbers are never logged. The email body is printed only with `NODE_ENV=development` and `EMAIL_MODE=log`.
- Fixed security settings (body limit, upload limits, helmet, admin cookie, rate limits) are in `src/config/security.js`. Environment-specific ones (`CORS_ORIGINS`, `TRUST_PROXY`, `NODE_ENV`) are in `.env`.
- `npm audit --omit=dev` is clean. The remaining advisories are in development tooling only (nodemon).

The full audit, with the file for every item, is in [docs/SECURITY_CHECKLIST.md](docs/SECURITY_CHECKLIST.md).

## Documentation

- [API contract](docs/API_CONTRACT.md): endpoints, request and response shapes, error codes
- [Agent context](docs/AGENT_CONTEXT.md): project rules, business rules, data model, environment variables
- [Security checklist](docs/SECURITY_CHECKLIST.md): security and operations baseline, with the evidence for each item
