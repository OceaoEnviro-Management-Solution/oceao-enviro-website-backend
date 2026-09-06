import mongoose, { Schema } from "mongoose";

const clientSchema = new Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
    },
    mobileNumber: {
        type: String,
        required: true
    },
    organisation: {
        type: String,
    },
    designation: {
        type: String,
    }

}, {
    timestamps: true
})

export const Client = mongoose.model("Client", clientSchema)