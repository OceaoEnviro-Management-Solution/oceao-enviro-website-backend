# Oceao Enviro: Agent Context

Read this file and `docs/API_CONTRACT.md` before every task. They are the source of truth. If code disagrees with them, fix the code. If they look wrong, stop and say so; do not silently change the design.

## 1. Project

Website for Oceao Enviro (environmental consulting, India). Two repos:

| Repo | Stack | Local URL |
| --- | --- | --- |
| `oceao-enviro-website-backend` | Node 20+, Express 5, ES modules, Mongoose, Zod, Nodemailer | `http://localhost:8000` |
| `oceao-enviro-website-frontend` | React 19, Vite, React Router 7, Tailwind 4, react-datepicker | `http://localhost:5173` |

Public features: Query (email only), Feedback (email only, optional attachment), Virtual Meeting (VM) booking with email OTP and Google Meet, Request a Callback (capacity by period). Admin panel: one shared login, dashboard, bookings, VM availability, callback availability, settings.

## 2. Working rules

- Do only the stage you were given. Do not start the next stage, refactor unrelated code or rename files you were not asked to touch.
- Frontend: never change visual design, layout, Tailwind classes or copy unless the stage says so. New UI reuses existing components and classes.
- Backend layering: route → (multer) → (turnstile) → zod validation → controller → service → model/email. Controllers stay thin; business logic lives in services.
- All config comes from `src/config/env.js` (env) and `src/config/booking.js` (business rules). Never read `process.env` elsewhere. Never hard-code a rule value in a service.
- Use `asyncHandler` for async controllers and `ApiError(statusCode, code, message, errors)` for expected failures.
- Never log OTP codes, passwords, tokens, request bodies, phone numbers or email bodies. Use `src/utils/logger.js`.
- No new dependency unless the stage names it. If one is truly needed, say why in the commit body.
- Dates over the wire are strings `YYYY-MM-DD`; times are `HH:mm` (24h). Never send JS Date objects or ISO timestamps for booking dates.
- Finish each stage with tests passing (`npm test` backend; `npm run build` and `npm run lint` frontend).
- Never run `git add`, `commit`, `push`, `stash`, `reset`, `restore` or `checkout`. The developer reviews every diff and commits personally.
- End every stage with the REPORT the prompt asks for: a checklist table (DONE / PARTIAL / NOT DONE per item, with file:line), the files changed with a reason each, and exact steps to verify.

## 3. Backend folder structure

```
src/
  app.js              express app, no DB connect (tests import it)
  index.js            loads dotenv, connects DB, listens, graceful shutdown
  config/env.js       zod-validated env, frozen
  config/booking.js   business rules (section 4)
  routes/  controllers/  services/  models/  middlewares/  validators/  utils/
  services/email/     transporter, sendMail, templates/
scripts/              seed-holidays, seed-demo, google-auth, hash-password, concurrency-check
data/holidays.json
tests/                node --test, supertest, mongodb-memory-server
docs/                 this file, API_CONTRACT.md
```

## 4. Business rules (`src/config/booking.js`)

```js
export const BOOKING = Object.freeze({
  timezone: "Asia/Kolkata",
  vm: {
    workingDays: [1, 2, 3, 4, 5],          // Mon-Fri (0 = Sunday)
    slotTimes: ["10:00", "12:00", "14:00", "16:00"],
    durationMinutes: 60,
    horizonDays: 30,                       // today + 30 inclusive
    minLeadMinutes: 120                    // slot must start >= 2h from now
  },
  callback: {
    workingDays: [1, 2, 3, 4, 5, 6],       // Mon-Sat
    closedSaturdaysOfMonth: [2],           // 2nd Saturday of every month closed
    periods: {
      morning:   { label: "Morning",   start: "09:00", end: "12:00", timeRange: "9 AM – 12 PM", defaultCapacity: 5 },
      afternoon: { label: "Afternoon", start: "12:00", end: "15:00", timeRange: "12 PM – 3 PM", defaultCapacity: 5 },
      evening:   { label: "Evening",   start: "15:00", end: "18:00", timeRange: "3 PM – 6 PM",  defaultCapacity: 3 }
    },
    periodOrder: ["morning", "afternoon", "evening"],
    cutoffMinutesBeforeEnd: 60,            // period closes 1h before it ends
    horizonDays: 30
  },
  retentionDays: 30,                       // bookings/requests/slots deleted 30 days after their date
  auditRetentionDays: 180,
  otp: {
    length: 6,
    validityMinutes: 5,
    resendCooldownSeconds: 60,
    maxSendsPerHour: 5,
    maxAttempts: 5,
    bookingTokenMinutes: 30
  }
});
```

