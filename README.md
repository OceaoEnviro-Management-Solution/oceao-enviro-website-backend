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
# edit .env: at minimum set MONGODB_URI
npm run dev
```

The API runs at `http://localhost:8000` (API base: `http://localhost:8000/api/v1`). The frontend is expected at `http://localhost:5173`.

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Starts the server with nodemon and loads `.env` |
| `npm start` | Starts the server with `node` |

More scripts (tests, seeding, admin password hashing) arrive in later stages of the roadmap.

## Folder structure

```
src/
  app.js              Express app (no DB connect, so tests can import it)
  index.js            loads env, connects DB, starts the server
  config/             env.js (validated env), booking.js (business rules)
  routes/  controllers/  services/  models/  middlewares/  validators/  utils/
  services/email/     transporter, sendMail, templates
scripts/              seed and maintenance scripts
data/                 static data such as holidays.json
tests/                backend tests
docs/                 AGENT_CONTEXT.md, API_CONTRACT.md
```

Request flow: route, then multer, then Turnstile, then Zod validation, then controller, then service, then model or email. Folders not yet present in the repo are added in later stages.

## Documentation

- [API contract](docs/API_CONTRACT.md): endpoints, request and response shapes, error codes
- [Agent context](docs/AGENT_CONTEXT.md): project rules, business rules, data model, environment variables
