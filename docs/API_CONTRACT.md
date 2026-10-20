# Oceao Enviro: API Contract (v1)

Base URL: `{API}/api/v1` (local `http://localhost:8000/api/v1`). All bodies JSON unless stated. Dates `YYYY-MM-DD` (IST), times `HH:mm` (24h, IST).

## Conventions

### Success

```json
{ "statusCode": 200, "success": true, "message": "Human readable", "data": { } }
```

`data` is shown below for each endpoint.

### Errors

```json
{ "success": false, "code": "SLOT_TAKEN", "message": "That slot was just booked. Please pick another.", "errors": {} }
```

`errors` holds field errors for 400 `VALIDATION_FAILED` as `{ "fieldName": ["message", ...] }`, otherwise `{}` or a small object stated per endpoint (e.g. `{ "attemptsLeft": 3 }`).

With `NODE_ENV=production` every 5xx response, including the 502 codes below, is `{ "code": "INTERNAL_ERROR", "message": "Something went wrong. Please try again later.", "errors": {} }`. The detail stays in the server log under the request ID.

### Request ID

Every response, success or error, has an `X-Request-Id` header: a new UUID per request. It is also in every server log line for that request (`requestId=<id>`), so quote it when reporting a problem. A request ID sent by the client is ignored.

### Strict input

Body, query string and path parameters are validated against strict schemas. A field that is not listed for an endpoint is `400 VALIDATION_FAILED` with `errors: { "<field>": ["Unexpected field"] }`. The endpoints that take no input (`POST /admin/auth/logout`, `GET /admin/auth/me`, `GET /admin/settings`, `POST /visits`, `GET /visits/total`, `GET /aqi`, `GET /hero`, `GET /updates/latest`, `GET /admin/hero`, `GET /admin/updates/sync-status`, `POST /admin/updates/sync`) reject any key at all. A request part an endpoint does not use (such as a body on a GET) is never read. The one exception: an `email` in the `POST /vm/bookings` body is accepted and discarded. Values must have the documented type, so an object such as `{ "$gt": "" }` where a string is expected is a 400 too.

### Rate limits

Per IP, per 15 minutes, answered with 429 `RATE_LIMITED` and a `Retry-After` header:

| Limiter | Limit | Applies to |
| --- | --- | --- |
| Public forms | 5 | `POST /query/new-query`, `POST /feedback/new-feedback`, `POST /callback/requests` (one shared counter) |
| OTP send | 10 | `POST /vm/otp/send` |
| OTP verify | 10 | `POST /vm/otp/verify` |
| Admin login | 5 | `POST /admin/auth/login` |
| All of `/api` | 300 | every route under `/api` |

The visit counter has its own limit: `POST /visits` allows 10 per **hour** per IP, and over the limit it answers **200** with the current total (the visit is not counted) instead of 429, so the website footer never shows an error.

`POST /admin/updates/sync` has its own limit: **1 per 5 minutes in total** (not per IP), answered with 429 `RATE_LIMITED` and `Retry-After`.

`GET /health` is not limited.

### Error codes

