# Security and operations checklist

Baseline audited in backend Stage 6.1, before release. Each item lists its status and where the evidence is. Items marked DONE are covered by a test in `tests/security.test.js` unless another file is named.

Re-verify at any time:

```bash
npm test                        # 567 tests, no network, in-memory MongoDB
npm audit --omit=dev            # expect: found 0 vulnerabilities
npm run check:concurrency       # against a local server, see README "Concurrency check"
```

## Summary

| # | Item | Status | Where |
| --- | --- | --- | --- |
| C1 | Every route validates params, query and body with `.strict()` zod schemas; `{ "$gt": "" }` is a 400 | DONE | `src/validators/*.js`, `src/middlewares/validate{Body,Query,Params}.middleware.js`, `src/routes/*.js`; tests: "C1" |
| C2 | Rate limiters: public forms, OTP send, OTP verify, admin login, global `/api` | DONE | `src/middlewares/rateLimit.js`, `src/config/security.js:41-48`, `src/app.js:31`; tests: "C2" |
| C3 | Cookie flags, CORS allowlist, helmet, 20kb body limit, multer limits, trust proxy come from config; production values in `.env.example` | DONE | `src/config/security.js`, `src/config/env.js`, `src/app.js:19-37`, `.env.example` (top block); tests: "C3" |
| C4 | No sensitive values in logs outside development log mode | DONE | inventory below; `src/utils/logger.js`; tests: "C4" |
| C5 | Production 500s carry no stack or internal message | DONE | `src/middlewares/error.middleware.js:58-72`; test: "C5" (child process with `NODE_ENV=production`) |
| C6 | `GET /health` returns `{ status, db, uptime }`, 503 when mongoose is not connected | DONE | `src/app.js:44-52`; tests: "C6" |
| C7 | `X-Request-Id` (UUID) on every response and in every request log line | DONE | `src/middlewares/requestId.js`, `src/utils/requestContext.js`, `src/utils/logger.js`, `src/middlewares/error.middleware.js:58-63`; tests: "C7" |
| C8 | `scripts/concurrency-check.js` (`npm run check:concurrency`) | DONE | `scripts/concurrency-check.js`, `package.json`; tests: "C8" |
| C9 | `npm audit --omit=dev`: high and critical fixed or documented | DONE | below |
| C10 | README and API contract match the code | DONE | `README.md`, `docs/API_CONTRACT.md`; drift list below |
| C11 | `npm test` passes | DONE | 567 of 567 |

## C1. Input validation

Every route runs a validation middleware for each part of the request it reads. The middlewares tag themselves (`validates`, `schema`), and `tests/security.test.js` walks every router and fails when a write route has no body schema, a GET has no query schema, a `:param` route has no params schema, or any schema is not `.strict()` (including the `holidays[]` items). `req.body`, `req.validatedQuery` and `req.validatedParams` are the parsed values; controllers never read `req.query` or `req.params`.