Sundays (both) and the second Saturday of each month (callbacks; VM never runs on Saturdays) are closed by rule and are never stored as holidays. Festival holidays live in the `holidays` collection, are managed by staff from the admin Settings page (year calendar, bulk add at the start of the year, edit any time), and close a date for both VM and callbacks. Past dates and dates beyond the horizon are never bookable.

## 5. Time handling

- The server may run in any timezone. All "now" logic uses IST via `src/utils/time.js` (Intl only, no date library).
- `dateKey` = `YYYY-MM-DD` in IST. `dayOfWeek(dateKey)` uses `Date.UTC` so it never depends on server TZ.
- `istToDate(dateKey, "HH:mm")` returns the real UTC instant (IST = UTC+05:30). Use it for Google events and for `expireAt`.
- Frontend: build date keys with `toDateKey(date)` from `src/utils/dateKey.js` (local getters). Never use `toISOString().split("T")[0]`; in IST it returns the previous day.

## 6. Data model

All schemas `strict`, `timestamps: true`. Emails lowercased and trimmed. `expireAt` fields carry a TTL index (`expireAfterSeconds: 0`) and are set with `expireAtFor(dateKey)`.

**vm_slots** (`VmSlot`): one document per OCCUPIED slot. A free slot has no document.
`date` (dateKey), `time` (enum slotTimes), `state` (`booked` | `blocked`), `bookingId` (when booked), `blockedBy`, `blockReason`, `blockedAt`, `expireAt`. Indexes: unique `{ date: 1, time: 1 }`, TTL.

**vm_bookings** (`VmBooking`):
`bookingId` (unique, `OE-VM-YYMMDD-XXXX`), `date`, `time`, `name`, `email`, `mobileNumber` (`+91XXXXXXXXXX`), `organisation`, `designation`, `topic`, `status` (`confirmed` | `cancelled`), `meetStatus` (`pending` | `created` | `failed`), `meetLink`, `googleEventId`, `cancelledBy`, `cancelReason`, `cancelledAt`, `expireAt`. Indexes: unique `bookingId`, `{ email: 1, status: 1, date: 1 }`, `{ date: 1, time: 1 }`, TTL. "Completed" is derived (date/time passed), never stored.

**callback_buckets** (`CallbackBucket`): one document per `(date, period)` that has any booking or block.
`date`, `period` (enum morning|afternoon|evening), `booked` (int >= 0, default 0), `blocked` (bool, default false), `blockedBy`, `blockReason`, `blockedAt`, `expireAt`. Indexes: unique `{ date: 1, period: 1 }`, TTL.

**callback_requests** (`CallbackRequest`):
`requestId` (unique, `OE-CB-YYMMDD-XXXX`), `date`, `period`, `name`, `email`, `mobileNumber`, `reason`, `status` (`pending` | `completed` | `no_answer` | `cancelled`), `statusUpdatedBy`, `cancelledBy`, `cancelReason`, `cancelledAt`, `expireAt`. Indexes: unique `requestId`, `{ date: 1, period: 1 }`, `{ email: 1, date: 1, status: 1 }`, TTL.

**otp_challenges** (`OtpChallenge`): `email` (unique), `codeHash`, `codeExpiresAt`, `attempts`, `sendCount`, `windowStartedAt`, `lastSentAt`, `expireAt` (= windowStartedAt + 1 hour, TTL).

**holidays** (`Holiday`): `date` (unique), `name`.