| Code | Status | Meaning |
| --- | --- | --- |
| VALIDATION_FAILED | 400 | zod failure, see `errors` |
| INVALID_JSON | 400 | malformed JSON body |
| CAPTCHA_FAILED | 400 | Turnstile missing/invalid |
| INVALID_FILE_TYPE | 400 | not pdf/jpg/png by content (hero slides: not jpg/png/webp) |
| UPLOAD_ERROR | 400 | other multer error |
| OTP_NOT_FOUND | 400 | no active code for email |
| OTP_INVALID | 400 | wrong code, `errors.attemptsLeft` |
| BOOKING_TOKEN_INVALID | 401 | missing/expired/wrong booking token |
| INVALID_CREDENTIALS | 401 | admin login failed |
| ADMIN_UNAUTHORIZED | 401 | no/invalid admin session |
| CSRF_REJECTED | 403 | admin write from bad Origin/content type (JSON everywhere, except `POST /admin/hero/slides`, which must be multipart/form-data) |
| NOT_FOUND | 404 | route or resource not found |
| SLOT_TAKEN | 409 | VM slot booked or blocked |
| SET_FULL | 409 | a hero set (live or scheduled) already has 5 slides |
| ACTIVE_BOOKING_EXISTS | 409 | email already has an upcoming VM booking |
| PERIOD_FULL | 409 | callback period at capacity |
| PERIOD_BLOCKED | 409 | callback period blocked |
| DUPLICATE_REQUEST | 409 | same email already pending on that date |
| NOT_CANCELLABLE | 409 | booking already cancelled or started |
| MEET_ALREADY_CREATED | 409 | retry on a booking that has a link |
| CONFLICT | 409 | duplicate holiday date; status change on a cancelled callback request; a slot or period being changed at the same moment (retry); a Meet link already being created |
| OTP_EXPIRED | 410 | code expired |
| FILE_TOO_LARGE | 413 | > 5 MB (hero slide image: > 10 MB) |
| PAYLOAD_TOO_LARGE | 413 | body > 20 kb |
| ALREADY_CLOSED | 422 | holiday on a date already closed by rule |
| INVALID_SWITCH_DATE | 422 | hero switch date is not after today (IST) |
| DATE_NOT_BOOKABLE | 422 | `errors.reason` = past, beyond_horizon, non_working_day, holiday, invalid_date, closed |
| RATE_LIMITED | 429 | IP limiter; `Retry-After` header |
| OTP_COOLDOWN | 429 | `errors.retryAfterSec` |
| OTP_SEND_LIMIT | 429 | 5 sends/hour reached, `errors.retryAfterSec` |
| OTP_LOCKED | 429 | 5 wrong attempts; request a new code |
| EMAIL_SEND_FAILED | 502 | OTP email could not be sent |
| PARIVESH_SYNC_FAILED | 502 | admin "sync now": PARIVESH could not be read or sent nothing usable; nothing was changed |
| MEET_CREATE_FAILED | 502 | Google failed on admin retry |
| IMAGE_UPLOAD_FAILED | 502 | Cloudinary could not store a hero image; nothing was saved |
| BAD_REQUEST | 4xx | a client error raised by the framework that has no code of its own (for example an unsupported body charset) |
| INTERNAL_ERROR | 500 | anything else; in production every 5xx |

### Common field rules

- `name`: trimmed, 2–100.
- `email`: valid, lowercased.
- `mobileNumber`: spaces/hyphens stripped, optional `+91` or `0` prefix, `^[6-9]\d{9}$`, stored and returned as `+91XXXXXXXXXX`.
- `performedBy`: 2–60. `reason` (admin): 3–300.

---

## Public: existing forms

### POST /query/new-query

Body: `{ name, email, mobileNumber, organisation?, industry?, source?, subject (3–150), query (10–5000), turnstileToken }` → 200 `data: null`.
Errors: VALIDATION_FAILED, CAPTCHA_FAILED, RATE_LIMITED (5 / 15 min / IP), 500 if the company email fails.

### POST /feedback/new-feedback  (multipart/form-data)

Fields: `type` (1–100), `name`, `email`, `mobileNumber?`, `subject` (10–100), `message` (10–5000), `turnstileToken`; file field `attachment?` (pdf/jpg/png, ≤ 5 MB) → 200 `data: null`.
Errors: as Query plus INVALID_FILE_TYPE, FILE_TOO_LARGE, UPLOAD_ERROR.

---

## Public: Virtual Meeting (`/vm`)

### POST /vm/otp/send

Body `{ email }` → 200 `data: { expiresInSec: 300, resendAfterSec: 60 }`.
Errors: VALIDATION_FAILED, OTP_COOLDOWN, OTP_SEND_LIMIT, RATE_LIMITED (10 / 15 min / IP), EMAIL_SEND_FAILED.

### POST /vm/otp/verify