| Method | Path | Params | Query | Body |
| --- | --- | --- | --- | --- |
| POST | /api/v1/query/new-query | - | - | name, email, mobileNumber, organisation, industry, source, subject, query |
| POST | /api/v1/feedback/new-feedback | - | - | type, name, email, mobileNumber, subject, message |
| POST | /api/v1/vm/otp/send | - | - | email |
| POST | /api/v1/vm/otp/verify | - | - | email, otp |
| GET | /api/v1/vm/calendar | - | from, to | - |
| GET | /api/v1/vm/availability | - | date | - |
| POST | /api/v1/vm/bookings | - | - | name, mobileNumber, organisation, designation, topic, date, time (`email` accepted and discarded) |
| GET | /api/v1/callback/calendar | - | from, to | - |
| GET | /api/v1/callback/availability | - | date | - |
| POST | /api/v1/callback/requests | - | - | name, email, mobileNumber, date, period, reason |
| POST | /api/v1/admin/auth/login | - | - | email, password |
| POST | /api/v1/admin/auth/logout | - | - | (none allowed) |
| GET | /api/v1/admin/auth/me | - | (none allowed) | - |
| GET | /api/v1/admin/dashboard | - | date | - |
| GET | /api/v1/admin/bookings | - | from, to, type, includeCancelled | - |
| GET | /api/v1/admin/vm/calendar | - | month | - |
| GET | /api/v1/admin/vm/availability | - | date | - |
| GET | /api/v1/admin/callback/availability | - | date | - |
| GET | /api/v1/admin/callback/requests | - | date, period | - |
| GET | /api/v1/admin/settings | - | (none allowed) | - |
| GET | /api/v1/admin/holidays | - | year | - |
| POST | /api/v1/admin/vm/blocks | - | - | date, time or allDay, performedBy, reason |
| POST | /api/v1/admin/vm/blocks/remove | - | - | date, time or allDay, performedBy, reason |
| POST | /api/v1/admin/vm/bookings/:bookingId/cancel | bookingId | - | performedBy, reason, alsoBlock |
| POST | /api/v1/admin/vm/bookings/:bookingId/retry-meet | bookingId | - | performedBy |
| POST | /api/v1/admin/callback/blocks | - | - | date, period or allDay, performedBy, reason |
| POST | /api/v1/admin/callback/blocks/remove | - | - | date, period or allDay, performedBy, reason |
| POST | /api/v1/admin/callback/requests/cancel | - | - | requestIds, performedBy, reason |
| PATCH | /api/v1/admin/callback/requests/:requestId | requestId | - | status, performedBy |
| PUT | /api/v1/admin/settings/callback-capacity | - | - | morning, afternoon, evening, performedBy, reason |
| POST | /api/v1/admin/holidays | - | - | date, name, performedBy, reason |
| POST | /api/v1/admin/holidays/bulk | - | - | holidays[{ date, name }], performedBy, reason |
| PATCH | /api/v1/admin/holidays/:date | date | - | name, performedBy, reason |
| DELETE | /api/v1/admin/holidays/:date | date | - | performedBy, reason |

Notes:

- Schemas: `src/validators/` (`query`, `feedback`, `otp`, `vmBooking`, `vmAvailability`, `callback`, `adminAuth`, `adminRead`, `adminVm`, `adminCallback`, `common`). The empty schema for routes with no input is `noInputSchema` in `src/validators/common.js`.
- Operator objects are rejected by type: every field is `z.string()`, `z.number()`, `z.boolean()`, `z.enum()` or an array of those, so `{ "$gt": "" }` fails with 400 before any query is built. Tests send it to `POST /vm/otp/send` (public), `POST /admin/auth/login`, `POST /admin/vm/blocks` (with a session), `GET /admin/bookings?from[$gt]=` and `PATCH /admin/holidays/{...}`, and assert that no model method ran.
- Unknown keys are 400 with `errors: { "<key>": ["Unexpected field"] }` (`src/utils/validationErrors.js`).
- Request parts a route does not use (for example a body on a GET) are never read.
- `requireTurnstile` removes `turnstileToken` from the body before validation, so the public form schemas stay strict.
- Query and feedback forms previously had their own validation middleware; both are now `validateBody(schema)` (`src/middlewares/queryValidate.middleware.js`, `feedbackValidate.middleware.js`).
- Composition: no service builds a filter from a raw request value. Services receive the parsed objects only.

## C2. Rate limiters

All are `express-rate-limit` with a 15 minute window, keyed by `req.ip` (so `TRUST_PROXY` matters in production), answering 429 `RATE_LIMITED` with `Retry-After`. Numbers are in `src/config/security.js` (`rateLimits`).

