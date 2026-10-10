import { BOOKING } from "../config/booking.js";
import { Settings, SETTINGS_KEY, CAPACITY_LIMITS } from "../models/settings.model.js";
import { ApiError } from "../utils/ApiError.js";

const PERIODS = BOOKING.callback.periodOrder;

const defaultCapacity = () =>
    Object.fromEntries(PERIODS.map((period) => [period, BOOKING.callback.periods[period].defaultCapacity]));

const isValidCapacity = (value) =>
    Number.isInteger(value) && value >= CAPACITY_LIMITS.min && value <= CAPACITY_LIMITS.max;

/**
 * Callback capacity per period: { morning, afternoon, evening }.
 * Uses the saved settings, falling back to config defaults when there is no document
 * (or a stored value is unusable).
 */
const getCallbackCapacity = async () => {
    const defaults = defaultCapacity();
    const settings = await Settings.findOne({ key: SETTINGS_KEY }).lean();
    const saved = settings?.callbackCapacity ?? {};

    return Object.fromEntries(
        PERIODS.map((period) => [period, isValidCapacity(saved[period]) ? saved[period] : defaults[period]])
    );
};

/**
 * Saves the callback capacity. Every period is required and must be a whole number
 * from CAPACITY_LIMITS.min to CAPACITY_LIMITS.max. Lowering capacity never touches
 * existing requests.
 */
const setCallbackCapacity = async (capacity) => {
    const errors = {};
    const input = capacity && typeof capacity === "object" && !Array.isArray(capacity) ? capacity : {};

    for (const period of PERIODS) {
        if (!isValidCapacity(input[period])) {
            errors[period] = [
                `${period} capacity must be a whole number from ${CAPACITY_LIMITS.min} to ${CAPACITY_LIMITS.max}`,
            ];
        }
    }
    for (const key of Object.keys(input)) {
        if (!PERIODS.includes(key)) {
            errors[key] = [`${key} is not a callback period`];
        }
    }
    if (Object.keys(errors).length > 0) {
        throw new ApiError(400, "VALIDATION_FAILED", "Validation failed", errors);
    }

    const next = Object.fromEntries(PERIODS.map((period) => [period, input[period]]));

    await Settings.findOneAndUpdate(
        { key: SETTINGS_KEY },
        { $set: { callbackCapacity: next }, $setOnInsert: { key: SETTINGS_KEY } },
        { upsert: true, new: true, runValidators: true }
    );

    return next;
};

export { getCallbackCapacity, setCallbackCapacity };
