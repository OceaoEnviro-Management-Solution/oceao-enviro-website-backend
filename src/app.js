import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { errorHandler } from './middlewares/error.middleware.js'
const app = express();

console.log("CORS_ORIGIN:", process.env.CORS_ORIGIN);
app.use(cors({
    origin: process.env.CORS_ORIGIN,
    credentials: true,
}))

app.use(express.json({ limit: "20kb" }))

app.use(express.urlencoded({
    extended: true,
    limit: "20kb"
}))

app.use(express.static("public"))

app.use(cookieParser())

import { queryRouter } from "./routes/query.route.js"
import { feedbackRouter } from "./routes/feedback.route.js"

app.use("/health", (req, res) => {
    res.status(200).json({ message: "ok" })
})

app.use("/api/v1/query", queryRouter)
app.use("/api/v1/feedback", feedbackRouter)

app.use(errorHandler);
export { app }