| Limiter | Limit | Applied at |
| --- | --- | --- |
| `publicFormLimiter` | 5 | `src/routes/query.route.js`, `feedback.route.js`, `callback.route.js` (`POST /requests`); one shared counter |
| `otpSendLimiter` | 10 | `src/routes/vm.route.js` `POST /otp/send` |
| `otpVerifyLimiter` | 10 | `src/routes/vm.route.js` `POST /otp/verify` (existed; separate counter from send) |
| `adminLoginLimiter` | 5 | `src/routes/admin.route.js` `POST /auth/login` |
| `globalLimiter` | 300 | `src/app.js` `app.use("/api", ...)`, before the body parsers |

The limiters are off only when `NODE_ENV=test`. Counters are in memory per process: with more than one instance each keeps its own count.

## C3. Configuration

| Setting | Value | Source | Production value documented |
| --- | --- | --- | --- |
| Admin cookie | httpOnly, SameSite=Lax, path `/api/v1/admin`, 8 h, `Secure` when `NODE_ENV=production` | `src/config/security.js` (`adminCookie`, `adminCookieOptions`), used by `src/services/adminAuth.service.js` | `.env.example` |
| CORS allowlist | `CORS_ORIGINS` (comma list, credentials on) | `src/config/env.js`, `src/app.js:26-29`; also the admin CSRF check `src/middlewares/adminCsrf.js` | `.env.example` |
| helmet | defaults (`SECURITY.helmet`) | `src/config/security.js`, `src/app.js:24` | `.env.example` (note) |
| Body limit | 20kb JSON and urlencoded | `SECURITY.bodyLimit`, `src/app.js:33-38` | `.env.example` (note) |
| multer limits | 5 MB, 1 file, 10 fields, 10 KB per field | `SECURITY.upload`, `src/middlewares/multer.middleware.js:25-30` | `.env.example` (note) |
| Trust proxy | `TRUST_PROXY` (0 default) | `src/config/env.js`, `src/app.js:19` | `.env.example` |
| Rate limits | see C2 | `SECURITY.rateLimits` | `.env.example` (note) |

`.env.example` has a "Production values" block at the top: `NODE_ENV=production`, `CORS_ORIGINS=https://...`, `TRUST_PROXY=1`, `EMAIL_MODE=smtp`, the real Turnstile secret, three different 32+ character secrets, the admin hash and Atlas `MONGODB_URI`.

## C4. Logging

All logger and console calls (`src/` and `scripts/`), as found by `grep -rn "logger\.\|console\." src scripts`. `tests/security.test.js` repeats the scan for `src/` and fails if a call passes `req.body|headers|cookies|query|params|file|ip`, a password, OTP, token, phone number, or an email body (the one allowed exception is the development-only email body, checked separately).

The logger (`src/utils/logger.js`) also redacts JWTs, `Bearer ...`, `mongodb://user:pass@`, Indian mobile numbers and `otp|password|token|secret = value` pairs from every message unless `NODE_ENV=development`. This is a safety net; the calls below do not pass these values.