Body `{ email, otp }` (6 digits) → 200 `data: { bookingToken, expiresInSec: 1800 }`.
Errors: OTP_NOT_FOUND, OTP_INVALID (`attemptsLeft`), OTP_EXPIRED, OTP_LOCKED, RATE_LIMITED (10 / 15 min / IP).

### GET /vm/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD

Max 62 days. → 200
```json
{ "days": [ { "date": "2026-10-15", "bookable": true, "reason": null, "availableCount": 3 },
            { "date": "2026-10-18", "bookable": false, "reason": "non_working_day", "availableCount": 0 } ] }
```
`reason`: null | past | beyond_horizon | non_working_day | holiday | full. `non_working_day` is every Sunday and the 2nd Saturday of the month (Monday to Saturday run otherwise).

### GET /vm/availability?date=YYYY-MM-DD

→ 200 `{ "date", "bookable", "reason", "slots": [ { "time": "10:00", "status": "available" | "booked" } ] }`. Non-bookable day → `slots: []`. Blocked, booked and too-late slots all show `"booked"`.

### POST /vm/bookings

Header `Authorization: Bearer <bookingToken>`. Body:
```json
{ "name": "Rahul Kumar", "mobileNumber": "9876543210", "organisation": "ABC Pvt Ltd",
  "designation": "Plant Head", "topic": "EIA for new unit", "date": "2026-10-15", "time": "10:00" }
```
`organisation` ≤150, `designation` ≤100, `topic` ≤500 optional. Email comes from the token; any `email` in the body is ignored.
→ 201
```json
{ "bookingId": "OE-VM-261015-K7Q2", "date": "2026-10-15", "time": "10:00", "durationMinutes": 60,
  "meetLink": "https://meet.google.com/abc-defg-hij", "meetStatus": "created" }
```
`meetLink` may be null with `meetStatus: "failed"`.
Errors: BOOKING_TOKEN_INVALID, VALIDATION_FAILED, DATE_NOT_BOOKABLE, ACTIVE_BOOKING_EXISTS, SLOT_TAKEN.

---

## Public: Callback (`/callback`)

### GET /callback/calendar?from&to

Same shape as `/vm/calendar` minus `availableCount`. `reason` full = every period full, blocked or closed.

### GET /callback/availability?date=YYYY-MM-DD

→ 200
```json
{ "date": "2026-10-15", "bookable": true, "reason": null,
  "periods": [ { "key": "morning", "label": "Morning", "timeRange": "9 AM – 12 PM", "available": true } ] }
```

### POST /callback/requests

Body `{ name, email, mobileNumber, date, period: "morning"|"afternoon"|"evening", reason? (≤500), turnstileToken }`
→ 201 `{ "requestId": "OE-CB-261015-M3XZ", "date": "2026-10-15", "period": "morning" }`.
Errors: VALIDATION_FAILED, CAPTCHA_FAILED, DATE_NOT_BOOKABLE (reason may be `closed` for past cutoff), DUPLICATE_REQUEST, PERIOD_FULL, PERIOD_BLOCKED, RATE_LIMITED.

---

## Public: Visit counter (`/visits`)

The frontend sends one `POST /visits` per browser session and shows the total in the footer. Counters live in the `visit_stats` collection (one `total` document and one document per IST day); they start at 0 and nothing is seeded.

### POST /visits

