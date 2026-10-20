// Admin side of the homepage hero: add, edit, delete and reorder slides, and plan the switch.
// Two sets exist, "live" and "scheduled", of at most 5 slides each (services/hero.service.js
// does the switch itself). Every write records one audit entry AFTER the change is saved.
//
// MongoDB runs without transactions, so each write is ordered to fail safely:
//   add     checks the set is not full, THEN uploads, then saves; a failed save deletes the upload
//   delete  removes the database row first, then the picture (a failed picture delete is only logged)

import { HERO } from "../config/hero.js";
import { HeroSlide } from "../models/heroSlide.model.js";
import { Settings, SETTINGS_KEY } from "../models/settings.model.js";
import { ApiError } from "../utils/ApiError.js";
import { logger } from "../utils/logger.js";
import { nowIST } from "../utils/time.js";
import { recordAudit } from "./audit.service.js";
import { buildDeliveryUrl, deleteImage, uploadImage } from "./cloudinary.service.js";
import { promoteIfDue } from "./hero.service.js";

const BY_ORDER = { order: 1, _id: 1 };

/** A slide with every field the admin screen needs, including the picture's id and delivery link. */
export const toAdminSlide = (slide) => ({
    id: String(slide._id),
    set: slide.set,
    order: slide.order,
    publicId: slide.publicId,
    url: slide.url,
    imageUrl: buildDeliveryUrl(slide.publicId),
    width: slide.width,
    height: slide.height,
    name: slide.name,
    location: slide.location,
    description: slide.description,
    credit: slide.credit ?? null,
    createdAt: slide.createdAt,
    updatedAt: slide.updatedAt,
});

const notFound = () => new ApiError(404, "NOT_FOUND", "Slide not found.");

const setIsFull = (set) =>
    new ApiError(409, "SET_FULL", `The ${set} set already has ${HERO.maxSlidesPerSet} slides. Delete one first.`);

/** The two sets as the admin screen shows them. Does the planned switch first when its day has come. */
export const getAdminHero = async () => {
    try {
        await promoteIfDue();
    } catch (error) {
        logger.error("Hero switch failed", error);
    }

    const [slides, settings] = await Promise.all([
        HeroSlide.find().sort(BY_ORDER).lean(),
        Settings.findOne({ key: SETTINGS_KEY }).select({ heroSwitchDate: 1 }).lean(),
    ]);

    return {
        live: slides.filter((slide) => slide.set === "live").map(toAdminSlide),
        scheduled: {
            switchDate: settings?.heroSwitchDate ?? null,
            slides: slides.filter((slide) => slide.set === "scheduled").map(toAdminSlide),
        },
    };
};

/** Adds a slide at the end of its set. `file` is multer's memory file. */
export const addSlide = async ({ set, name, location, description, credit, performedBy }, file) => {
    // 1. Refuse a full set before anything is uploaded.
    if ((await HeroSlide.countDocuments({ set })) >= HERO.maxSlidesPerSet) throw setIsFull(set);

    // 2. Upload.
    let uploaded;
    try {
        uploaded = await uploadImage(file.buffer);
    } catch {
        throw new ApiError(502, "IMAGE_UPLOAD_FAILED", "The image could not be uploaded. Please try again, or use a different image.");
    }

    // 3. Save. Whatever goes wrong from here on, the uploaded picture must not stay behind.
    let slide;
    try {
        const last = await HeroSlide.findOne({ set }).sort({ order: -1 }).select({ order: 1 }).lean();
        slide = await HeroSlide.create({
            set,
            order: last ? last.order + 1 : 0,
            publicId: uploaded.publicId,
            url: uploaded.url,
            width: uploaded.width,
            height: uploaded.height,
            name,
            location,
            description,
            ...(credit ? { credit } : {}),
        });

        // Two uploads at the same moment can both pass the check above: the one that overshoots backs out.
        if ((await HeroSlide.countDocuments({ set })) > HERO.maxSlidesPerSet) {
            await HeroSlide.deleteOne({ _id: slide._id });
            await deleteImage(uploaded.publicId);
            throw setIsFull(set);
        }
    } catch (error) {
        if (!slide) await deleteImage(uploaded.publicId);
        throw error;
    }

    await recordAudit({
        action: "hero.slide.add",
        targetType: "hero_slide",
        targetId: String(slide._id),
        detail: { set, order: slide.order },
        performedBy,
    });

    return toAdminSlide(slide.toObject());
};