| File:line | Logs | Sensitive? |
| --- | --- | --- |
| `src/config/env.js:86` | names of invalid variables and the reason | No values: `loadConfig` prints the variable name and a fixed reason, never the value |
| `src/db/index.js:12, 18` | Mongo host name; "indexes ready" | No credentials (host only) |
| `src/index.js:16, 27, 54` | startup and shutdown errors (the Error stack) | Connection errors can quote the URI; the logger redacts `mongodb://user:pass@` |
| `src/index.js:22, 30, 41, 44, 51` | Meet configuration warning, port, EMAIL_MODE, signal name | No |
| `src/middlewares/error.middleware.js:61` | `METHOD path failed with 5xx` (query string removed) and the error stack, under the request ID | Server side only; never returned in production |
| `src/services/audit.service.js:27` | audit action, target type, target id, error code | No personal data |
| `src/services/email/email.connections.js:8, 10` | "SMTP connection verified" / `error.message` | SMTP error text (no password) |
| `src/services/email/email.services.js:30` | log mode: recipient and subject | No body |
| `src/services/email/email.services.js:35` | log mode, `NODE_ENV=development` only: plain-text body | Intentional (reading the OTP locally); guarded by `config.NODE_ENV === "development"`, tested |
| `src/services/feedback.services.js:44, 67`, `src/services/query.services.js:50, 79` | "notification failed" and the Error stack | No body; stack and message only |
| `src/services/googleCalendar.service.js:194` | error code | No |
| `src/services/notify.service.js:57, 68, 78` | event name, booking or request id, failure reason code | No address, body or OTP |
| `src/services/turnstile.service.js:55` | error name | No token |
| `src/services/vmBooking.service.js:53-54` | booking id and reason code (`logger.warn` or `logger.error`) | No |
| `src/services/vmBooking.service.js:135, 202` | booking id and reason code | No |
| `src/utils/logger.js:42-44` | the logger itself | n/a |
| `scripts/seed-holidays.js:72, 73, 82` | counts, skipped dates, `error.message` | No |
| `scripts/seed-demo.js:264-269, 278` | counts and the demo address domain | No |
| `scripts/hash-password.js:106-112, 118` | prints the bcrypt hash on purpose; says the password was not printed | The hash only (the operator's terminal) |
| `scripts/google-auth.js:107-109, 121-123, 129` | prints the consent URL and the refresh token on purpose | Operator's terminal only; nothing is written to disk |
| `scripts/concurrency-check.js` | counts and fake `@concurrency-check.invalid` addresses | No |

Outside these calls nothing writes to stdout or stderr: there is no request logger, no `morgan`, and Express's default error output is not reached because `errorHandler` answers every error.

## C5. Production error responses

`errorHandler` replaces the message, code and `errors` of every 5xx with `Something went wrong. Please try again later.` / `INTERNAL_ERROR` / `{}` when `NODE_ENV=production` (`src/middlewares/error.middleware.js`). This includes the deliberate 502s (`EMAIL_SEND_FAILED`, `MEET_CREATE_FAILED`), which therefore read as `INTERNAL_ERROR` with status 502 in production. The stack is only ever written to the server log under the request ID. The test boots the app in a child process with `NODE_ENV=production`, forces a Mongoose error and checks the exact response body; a second run with `NODE_ENV=test` shows the internal message would otherwise be returned.

## C6. Health

`GET /health` (outside `/api`, so not rate limited and no session):

```
200 { "status": "ok",          "db": "up",   "uptime": 123 }   mongoose.connection.readyState === 1
503 { "status": "unavailable", "db": "down", "uptime": 123 }   any other readyState
```

## C7. Request IDs

`requestId` is the first middleware (`src/app.js`). It sets `req.id = crypto.randomUUID()` and the `X-Request-Id` response header; an incoming header is ignored. The ID travels in an `AsyncLocalStorage` (`src/utils/requestContext.js`) that `logger.js` reads, so lines logged from fire-and-forget work (emails, Calendar clean-up) carry it too. On some Node versions the body parsers and multer resume outside the stored context (the HTTP parser's), so `bindRequestContext` (after the parsers) and `asyncHandler` enter it again from `req.id`, and `errorHandler` does the same for its log line. On the Node version the tests ran on the context survives anyway, so these re-entries are a safeguard that the tests cannot tell apart. Logged form: `2026-10-11T10:00:00.000Z [ERROR] requestId=<uuid> POST /api/v1/vm/otp/send failed with 500 ...`.

The header is not in `Access-Control-Expose-Headers`, so browser JavaScript on another origin cannot read it; it is visible in the network tab and to the server operator. Add `exposedHeaders: ["X-Request-Id"]` to the CORS options if the frontend should show it.

## C8. Concurrency check

`npm run check:concurrency` (`scripts/concurrency-check.js`): signs 20 booking tokens with `BOOKING_TOKEN_SECRET`, fires 20 parallel `POST /vm/bookings` at one free slot (expect exactly 1 success, 19 `409 SLOT_TAKEN`), then 20 parallel `POST /callback/requests` at one open period (expect as many successes as capacity left, the rest `409 PERIOD_FULL`), prints the counts and reads the database back (one booking and one slot document; counter equals capacity; one request document per success). Exit 0 = pass, 1 = a count was wrong, 2 = could not run. It refuses `NODE_ENV=production` and any host other than `localhost`, `127.0.0.1` and `::1`.

Run the target server with `NODE_ENV=test EMAIL_MODE=test` (limiters off, nothing emailed) and the Turnstile test key, otherwise the public form limiter (5 per 15 minutes) and the captcha answer 429 and 400 to most requests; the script says so when it sees that. `tests/security.test.js` runs the same function against the test app on an ephemeral port.

## C9. Dependency audit

`npm audit --omit=dev` (production dependencies): **found 0 vulnerabilities** after `npm audit fix`, which updated the lockfile only (`package.json` unchanged, so its ranges still allow the patched versions and `npm ci` installs exactly them):

| Package | Change | Why |
| --- | --- | --- |
| multer | 2.4.0 | raised by `npm audit fix` (file upload parser) |
| nodemailer | 10.1.0 | raised by `npm audit fix` (email transport) |
| proxy-addr | 2.0.8 | raised by `npm audit fix` (transitive, Express's `req.ip`) |

`npm audit` (all dependencies) still lists 3 high advisories, all in development tooling: `nodemon` -> `chokidar` -> `braces`. They are not installed in production (`npm ci --omit=dev`) and nodemon only watches files on a developer machine. The only fix `npm audit` offers is a breaking downgrade of nodemon, so this is accepted and documented here. Re-run the audit before each release.

## C10. Documentation drift fixed

Differences between the docs and the code found in this audit, and how each was settled:

| Where | Was | Now |
| --- | --- | --- |
| `GET /health` | code returned `{ message: "ok" }`, contract said `{ status, db, uptime }` and a 503 | code changed to the contract (C6); contract adds the 503 body |
| Unknown request fields | undocumented (silently dropped) | 400 `VALIDATION_FAILED` (C1); contract section "Strict input" |
| `X-Request-Id` | not mentioned | contract section "Request ID" |
| Rate limits | only some endpoints named numbers | contract table "Rate limits" with all five limiters |
| Production 5xx | "always INTERNAL_ERROR" but 502 codes listed as if returned | contract states 502 codes read `INTERNAL_ERROR` in production |
| `CONFLICT` | "other duplicate key" | the four real cases |
| `BAD_REQUEST` | missing from the code table | added (framework 4xx without a code) |
| Callback cancel `skipped[].reason` | not listed | `not_found`, `already_cancelled`, `not_pending` |
| `PATCH /admin/callback/requests/:requestId` | cancelled request not described | 409 `CONFLICT` |
| `POST /admin/holidays` | duplicate not described | 409 `CONFLICT` |
| Admin cookie | `httpOnly` only | adds SameSite=Lax, Secure in production, 8 hours |
| `POST /admin/auth/logout`, `GET /admin/auth/me` | no error listed / no input noted | ADMIN_UNAUTHORIZED; take no fields |
| README | setup said to set only `MONGODB_URI`; listed 2 scripts; said folders arrive later | real setup (admin hash, secrets), all 8 scripts, folder list, security notes |
| `.env.example` | no production guidance | "Production values" block |

## Operational notes and accepted risks

- Never run a public server with `NODE_ENV=test`: it switches the rate limiters off and uses the in-memory email outbox.
- Rate limit counters are per process. A second instance doubles the effective limit; move to a shared store (Redis) before scaling out.
- With `TRUST_PROXY=0` behind a proxy every visitor shares the proxy's IP and the limiters trip for everyone together. Set it to the number of proxies.
- Emails are fire and forget after the response; a failure is logged (with the request ID) and not retried.
- Mongoose error messages in a 500 log line can include submitted values (for example a cast error). Phone numbers are redacted by the logger; email addresses are not.
- The logger's redaction is pattern based and best effort. The rule is still: never pass these values to the logger.
