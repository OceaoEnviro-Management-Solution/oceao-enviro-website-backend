// Homepage hero slides: the timed switch from the "scheduled" set to the "live" set, and the public list.
//
// The switch happens on the day set in Settings.heroSwitchDate (an IST date), by the first request
// that arrives on or after that day: there is no timer to keep running. promoteIfDue() is what
// GET /hero calls first.
//
// MongoDB runs without transactions here, so the switch is ordered to be safe on its own:
//   1. claim it: clear heroSwitchDate with a findOneAndUpdate that only matches the date it just
//      read. When two requests race, one gets the document back and carries on, the other gets null.
//   2. note the live slides, 3. delete them, 4. turn every scheduled slide live (order unchanged),
//   5. only then delete the old pictures from Cloudinary (which never throws).
// If the database fails between 1 and 4, the date is put back so the next request tries again.

import { HeroSlide } from "../models/heroSlide.model.js";
import { Settings, SETTINGS_KEY } from "../models/settings.model.js";
import { logger } from "../utils/logger.js";
import { nowIST } from "../utils/time.js";
import { buildDeliveryUrl, deleteImage } from "./cloudinary.service.js";

/**
 * One attempt at the switch (no sharing between callers: the database decides the winner).
 * @returns {Promise<{ promoted: boolean, reason: string, promotedCount?: number, removedCount?: number }>}
 *   reason: "not_due" | "lost_race" | "no_scheduled_slides" | "promoted"
 */
export const runPromotion = async ({ now = new Date() } = {}) => {
    const today = nowIST(now).dateKey;

    const settings = await Settings.findOne({ key: SETTINGS_KEY }).select({ heroSwitchDate: 1 }).lean();
    const dueDate = settings?.heroSwitchDate ?? null;
    if (!dueDate || dueDate > today) return { promoted: false, reason: "not_due" };

    // 1. Claim the switch. Only the caller that clears the very date it read goes on.
    const claimed = await Settings.findOneAndUpdate(
        { key: SETTINGS_KEY, heroSwitchDate: dueDate },
        { $set: { heroSwitchDate: null } }
    );
    if (!claimed) return { promoted: false, reason: "lost_race" };

    let removedIds = [];
    try {
        // Nothing planned to show: the date is cleared and the live slides stay.
        if ((await HeroSlide.countDocuments({ set: "scheduled" })) === 0) {
            logger.info("Hero switch date reached with no scheduled slides: the live slides stay");
            return { promoted: false, reason: "no_scheduled_slides" };
        }

        // 2. and 3. The live slides go (by id: a slide added meanwhile is not touched).
        const oldSlides = await HeroSlide.find({ set: "live" }).select({ publicId: 1 }).lean();
        await HeroSlide.deleteMany({ _id: { $in: oldSlides.map((slide) => slide._id) } });
        removedIds = oldSlides.map((slide) => slide.publicId);

        // 4. The scheduled slides become the live ones, keeping their order.
        const promoted = await HeroSlide.updateMany({ set: "scheduled" }, { $set: { set: "live" } });

        // 5. The database is right now: the old pictures can go.
        await Promise.all(oldSlides.map((slide) => deleteImage(slide.publicId)));

        logger.info(`Hero switch done: ${promoted.modifiedCount} slides are live, ${oldSlides.length} removed`);
        return { promoted: true, reason: "promoted", promotedCount: promoted.modifiedCount, removedCount: oldSlides.length };
    } catch (error) {
        // Their database rows are gone, so the retry cannot find these pictures: say which they were.
        if (removedIds.length > 0) logger.warn("Hero switch failed after deleting slides; these Cloudinary images were not deleted", { publicIds: removedIds });
        // Put the date back (only if nobody planned a new one meanwhile) so the next request retries.
        await Settings.updateOne({ key: SETTINGS_KEY, heroSwitchDate: null }, { $set: { heroSwitchDate: dueDate } })
            .catch((restoreError) => logger.error("Hero switch date could not be put back", restoreError));
        throw error;
    }
};

let running = null;

/**
 * Switches the slide sets when the date is due. Requests of this server that arrive while the
 * switch is running wait for it, so none of them sees the half-done state (and caches it);
 * another server is held back by the database claim in runPromotion.
 */
export const promoteIfDue = ({ now = new Date() } = {}) => {
    if (!running) {
        running = runPromotion({ now }).finally(() => { running = null; });
    }
    return running;
};

/** The slides the homepage shows now, by order. credit is left out when there is none. */
export const getLiveSlides = async () => {
    const slides = await HeroSlide.find({ set: "live" }).sort({ order: 1, _id: 1 }).lean();

    return slides.map((slide) => ({
        id: String(slide._id),
        imageUrl: buildDeliveryUrl(slide.publicId),
        name: slide.name,
        location: slide.location,
        description: slide.description,
        ...(slide.credit ? { credit: slide.credit } : {}),
    }));
};