**settings** (`Settings`): single doc `{ key: "main", callbackCapacity: { morning, afternoon, evening } }`. Missing doc = defaults from config.

**audit_logs** (`AuditLog`): `action`, `targetType`, `targetId`, `date`, `detail` (mixed), `performedBy`, `reason`, `expireAt` (180 days, TTL).

IDs: `src/utils/ids.js`, 4 characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ` via `crypto.randomInt`; retry up to 3 times on duplicate key.

## 7. Booking atomicity (no transactions)

**VM booking** (`POST /vm/bookings`):
1. Validate body; email = `req.verifiedEmail` from the booking token.
2. Day bookable and slot time open, else 422 `DATE_NOT_BOOKABLE`.
3. `VmBooking.exists({ email, status: "confirmed", date: { $gte: todayKey } })` → 409 `ACTIVE_BOOKING_EXISTS`.
4. `VmSlot.create({ date, time, state: "booked", bookingId, expireAt })`. Duplicate key (11000) → 409 `SLOT_TAKEN`.
5. `VmBooking.create(...)`. If it throws, `VmSlot.deleteOne({ date, time, bookingId })` then rethrow.
6. Google Meet (section 8), respond 201, send emails without awaiting.

**VM cancel**: booking → cancelled. Then either `VmSlot.deleteOne({ date, time, bookingId })` or, with `alsoBlock`, one `VmSlot.updateOne({ date, time, bookingId }, { $set: { state: "blocked", blockedBy, blockReason, blockedAt }, $unset: { bookingId: 1 } })`.

**VM block**: `VmSlot.create({ state: "blocked", ... })`; duplicate key → skipped (inspect the existing doc for `booked` vs `already_blocked`).

**Callback request** (`POST /callback/requests`):
```js
const cap = (await getCallbackCapacity())[period];
await CallbackBucket.findOneAndUpdate(
  { date, period, blocked: false, booked: { $lt: cap } },
  { $inc: { booked: 1 }, $setOnInsert: { expireAt } },
  { upsert: true, new: true }
);
// E11000 => bucket exists but is full or blocked: read it, return 409 PERIOD_BLOCKED or PERIOD_FULL.
// cap === 0 => PERIOD_FULL without trying.
```
Then create the `CallbackRequest`; if that throws, `$inc: { booked: -1 }` and rethrow. Cancel = status cancelled + `$inc: { booked: -1 }` (never below 0).

## 8. Google Meet

- `googleapis`, OAuth2 client with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`; calendar `GOOGLE_CALENDAR_ID` (default `primary`); scope `https://www.googleapis.com/auth/calendar.events`.
- `events.insert` with `conferenceDataVersion: 1`, `sendUpdates: "all"`, `conferenceData.createRequest.requestId = bookingId`, `conferenceSolutionKey.type = "hangoutsMeet"`, start/end `YYYY-MM-DDTHH:mm:00` with `timeZone: "Asia/Kolkata"`, 60 minutes, attendee = customer email. Link = `hangoutLink`.
- 8-second timeout. Failure never fails the booking: `meetStatus: "failed"`, `meetLink: null`, logged with bookingId. Admin can retry.
- Cancel calls `events.delete` with `sendUpdates: "all"`; failure is logged only.
- Missing Google env = feature disabled (warn once at boot, every create is "failed").

## 9. Admin auth (one shared account)

- Env: `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` (bcrypt cost 12, made with `npm run admin:hash`), `ADMIN_JWT_SECRET`.
- Login always runs `bcrypt.compare`. JWT HS256 `{ sub: "admin", pwv }`, 8h; `pwv` = first 12 hex of sha256(ADMIN_PASSWORD_HASH).
- Cookie `oe_admin`: httpOnly, `sameSite: "lax"`, `secure` in production, `path: "/api/v1/admin"`, maxAge 8h.
- `requireAdmin` on every `/api/v1/admin/*` route except `POST /admin/auth/login`.
- `adminCsrf` on non-GET admin routes: `Origin` in `CORS_ORIGINS` and `Content-Type: application/json`, else 403 `CSRF_REJECTED`.
- Every admin write body carries `performedBy` (2–60 chars, the employee name typed in the UI) and, where stated, `reason` (3–300 chars).

