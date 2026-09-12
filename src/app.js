import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
const app = express();
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

app.use("/api/v1/query", queryRouter)
app.use("/health", (req, res) => {
    res.status(200).json({ message: "ok" })
})
export { app }