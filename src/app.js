import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import { config } from './config/env.js'
import { errorHandler, notFoundHandler } from './middlewares/error.middleware.js'
import { globalLimiter } from './middlewares/rateLimit.js'
import { queryRouter } from "./routes/query.route.js"
import { feedbackRouter } from "./routes/feedback.route.js"
import { vmRouter } from "./routes/vm.route.js"

const app = express();

app.set("trust proxy", config.TRUST_PROXY);

app.use(helmet())

app.use(cors({
    origin: config.CORS_ORIGINS,
    credentials: true,
}))

app.use("/api", globalLimiter)

app.use(express.json({ limit: "20kb" }))

app.use(express.urlencoded({
    extended: true,
    limit: "20kb"
}))

app.use(cookieParser())

app.use("/health", (req, res) => {
    res.status(200).json({ message: "ok" })
})

app.use("/api/v1/query", queryRouter)
app.use("/api/v1/feedback", feedbackRouter)
app.use("/api/v1/vm", vmRouter)

app.use(notFoundHandler);
app.use(errorHandler);
export { app }