No body, no query. Counts one visit (the total and today's IST day) and answers → 200 `data: { "total": 1234 }`.
The visit is **not** counted, but the answer is still 200 with the current total, when:
- the `User-Agent` header is missing or empty, or matches `/bot|crawl|spider|slurp|preview|headless/i`, or
- the caller is over the limit of 10 requests per hour per IP.

Errors: VALIDATION_FAILED (a body or query key was sent). It never answers RATE_LIMITED.

### GET /visits/total

No body, no query. → 200 `data: { "total": 1234 }` with `Cache-Control: public, max-age=60`. Errors: VALIDATION_FAILED (a query key was sent).

---

## Public: Air quality (`/aqi`)

The latest AQI of four CPCB stations (Delhi: Chandni Chowk, Ghaziabad: Vasundhara, Chandigarh: Sector 22, Gurugram: Vikas Sadan). A background job reads them from data.gov.in (CPCB "Real time Air Quality Index") at minute 15 of every hour (IST) and once at server start, and keeps one document per station in the `aqi_readings` collection. The request never calls data.gov.in: it only reads what the job stored.

How the number is made: the source publishes each pollutant as a CPCB sub-index (0-500), already calculated from the 24 hour average (8 hour for CO and ozone), not as a concentration. The station `aqi` is the **highest sub-index** of PM2.5, PM10, NO2, O3, CO, SO2 and NH3. It is `null` when fewer than 3 of those pollutants are known, or when neither PM2.5 nor PM10 is. A station that cannot be read keeps its previous reading until the next successful run.

### GET /aqi

No body, no query. → 200
```json
{ "stations": [
  { "city": "Delhi", "station": "Chandni Chowk, Delhi - IITM", "aqi": 201, "category": "Poor",
    "sourceLastUpdate": "2026-10-19T17:30:00.000Z", "stale": false }
] }
```
- Always the four stations, in this order: Delhi, Ghaziabad, Chandigarh, Gurugram.
- `category`: `Good` (0-50), `Satisfactory` (51-100), `Moderate` (101-200), `Poor` (201-300), `Very Poor` (301-400) or `Severe` (401-500).
- `aqi` and `category` are `null` when there is no AQI (see above), or before the first successful run.
- `sourceLastUpdate`: when CPCB measured it (ISO, UTC); `null` before the first successful run.
- `stale`: `true` when `sourceLastUpdate` is more than 3 hours old, or is `null`.
- Header `Cache-Control: public, max-age=300`.

Errors: VALIDATION_FAILED (a query key was sent).

---

## Public: Updates (`/updates`)

PARIVESH "What's New" (the Ministry's orders and notifications). A background job copies the list from `https://parivesh.nic.in/ua/parivesh/StatePortal/GetStatePortalData/ALL/` into the `parivesh_updates` collection at minute 5 of every 6th hour (IST: 00:05, 06:05, 12:05, 18:05), and at server start when the last good sync is more than 6 hours old. These requests never call PARIVESH: they only read what the job stored. The sync only adds and updates, it never deletes; items the source marks unpublished are stored but never listed.

- `title`: the file name without `.pdf`. `category`: the source's document title.
- Items whose document is not on PARIVESH's own server (no `/publicdocument/` in the path, for example links to other sites) are not synced.
- `pdfUrl` is always on `https://parivesh.nic.in/publicdocument/...`, URL-encoded. The source's server path is never returned.

An item (both endpoints):
```json
{ "id": 6090, "title": "Order- Reconstitution of EAC (Thermal & Coal Mining)", "category": "Thermal Power & Coal Mining",
  "date": "2026-10-19", "sizeLabel": "4.08 MB",
  "pdfUrl": "https://parivesh.nic.in/publicdocument/UPLOAD_OM_NOTIFICATION/IA_DOCS/1003_19102026110658.pdf", "isNew": true }
```
- `id`: PARIVESH's own id. `date`: the order date as an IST `YYYY-MM-DD`, `null` when the source has none. `sizeLabel`: as the source writes it ("190.87 KB"), `null` when missing.
- `isNew`: uploaded to PARIVESH within the last 14 days.
- Newest `date` (the order date) first, so the list reads in date order from top to bottom. Items without a date come last. Items with the same date: the later upload first, then the higher `id`. Both endpoints send `Cache-Control: public, max-age=600`.

### GET /updates/latest

No body, no query. → 200 `data: { "items": [ ...the 5 published items with the newest date ] }` (fewer, or none, before there are that many). Errors: VALIDATION_FAILED (a query key was sent).

### GET /updates?page=1

`page` is optional, a whole number from 1 to 99999 (default 1); anything else is 400 `VALIDATION_FAILED`, as is any other query key.
→ 200 `data: { "items": [ ... up to 10 ], "page": 1, "pageSize": 10, "total": 489, "totalPages": 49 }`. `total` counts published items. A page past the last one answers 200 with `items: []` and the same totals; with nothing synced yet `total` and `totalPages` are 0.

---

## Public: Homepage hero (`/hero`)

The slides of the homepage hero. Two sets of slides exist in the `hero_slides` collection: `live` (shown now) and `scheduled` (the next set). The day of the switch is `heroSwitchDate` (an IST date) in the settings document. There is no timer: **the first `GET /hero` on or after that day does the switch** — the scheduled slides become live (same order), the old live slides are deleted from the database and their pictures from Cloudinary, and the date is cleared. With no scheduled slides on that day the date is just cleared and the live slides stay. Two requests at the same moment switch once.

### GET /hero

No body, no query (any key is 400 `VALIDATION_FAILED`). → 200
```json
{ "slides": [
  { "id": "6720f1c2a9b3c4d5e6f70812", "imageUrl": "https://res.cloudinary.com/<cloud>/image/upload/f_auto,q_auto,w_1920,c_limit/oceao/hero/abc123",
    "name": "Rohtang Pass", "location": "Himachal Pradesh", "description": "Early snow on the pass.", "textStyle": "dark", "credit": "Photo: A. Kumar" }
] }
```
- Live slides only, by `order` (ascending). `[]` when there are none.
- `credit` is left out when the slide has none.
- `textStyle`: `"dark"` or `"light"`, how the website colours the hero text (heading, paragraph, buttons) while this slide is on show: `dark` = dark text for light photos (the original look), `light` = light text with a soft dark shade behind it for dark photos. A slide saved before this field existed is `"dark"`.
- `imageUrl` is an HTTPS link that serves the best format and quality at most 1920 px wide; it is not the original file.
- Length limits (for the admin stage): `name` and `location` 2-80, `description` up to 120, `credit` up to 80.
- A switch that fails is logged and does not fail the request: the slides that exist are returned, and the switch is tried again on the next request.
- `Cache-Control: public, max-age=300`; after a failed switch `no-store`, because that answer may be incomplete.

Errors: VALIDATION_FAILED (a query key was sent).

---

## Admin auth (`/admin/auth`)

Session = httpOnly cookie `oe_admin` (path `/api/v1/admin`, `SameSite=Lax`, `Secure` when `NODE_ENV=production`, 8 hours). Frontend sends `credentials: "include"`.

| Method | Path | Body | 200 data | Errors |
| --- | --- | --- | --- | --- |
| POST | /admin/auth/login | `{ email, password }` | `{ email }` + Set-Cookie | INVALID_CREDENTIALS, RATE_LIMITED (5 / 15 min / IP) |
| POST | /admin/auth/logout | `{}` (no fields) | `null` (cookie cleared) | ADMIN_UNAUTHORIZED |
| GET | /admin/auth/me | (no query) | `{ email, expiresAt }` | ADMIN_UNAUTHORIZED |

All other `/admin/*` routes: ADMIN_UNAUTHORIZED without a session; writes also CSRF_REJECTED.

---

## Admin read endpoints

### GET /admin/dashboard?date=YYYY-MM-DD (default today IST)

```json
{ "date": "2026-10-15",
  "counts": { "meetings": 2, "callbacks": 5, "openVmSlots": 1, "blockedVmSlots": 1 },
  "timeline": [
    { "kind": "meeting", "time": "10:00", "bookingId": "OE-VM-261015-K7Q2", "name": "Rahul Kumar",
      "organisation": "ABC Pvt Ltd", "email": "rahul@example.com", "mobileNumber": "+919876543210",
      "topic": "EIA for new unit", "meetLink": "https://meet.google.com/abc-defg-hij", "meetStatus": "created" },
    { "kind": "callback", "time": "09:00", "period": "morning", "requestId": "OE-CB-261015-M3XZ",
      "name": "John Doe", "email": "john@example.com", "mobileNumber": "+917654321098",
      "reason": "Water testing quote", "status": "pending" },
    { "kind": "available", "time": "14:00" },
    { "kind": "blocked", "time": "16:00", "blockedBy": "Anita", "blockReason": "Site visit" }
  ] }
```
Timeline sorted by `time`; callbacks use their period start time; cancelled items excluded.

### GET /admin/bookings?from&to&type=all|vm|callback&includeCancelled=false

Max 62 days. → `{ "vmBookings": [VmBooking...], "callbackRequests": [CallbackRequest...] }` with all stored fields except `expireAt` and `googleEventId`, sorted by date then time/period.

### GET /admin/vm/calendar?month=YYYY-MM

→ `{ "month": "2026-10", "days": [ { "date", "working": true, "holidayName": null, "booked": 1, "blocked": 0, "available": 3 } ] }`

### GET /admin/vm/availability?date

→ `{ "date", "working", "holidayName", "slots": [ { "time": "10:00", "status": "available"|"booked"|"blocked", "booking": {VmBooking}|null, "block": { "blockedBy", "blockReason", "blockedAt" }|null } ] }`

### GET /admin/callback/availability?date

→ `{ "date", "working", "holidayName", "periods": [ { "key", "label", "timeRange", "capacity", "booked", "blocked", "block": {...}|null } ] }`

### GET /admin/callback/requests?date&period

→ `{ "requests": [CallbackRequest...] }` (non-cancelled).

### GET /admin/settings → `{ "callbackCapacity": { "morning": 5, "afternoon": 5, "evening": 3 } }`

### GET /admin/holidays?year=YYYY → `{ "holidays": [ { "date", "name" } ] }`

### GET /admin/visits?days=30

`days` is optional, a whole number from 1 to 90 (default 30); anything else is 400 `VALIDATION_FAILED`. → `{ "total": 1234, "daily": [ { "date": "2026-09-15", "count": 0 }, ... ] }`: `total` is the counter, `daily` has exactly `days` entries ending today (IST), oldest first, with `count: 0` for a day nobody visited.

### GET /admin/updates/sync-status

No query. → `{ "lastSuccessAt": "2026-10-19T10:00:00.000Z", "lastAttemptAt": "2026-10-19T16:30:00.000Z", "lastError": null, "itemsReceived": 489, "itemsSkipped": 159 }`.
`lastSuccessAt` / `lastAttemptAt`: ISO times, `null` before the first sync. `lastError`: a short text (never a URL or stack) when the last attempt failed, `null` after a good sync. `itemsReceived` / `itemsSkipped` are those of the last **successful** sync (skipped = no `/publicdocument/` path, or an item the source sent unusable). A failed attempt changes `lastAttemptAt` and `lastError` only. All five are `null` before the first sync.

### POST /admin/updates/sync

No body, no query (any key is 400 `VALIDATION_FAILED`). Runs a sync now (the same as the scheduled one; if one is already running it waits for that one) → 200 `{ "received": 489, "saved": 330, "inserted": 5, "updated": 1, "skipped": 159 }`: `saved` = items written (new or already stored), `inserted` = new, `updated` = existing items that changed.
If PARIVESH cannot be read or sends nothing usable → 502 `PARIVESH_SYNC_FAILED` (nothing is changed, the failure shows in sync-status). Limited to **one per 5 minutes in total**: otherwise 429 `RATE_LIMITED` with `Retry-After`. Needs a session and the usual admin write checks.

---

## Admin: Homepage hero (`/admin/hero`)

Manage the two sets of homepage hero slides (see "Public: Homepage hero" for how the switch works): `live` is on the site now, `scheduled` is the next set. Each set holds **at most 5** slides. All routes need an admin session; every write needs a trusted `Origin` and creates one audit entry. Pictures are stored in Cloudinary (folder `oceao/hero`); the API never accepts a picture URL or id from the client.

Every write takes `performedBy` (2-60 characters, the employee's name; it goes to the audit log). Text limits: `name` and `location` 2-80, `description` 1-120, `credit` 0-80 (optional).

A slide, as the admin sees it:
```json
{ "id": "6720f1c2a9b3c4d5e6f70812", "set": "live", "order": 0,
  "publicId": "oceao/hero/abc123", "url": "https://res.cloudinary.com/<cloud>/image/upload/v1/oceao/hero/abc123.jpg",
  "imageUrl": "https://res.cloudinary.com/<cloud>/image/upload/f_auto,q_auto,w_1920,c_limit/oceao/hero/abc123",
  "width": 4000, "height": 2250, "name": "Rohtang Pass", "location": "Himachal Pradesh",
  "description": "Early snow on the pass.", "credit": null, "textStyle": "dark", "createdAt": "...", "updatedAt": "..." }
```
`credit` is `null` when there is none. `textStyle` is `dark` or `light` (see the public endpoint). `imageUrl` is the link to show; `url` is the original.

### GET /admin/hero

No query. Does the planned switch first if its day has come (like the public endpoint). → 200
`{ "live": [slide, ...], "scheduled": { "switchDate": "2026-12-01" | null, "slides": [slide, ...] } }`, each list by `order`.

### POST /admin/hero/slides  (multipart/form-data)

The only admin write that is **not JSON**: send `multipart/form-data` with the picture in the file field `image` and the text fields `set` (`live` | `scheduled`), `name`, `location`, `description`, `credit` (optional; blank = none), `textStyle` (optional: `dark` | `light`, default `dark`) and `performedBy`. Any other field, a second file or a file under another name is 400.
- The picture: at most **10 MB**; its real type (from the bytes, not the name) must be JPG, PNG or WebP, otherwise 400 `INVALID_FILE_TYPE`; larger → 413 `FILE_TOO_LARGE`.
- If the set already has 5 slides → 409 `SET_FULL`, checked **before** anything is uploaded.
- The new slide goes last: `order` = highest order in the set + 1 (0 for the first).
- → 201 `data: { "slide": slide }`.
- If Cloudinary fails → 502 `IMAGE_UPLOAD_FAILED` (nothing saved). If saving fails after the upload, the uploaded picture is deleted from Cloudinary again.
Errors: VALIDATION_FAILED, INVALID_FILE_TYPE, FILE_TOO_LARGE, UPLOAD_ERROR, SET_FULL, IMAGE_UPLOAD_FAILED.

### PATCH /admin/hero/slides/:id

JSON body: any of `name`, `location`, `description`, `credit`, `textStyle` (at least one) plus `performedBy`. `credit: ""` or `null` removes the credit; `textStyle` is `dark` or `light`. **The picture cannot be changed**: `image`, `publicId`, `url`, `set`, `order` or any other field is 400 (delete the slide and add a new one instead). → 200 `data: { "slide": slide }`. Errors: VALIDATION_FAILED, NOT_FOUND.

### DELETE /admin/hero/slides/:id

JSON body `{ "performedBy" }`. Deletes the slide from the database first, then its picture from Cloudinary (a Cloudinary failure is logged, it does not fail the request), then renumbers the remaining slides of that set `0..n-1` in their current order. → 200 `data: { "id", "set", "remaining": 2 }`. Errors: VALIDATION_FAILED, NOT_FOUND.

### PUT /admin/hero/order

JSON body `{ "set": "live", "ids": ["<id>", ...], "performedBy" }`. `ids` must be **exactly** the ids of the slides in that set, each once, in the new order; anything missing, extra, repeated or from another set is 400 `VALIDATION_FAILED` (`errors.ids`) and nothing changes. The new order is saved with one bulk write. → 200 `data: { "set": "live", "slides": [slide, ...] }`.

### PUT /admin/hero/schedule

JSON body `{ "switchDate": "2026-12-01", "performedBy" }`. The date must be **after today** in India time: today or earlier is 422 `INVALID_SWITCH_DATE`; a malformed date is 400. Replaces any earlier date. → 200 `data: { "switchDate": "2026-12-01", "scheduledSlides": 3 }`. (With no scheduled slides on that day the switch just clears the date and the live slides stay.)

### DELETE /admin/hero/schedule

JSON body `{ "performedBy" }`. Removes the planned date; the scheduled slides stay as a draft and no picture is deleted. Also fine when nothing was planned. → 200 `data: { "switchDate": null, "scheduledSlides": 3 }`.

Audit actions: `hero.slide.add`, `hero.slide.edit`, `hero.slide.delete` (target: the slide id), `hero.order` (target: the set), `hero.schedule.set` and `hero.schedule.clear` (target: `heroSwitchDate`).

---

## Admin VM actions

| Method | Path | Body | 200 data |
| --- | --- | --- | --- |
| POST | /admin/vm/blocks | `{ date, time? , allDay?, performedBy, reason }` (exactly one of time/allDay) | `{ blocked: ["10:00"], skipped: [ { time, reason: "booked"|"already_blocked" } ] }` |
| POST | /admin/vm/blocks/remove | `{ date, time?, allDay?, performedBy, reason }` | `{ unblocked: ["10:00"] }` |
| POST | /admin/vm/bookings/:bookingId/cancel | `{ performedBy, reason, alsoBlock: boolean }` | `{ bookingId, status: "cancelled", slot: "released"|"blocked" }` |
| POST | /admin/vm/bookings/:bookingId/retry-meet | `{ performedBy }` | `{ bookingId, meetLink, meetStatus: "created" }` |

Errors: DATE_NOT_BOOKABLE (past/non-working for blocks), NOT_FOUND, NOT_CANCELLABLE, MEET_ALREADY_CREATED, MEET_CREATE_FAILED.

## Admin callback and settings actions

| Method | Path | Body | 200 data |
| --- | --- | --- | --- |
| POST | /admin/callback/blocks | `{ date, period?, allDay?, performedBy, reason }` | `{ blocked: ["morning"] }` |
| POST | /admin/callback/blocks/remove | `{ date, period?, allDay?, performedBy, reason }` | `{ unblocked: ["morning"] }` |
| POST | /admin/callback/requests/cancel | `{ requestIds: [..] (1–50), performedBy, reason }` | `{ cancelled: [ids], skipped: [ { id, reason: "not_found"\|"already_cancelled"\|"not_pending" } ] }` |
| PATCH | /admin/callback/requests/:requestId | `{ status: "pending"\|"completed"\|"no_answer", performedBy }` | `{ requestId, status }` (409 `CONFLICT` if the request is cancelled) |
| PUT | /admin/settings/callback-capacity | `{ morning, afternoon, evening (0–50), performedBy, reason }` | `{ callbackCapacity }` |
| POST | /admin/holidays | `{ date, name (2–100), performedBy, reason }` | `{ holiday, affected: { vmBookings, callbackRequests } }` (409 `CONFLICT` if the date is already a holiday) |
| POST | /admin/holidays/bulk | `{ holidays: [ { date, name } ] (1–60), performedBy, reason }` | `{ added: [dates], skipped: [ { date, reason: "exists"|"closed_by_rule" } ], affected: { vmBookings, callbackRequests } }` |
| PATCH | /admin/holidays/:date | `{ name, performedBy, reason }` | `{ holiday }` |
| DELETE | /admin/holidays/:date | `{ performedBy, reason }` | `{ date }` |

Adding a Sunday or second Saturday to `POST /admin/holidays` returns 422 `ALREADY_CLOSED` (bulk skips it with `closed_by_rule`).

Blocking a callback period never cancels existing requests. Lowering capacity never cancels anyone.

## Health

`GET /health` (no `/api/v1` prefix, not rate limited, no session needed) → 200 `{ "status": "ok", "db": "up", "uptime": 123 }` while MongoDB is connected, otherwise 503 `{ "status": "unavailable", "db": "down", "uptime": 123 }`. `uptime` is whole seconds since the process started.