## 10. CAPTCHA

Cloudflare Turnstile. Backend verifies `turnstileToken` at `https://challenges.cloudflare.com/turnstile/v0/siteverify` (form fields `secret`, `response`, `remoteip`), 5s timeout. Required on `POST /query/new-query`, `POST /feedback/new-feedback`, `POST /callback/requests`. Local test keys: site `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA` (always pass).

## 11. Emails

`EMAIL_MODE`: `smtp` (real), `log` (jsonTransport, logs to and subject only), `test` (in-memory outbox). Templates return `{ subject, text, html }`; HTML escapes every user value; subjects use raw values with CR/LF stripped. Dates shown as `Thu, 15 Oct 2026`, times as `10:00 AM IST`.

| Email | To | When |
| --- | --- | --- |
| otpCode | customer | OTP send (failure → 502) |
| vmConfirmationCustomer | customer | booking created (link or "link will follow") |
| vmNotificationCompany | COMPANY_MAIL, Reply-To customer | booking created |
| vmCancellationCustomer | customer | admin cancel (no internal reason) |
| vmMeetLinkFollowup | customer | successful admin retry |
| callbackConfirmationCustomer | customer | callback created |
| callbackNotificationCompany | COMPANY_MAIL, Reply-To customer | callback created |
| callbackCancellationCustomer | customer | admin cancel |

All booking emails except OTP are fire-and-forget through `notify.service.js` (catch + log).

## 12. Audit

Every admin write creates one `AuditLog` entry: `action` (e.g. `vm.block`, `vm.cancel`, `callback.cancel`, `settings.capacity`, `holiday.add`), target, date, detail, performedBy, reason.

## 13. Environment variables (backend)

| Variable | Required from | Notes |
| --- | --- | --- |
| NODE_ENV | 0.2 | development / test / production |
| PORT | 0.2 | default 8000 |
| MONGODB_URI | 0.2 | |
| CORS_ORIGINS | 0.2 | comma-separated, e.g. `http://localhost:5173` |
| TRUST_PROXY | 0.2 | 0 locally, 1 behind a host proxy |
| EMAIL_MODE | 0.2 | log / smtp / test |
| MAIL_FROM, COMPANY_MAIL | 0.2 | |
| SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD | 0.2 (smtp mode only) | |
| OTP_SECRET, BOOKING_TOKEN_SECRET | 2.1 | ≥ 32 chars each |
| GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN | 2.4 (optional) | missing = Meet disabled |
| GOOGLE_CALENDAR_ID | 2.4 | default `primary` |
| TURNSTILE_SECRET_KEY | 3.1 | |
| ADMIN_EMAIL, ADMIN_PASSWORD_HASH, ADMIN_JWT_SECRET | 4.1 | secret ≥ 32 chars |

Frontend: `VITE_API_BASE_URL` (includes `/api/v1`), `VITE_TURNSTILE_SITE_KEY`.

## 14. Testing (backend)

- `npm test` = `node --test` over `tests/`, `NODE_ENV=test`, `EMAIL_MODE=test`, MongoMemoryServer, supertest against `app`.
- Each test file clears collections before each test. Rate limiters off in tests unless a test enables them.
- External services (Turnstile, Google) are injected fakes in tests; never call the network.
- Time-dependent logic accepts an optional `now` so tests freeze time.
- Concurrency tests use `Promise.all` with parallel supertest requests and assert database counts afterwards.

## 15. Frontend rules

- All HTTP goes through `src/services/http.js` (`request()`, `ApiRequestError { status, code, message, fieldErrors }`). Never call `fetch` directly elsewhere.
- Booking token lives only in `BookingContext` state. Admin session lives only in the httpOnly cookie; use `GET /admin/auth/me` to check it.
- Map backend field names to form field names in the api/service layer or a small adapter, not inside presentational components.
- Show backend error messages to users; never show raw stack traces or codes alone.
