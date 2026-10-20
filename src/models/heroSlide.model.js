import mongoose, { Schema } from "mongoose";

export const HERO_SETS = Object.freeze(["live", "scheduled"]);

// How the hero text (heading, paragraph, buttons) is coloured while this slide is on show:
//   "dark"   dark text, for light photos (the original look, and the default)
//   "light"  light text with a soft dark shade behind it, for dark photos
export const HERO_TEXT_STYLES = Object.freeze(["dark", "light"]);

export const HERO_LIMITS = Object.freeze({
    name: { min: 2, max: 80 },
    location: { min: 2, max: 80 },
    description: { max: 120 },
    credit: { max: 80 },
});

const wholeNumber = { validator: Number.isInteger, message: "{PATH} must be a whole number" };

// One homepage hero slide. Two sets exist at a time:
//   "live"       what the homepage shows now
//   "scheduled"  the next set, waiting for Settings.heroSwitchDate (services/hero.service.js)
// publicId is the Cloudinary id of the picture, which belongs to exactly one slide.
const heroSlideSchema = new Schema({
    set: { type: String, required: true, enum: HERO_SETS },
    order: { type: Number, required: true, min: 0, validate: wholeNumber },
    publicId: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    width: { type: Number, required: true, min: 1, validate: wholeNumber },
    height: { type: Number, required: true, min: 1, validate: wholeNumber },
    name: { type: String, required: true, trim: true, minlength: HERO_LIMITS.name.min, maxlength: HERO_LIMITS.name.max },
    location: { type: String, required: true, trim: true, minlength: HERO_LIMITS.location.min, maxlength: HERO_LIMITS.location.max },
    description: { type: String, required: true, trim: true, maxlength: HERO_LIMITS.description.max },
    credit: { type: String, trim: true, maxlength: HERO_LIMITS.credit.max },
    textStyle: { type: String, enum: HERO_TEXT_STYLES, default: "dark" },
}, {
    strict: true,
    timestamps: true,
    collection: "hero_slides",
});

heroSlideSchema.index({ publicId: 1 }, { unique: true });
heroSlideSchema.index({ set: 1, order: 1 });

export const HeroSlide = mongoose.model("HeroSlide", heroSlideSchema);
