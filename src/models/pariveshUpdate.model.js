import mongoose, { Schema } from "mongoose";

// One PARIVESH "What's New" document (services/parivesh/sync.js upserts them by pariveshId).
//   title        the file name without its .pdf
//   category     the source's documentTitle
//   orderDate    the date of the order itself (can be missing in the source)
//   uploadedOn   when PARIVESH published it: decides the order and "new"
//   pdfUrl       the public link, built from the source's documentPath (which is not stored)
//   published    false = stored but never shown
//   firstSeenAt  when this server first saw it (set once, on insert)
// The sync never deletes anything.
const pariveshUpdateSchema = new Schema({
    pariveshId: {
        type: Number,
        required: true,
        validate: { validator: Number.isInteger, message: "{PATH} must be a whole number" },
    },
    title: { type: String, required: true, trim: true },
    category: { type: String, default: "", trim: true },
    orderDate: { type: Date, default: null },
    uploadedOn: { type: Date, required: true },
    sizeLabel: { type: String, default: null, trim: true },
    pdfUrl: { type: String, required: true, trim: true },
    published: { type: Boolean, required: true, default: false },
    firstSeenAt: { type: Date, required: true },
}, {
    strict: true,
    timestamps: false,
    collection: "parivesh_updates",
});

pariveshUpdateSchema.index({ pariveshId: 1 }, { unique: true });
pariveshUpdateSchema.index({ published: 1, uploadedOn: -1 });

export const PariveshUpdate = mongoose.model("PariveshUpdate", pariveshUpdateSchema);