/** Edits the texts of a slide. The picture is never touched. credit "" or null removes the credit. */
export const updateSlide = async (id, { performedBy, ...fields }) => {
    const changes = Object.keys(fields).filter((key) => fields[key] !== undefined);
    const update = { $set: {}, $unset: {} };
    for (const key of changes) {
        if (key === "credit" && !fields.credit) update.$unset.credit = "";
        else update.$set[key] = fields[key];
    }
    if (Object.keys(update.$set).length === 0) delete update.$set;
    if (Object.keys(update.$unset).length === 0) delete update.$unset;

    const slide = await HeroSlide.findByIdAndUpdate(id, update, { new: true, runValidators: true }).lean();
    if (!slide) throw notFound();

    await recordAudit({
        action: "hero.slide.edit",
        targetType: "hero_slide",
        targetId: id,
        detail: { set: slide.set, fields: changes },
        performedBy,
    });

    return toAdminSlide(slide);
};

/** Deletes a slide (database first, then the picture) and renumbers the rest of its set 0..n-1. */
export const deleteSlide = async (id, { performedBy }) => {
    const slide = await HeroSlide.findByIdAndDelete(id).lean();
    if (!slide) throw notFound();

    await deleteImage(slide.publicId);

    const remaining = await HeroSlide.find({ set: slide.set }).sort(BY_ORDER).select({ _id: 1 }).lean();
    if (remaining.length > 0) {
        await HeroSlide.bulkWrite(
            remaining.map(({ _id }, index) => ({ updateOne: { filter: { _id }, update: { $set: { order: index } } } }))
        );
    }

    await recordAudit({
        action: "hero.slide.delete",
        targetType: "hero_slide",
        targetId: id,
        detail: { set: slide.set, remaining: remaining.length },
        performedBy,
    });

    return { id, set: slide.set, remaining: remaining.length };
};

/** Sets the order of a set. `ids` must be exactly the ids of the set's slides, each once. */
export const setOrder = async ({ set, ids, performedBy }) => {
    const current = await HeroSlide.find({ set }).select({ _id: 1 }).lean();
    const currentIds = new Set(current.map(({ _id }) => String(_id)));
    const given = ids.map((id) => id.toLowerCase());

    const exact = new Set(given).size === given.length && given.length === currentIds.size && given.every((id) => currentIds.has(id));
    if (!exact) {
        throw new ApiError(400, "VALIDATION_FAILED", "Validation failed", {
            ids: [`ids must be exactly the ids of the ${currentIds.size} slides in the ${set} set, each once`],
        });
    }

    if (given.length > 0) {
        await HeroSlide.bulkWrite(
            given.map((id, index) => ({ updateOne: { filter: { _id: id, set }, update: { $set: { order: index } } } }))
        );
    }

    await recordAudit({
        action: "hero.order",
        targetType: "hero_set",
        targetId: set,
        detail: { ids: given },
        performedBy,
    });

    const slides = await HeroSlide.find({ set }).sort(BY_ORDER).lean();
    return { set, slides: slides.map(toAdminSlide) };
};

/** Plans the switch for a day after today (IST). The scheduled slides replace the live ones that day. */
export const setSchedule = async ({ switchDate, performedBy }) => {
    if (switchDate <= nowIST().dateKey) {
        throw new ApiError(422, "INVALID_SWITCH_DATE", "The switch date must be after today.", {
            switchDate: ["Must be a date after today (India time)"],
        });
    }

    const previous = await Settings.findOneAndUpdate(
        { key: SETTINGS_KEY },
        { $set: { heroSwitchDate: switchDate }, $setOnInsert: { key: SETTINGS_KEY } },
        { upsert: true, new: false, runValidators: true }
    ).lean();

    await recordAudit({
        action: "hero.schedule.set",
        targetType: "settings",
        targetId: "heroSwitchDate",
        date: switchDate,
        detail: { previous: previous?.heroSwitchDate ?? null },
        performedBy,
    });

    return { switchDate, scheduledSlides: await HeroSlide.countDocuments({ set: "scheduled" }) };
};

/** Removes the planned switch. The scheduled slides stay as a draft. */
export const clearSchedule = async ({ performedBy }) => {
    const previous = await Settings.findOneAndUpdate(
        { key: SETTINGS_KEY },
        { $set: { heroSwitchDate: null } },
        { new: false }
    ).lean();

    await recordAudit({
        action: "hero.schedule.clear",
        targetType: "settings",
        targetId: "heroSwitchDate",
        detail: { previous: previous?.heroSwitchDate ?? null },
        performedBy,
    });

    return { switchDate: null, scheduledSlides: await HeroSlide.countDocuments({ set: "scheduled" }) };
};
