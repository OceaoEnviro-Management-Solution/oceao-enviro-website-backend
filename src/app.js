import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import mongoose from 'mongoose'
import { config } from './config/env.js'
import { SECURITY } from './config/security.js'
import { requestId, bindRequestContext } from './middlewares/requestId.js'
import { errorHandler, notFoundHandler } from './middlewares/error.middleware.js'
import { globalLimiter } from './middlewares/rateLimit.js'
import { queryRouter } from "./routes/query.route.js"
import { feedbackRouter } from "./routes/feedback.route.js"
import { vmRouter } from "./routes/vm.route.js"
import { callbackRouter } from "./routes/callback.route.js"
import { adminRouter } from "./routes/admin.route.js"
import { visitsRouter } from "./routes/visits.route.js"
import { aqiRouter } from "./routes/aqi.route.js"
import { updatesRouter } from "./routes/updates.route.js"

const app = express();

app.set("trust proxy", config.TRUST_PROXY);

// First, so every response (including 404, 429 and parse errors) has an X-Request-Id.
app.use(requestId)

app.use(helmet(SECURITY.helmet))

app.use(cors({
    origin: config.CORS_ORIGINS,
    credentials: true,
}))

app.use("/api", globalLimiter)

app.use(express.json({ limit: SECURITY.bodyLimit }))

app.use(express.urlencoded({
    extended: true,
    limit: SECURITY.bodyLimit
}))

// The body parsers drop the request context; enter it again for everything after them.
app.use(bindRequestContext)

app.use(cookieParser())

// Liveness plus database state: 200 when mongoose is connected (readyState 1), otherwise 503.
app.get("/health", (req, res) => {
    const dbUp = mongoose.connection.readyState === 1
    res.status(dbUp ? 200 : 503).json({
        status: dbUp ? "ok" : "unavailable",
        db: dbUp ? "up" : "down",
        uptime: Math.round(process.uptime()),
    })
})

app.use("/api/v1/query", queryRouter)
app.use("/api/v1/feedback", feedbackRouter)
app.use("/api/v1/vm", vmRouter)
app.use("/api/v1/callback", callbackRouter)
app.use("/api/v1/visits", visitsRouter)
app.use("/api/v1/aqi", aqiRouter)
app.use("/api/v1/updates", updatesRouter)
app.use("/api/v1/admin", adminRouter)

app.use(notFoundHandler);
app.use(errorHandler);
export { app }
