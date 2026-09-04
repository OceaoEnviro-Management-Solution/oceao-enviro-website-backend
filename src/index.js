import dotenv from "dotenv"
import connectDB from "./db/index.js"
import { app } from "./app.js"

dotenv.config({
    path: './.env'
})

connectDB()
    .then(() => {
        app.on("error", () => {
            console.log("ERROR connected successfully but cannot be able to talk to DB", error);
            throw error
        })
        app.listen(process.env.PORT,
            () => {
                console.log(`server is running at port: ${process.env.PORT}`)
            }
        )
    })
    .catch((err) => {
        console.log(`MONGODB connection failed in the catch block !! ${err}`)
    })