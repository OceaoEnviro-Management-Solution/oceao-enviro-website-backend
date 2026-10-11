# Oceao Enviro API: release notes

First production release of the backend. The website (frontend repo) has its own `docs/RELEASE_NOTES.md`; going live needs both. Written 11 October 2026.

Related documents: `docs/API_CONTRACT.md` (every endpoint, field and error code), `docs/AGENT_CONTEXT.md` (rules, business rules, data model), `docs/SECURITY_CHECKLIST.md` (security and operations baseline), `README.md` (scripts), `.env.example`.

## 1. Features

All routes are under `/api/v1` unless noted. Every response carries an `X-Request-Id`.

### Public

- **Query form** `POST /query/new-query`: validated, Turnstile-checked, emailed to `COMPANY_MAIL` (reply-to is the visitor) with a confirmation to the visitor.
- **Feedback form** `POST /feedback/new-feedback`: the same, plus an optional PDF, JPG or PNG attachment up to 5 MB, checked by its real content, not its name.
- **Virtual meeting booking** `/vm/*`:
  - Email OTP: 6 digits, valid 5 minutes, 60 second resend cooldown, 5 sends per hour, 5 wrong attempts then locked. The code is stored hashed and is single use.
  - A 30 minute booking token after verification.
  - Calendar and slot availability: Monday to Friday, 10:00, 12:00, 14:00, 16:00 IST, one hour, up to 30 days ahead, at least 2 hours from now, closed on holidays.
  - Booking claims the slot with a unique index, so two people can never hold the same slot; one upcoming booking per email.
  - A Google Meet link is created (8 second limit) and emailed to the customer and the company. If Google fails or is not configured the booking still stands and staff can retry.
- **Callback requests** `/callback/*`: Monday to Saturday (closed Sundays, second Saturdays, holidays), three periods (Morning 9 to 12, Afternoon 12 to 3, Evening 3 to 6), capacity per period (defaults 5, 5, 3), a period closes one hour before it ends. Capacity is claimed atomically; one pending request per email per date.

### Admin (`/admin/*`, one shared account, 8 hour session cookie)

- Login, logout, session check.
- Dashboard for a day, bookings list (62 day window, cancelled on request), VM calendar and day view, callback day view, callback requests per period.
- VM: block and unblock a slot or a whole day, cancel a booking (frees or blocks the slot, deletes the Calendar event, emails the customer), retry the Meet link.
- Callbacks: block and unblock a period or a day, cancel requests (customers emailed), set a request's status (pending, completed, no answer).
- Settings: callback capacity per period (0 to 50), holidays (add, bulk add, rename, remove).
- Every write records the employee name and a reason in an audit log (kept 180 days). Admin writes require an allowed `Origin` and a JSON body (CSRF check).

### Operations

- `GET /health` (no prefix): 200 with `db: "up"`, or 503 with `db: "down"`.
- Rate limits per IP per 15 minutes: public forms 5, OTP send 10, OTP verify 10, admin login 5, all of `/api` 300.
- Strict input validation (unknown fields are a 400), helmet, CORS allowlist, 20 kb body limit, generic 5xx responses in production, log redaction, request IDs.
- Scripts: `npm test` (567 tests, in-memory MongoDB), `npm run check:concurrency` (parallel booking and callback check against a local server), `npm run seed:holidays`, `npm run admin:hash`, `npm run google:auth`, `npm run seed:demo` (development only).

## 2. Environment variables required in production

Set these in the host's environment. The server refuses to start until the required ones are valid (names are printed, values never).

| Variable | Production value | Required | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | `production` | yes | Hides 5xx details, marks the admin cookie `Secure`. Never `test` on a public server: it switches the rate limits off and uses an in-memory outbox. |
| `MONGODB_URI` | `mongodb+srv://<user>:<password>@<cluster>/` | yes | The database name is fixed in code to `OE` (`src/constant.js`); any name in the URI path is ignored. |
| `CORS_ORIGINS` | `https://www.your-domain.example` | yes | Exact frontend origin(s), comma separated, no trailing slash, no `*`. The admin CSRF check uses the same list. |
| `TRUST_PROXY` | `1` | yes behind a proxy | Number of proxies in front of the app. With `0` every visitor shares the proxy's IP and the rate limits trip together. |
| `EMAIL_MODE` | `smtp` | yes | `log` and `test` never send real mail. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` | mail provider | yes with `smtp` | `SMTP_SECURE=true` for port 465, `false` for 587. |
| `MAIL_FROM` | `Oceao Enviro <no-reply@your-domain>` | yes | |
| `COMPANY_MAIL` | inbox for queries, feedback, bookings, callbacks | yes | |
| `OTP_SECRET` | random, 32+ characters | yes | Different from the other secrets. |
| `BOOKING_TOKEN_SECRET` | random, 32+ characters | yes | |
| `TURNSTILE_SECRET_KEY` | the real secret from Cloudflare | yes | The test key `1x0000000000000000000000000000000AA` always passes and must not be used. |
| `ADMIN_EMAIL` | admin login email | yes | |
| `ADMIN_PASSWORD_HASH` | output of `npm run admin:hash` | yes | A bcrypt hash; anything else is refused at start. |
| `ADMIN_JWT_SECRET` | random, 32+ characters | yes | |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | from the Google steps | no | All three together enable Meet links. Without them bookings work and show "link will follow". |
| `GOOGLE_CALENDAR_ID` | `primary` or a calendar ID | no | Defaults to `primary`. |
| `PORT` | set by the host | no | Defaults to 8000. |

Generate a secret: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`

