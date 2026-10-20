// Homepage hero slides: what an admin may upload and how many slides a set holds.
// (The text limits live with the model: models/heroSlide.model.js.)

export const HERO = Object.freeze({
    // A set (live or scheduled) holds at most this many slides
    maxSlidesPerSet: 5,
    // Largest image accepted by POST /admin/hero/slides
    maxImageBytes: 10 * 1024 * 1024,
    // The real type of the bytes (not the name or the declared type) must be one of these
    allowedMimeTypes: Object.freeze(["image/jpeg", "image/png", "image/webp"]),
});
