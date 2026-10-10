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

`errors` holds field errors for 400 `VALIDATION_FAILED` as `{ "fieldName": ["message", ...] }`, otherwise `{}` or a small object stated per endpoint (e.g. `{ "attemptsLeft": 3 }`). Production 5xx always returns code `INTERNAL_ERROR` with a generic message.

| Code | Status | Meaning |
| --- | --- | --- |
| VALIDATION_FAILED | 400 | zod failure, see `errors` |
| INVALID_JSON | 400 | malformed JSON body |
| CAPTCHA_FAILED | 400 | Turnstile missing/invalid |
| INVALID_FILE_TYPE | 400 | not pdf/jpg/png by content |
| UPLOAD_ERROR | 400 | other multer error |
| OTP_NOT_FOUND | 400 | no active code for email |
| OTP_INVALID | 400 | wrong code, `errors.attemptsLeft` |
| BOOKING_TOKEN_INVALID | 401 | missing/expired/wrong booking token |
| INVALID_CREDENTIALS | 401 | admin login failed |
| ADMIN_UNAUTHORIZED | 401 | no/invalid admin session |
| CSRF_REJECTED | 403 | admin write from bad Origin/content type |
| NOT_FOUND | 404 | route or resource not found |
| SLOT_TAKEN | 409 | VM slot booked or blocked |
| ACTIVE_BOOKING_EXISTS | 409 | email already has an upcoming VM booking |
| PERIOD_FULL | 409 | callback period at capacity |
| PERIOD_BLOCKED | 409 | callback period blocked |
| DUPLICATE_REQUEST | 409 | same email already pending on that date |
| NOT_CANCELLABLE | 409 | booking already cancelled or started |
| MEET_ALREADY_CREATED | 409 | retry on a booking that has a link |
| CONFLICT | 409 | other duplicate key |
| OTP_EXPIRED | 410 | code expired |
| FILE_TOO_LARGE | 413 | > 5 MB |
| PAYLOAD_TOO_LARGE | 413 | body > 20 kb |
| DATE_NOT_BOOKABLE | 422 | `errors.reason` = past, beyond_horizon, non_working_day, holiday, invalid_date, closed |
| RATE_LIMITED | 429 | IP limiter; `Retry-After` header |
| OTP_COOLDOWN | 429 | `errors.retryAfterSec` |
| OTP_SEND_LIMIT | 429 | 5 sends/hour reached, `errors.retryAfterSec` |
| OTP_LOCKED | 429 | 5 wrong attempts; request a new code |
| EMAIL_SEND_FAILED | 502 | OTP email could not be sent |
| MEET_CREATE_FAILED | 502 | Google failed on admin retry |
| INTERNAL_ERROR | 500 | anything else |

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
Errors: OTP_NOT_FOUND, OTP_INVALID (`attemptsLeft`), OTP_EXPIRED, OTP_LOCKED, RATE_LIMITED.

### GET /vm/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD

Max 62 days. → 200
```json
{ "days": [ { "date": "2026-10-15", "bookable": true, "reason": null, "availableCount": 3 },
            { "date": "2026-10-17", "bookable": false, "reason": "non_working_day", "availableCount": 0 } ] }
```
`reason`: null | past | beyond_horizon | non_working_day | holiday | full.

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

## Admin auth (`/admin/auth`)

Session = httpOnly cookie `oe_admin` (path `/api/v1/admin`). Frontend sends `credentials: "include"`.

| Method | Path | Body | 200 data | Errors |
| --- | --- | --- | --- | --- |
| POST | /admin/auth/login | `{ email, password }` | `{ email }` + Set-Cookie | INVALID_CREDENTIALS, RATE_LIMITED (5 / 15 min / IP) |
| POST | /admin/auth/logout | `{}` | `null` (cookie cleared) | |
| GET | /admin/auth/me | | `{ email, expiresAt }` | ADMIN_UNAUTHORIZED |

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
| POST | /admin/callback/requests/cancel | `{ requestIds: [..] (1–50), performedBy, reason }` | `{ cancelled: [ids], skipped: [ { id, reason } ] }` |
| PATCH | /admin/callback/requests/:requestId | `{ status: "pending"|"completed"|"no_answer", performedBy }` | `{ requestId, status }` |
| PUT | /admin/settings/callback-capacity | `{ morning, afternoon, evening (0–50), performedBy, reason }` | `{ callbackCapacity }` |
| POST | /admin/holidays | `{ date, name (2–100), performedBy, reason }` | `{ holiday, affected: { vmBookings, callbackRequests } }` |
| DELETE | /admin/holidays/:date | `{ performedBy, reason }` | `{ date }` |

Blocking a callback period never cancels existing requests. Lowering capacity never cancels anyone.

## Health

`GET /health` → 200 `{ status: "ok", db: "up", uptime }` or 503 with `db: "down"`.