The frontend needs `VITE_API_BASE_URL` and `VITE_TURNSTILE_SITE_KEY` at build time (see its release notes).

## 3. Manual setup steps

Do these once, in this order.

1. **MongoDB Atlas**: create the cluster, a database user and the network access rule for the host; put the connection string in `MONGODB_URI`. On the first start the unique and TTL indexes are built in the background: let the first start finish (check Indexes in Atlas shows `date_1_time_1` on `vm_slots`) before sending traffic, because the unique slot index is what prevents double booking.
2. **Cloudflare Turnstile**: in the Cloudflare dashboard create a widget for the website's domain. The secret key goes to `TURNSTILE_SECRET_KEY`; the site key goes to the frontend build (`VITE_TURNSTILE_SITE_KEY`).
3. **Admin login**: run `npm run admin:hash`, type the password and copy the printed hash to `ADMIN_PASSWORD_HASH` (wrap it in single quotes if the host expands `$`). Set `ADMIN_EMAIL` and `ADMIN_JWT_SECRET`. Changing the hash later ends every open admin session.
4. **Google Meet (optional)**:
   1. In Google Cloud Console create a project and enable the Google Calendar API.
   2. Configure the OAuth consent screen and create an OAuth client. A Desktop app client works as is; a Web application client needs `http://127.0.0.1:5555` as an authorised redirect URI.
   3. Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
   4. On a machine with a browser and port 5555 free, run `npm run google:auth`, open the printed URL and approve with the Google account whose calendar should hold the meetings.
   5. Copy the printed refresh token to `GOOGLE_REFRESH_TOKEN` in the host's environment and restart. Nothing is written to disk by the script.
   6. If the consent screen stays in "Testing", Google expires the refresh token after 7 days; publish the app to keep it valid.
5. **Holidays**: `data/holidays.json` ships as an empty list. Either add entries (`{ "date": "YYYY-MM-DD", "name": "..." }`; Sundays and second Saturdays are skipped because they are closed by rule) and run `npm run seed:holidays` (safe to repeat), or enter them in the admin panel under Settings. Do this before launch: until a date is a holiday, customers can book it.
6. **Deploy**: `npm ci --omit=dev`, `npm start`, behind HTTPS, with the variables above. Point the host's health check at `GET /health`.
7. **Smoke test**: `GET /health` returns `db: "up"`; send a query (company inbox receives it); book a meeting end to end (OTP email, booking, Meet link); request a callback; sign in to the admin panel and block then unblock a slot.
8. **Optional**: run `npm run check:concurrency` against a local server with a throwaway database before the first release (see the README).

## 4. Known limitations

- **No holidays are bundled** (`data/holidays.json` is empty); they must be entered before launch (step 5).
- **The database name is fixed to `OE`**; a different name in `MONGODB_URI` is ignored.
- **One shared admin account**: no per-person login, roles or password reset. The employee name is typed, not verified. Changing the password means changing the hash and restarting.
- **Customers cannot cancel or reschedule**; staff do it and the customer is emailed.
- **One upcoming virtual meeting per email address**; Indian mobile numbers only.
- **Emails are sent after the response and are not retried**; a failure is logged. The one exception is the company notification for the query and feedback forms: if it fails the visitor gets a 500 and nothing is sent to them.
- **Meet links depend on Google**: on failure the booking stays confirmed without a link until staff retry (`MEET_CREATE_FAILED` is shown as a generic error in production, because production 5xx responses are always `INTERNAL_ERROR`).
- **CAPTCHA fails closed**: if Cloudflare cannot be reached the three public forms answer `CAPTCHA_FAILED`.
- **Retention**: bookings, requests, slots and blocks are deleted 30 days after their date (TTL indexes); the audit log after 180 days.
- **Rate limit counters are in memory per process**: with more than one instance each keeps its own count. A shared store is needed before scaling out.
- **Logs go to stdout only**, one line per event, tagged with the request ID; there is no log shipping. A 500 line can quote submitted values from a database error: phone numbers are masked, email addresses are not.
- **The request ID header is not exposed to browser scripts** (CORS `exposedHeaders` is not set).
- **`npm audit`** lists three advisories in development tooling (nodemon); none ship to production (`npm ci --omit=dev`).
- **Login is the one admin route without the Origin check** (it is rate limited instead); every other admin write requires an allowed Origin and a JSON body.
