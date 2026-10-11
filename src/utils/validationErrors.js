import { z } from "zod";

const MAX_NAME_LENGTH = 60;

/**
 * Field errors for a 400 VALIDATION_FAILED: { field: [messages] }.
 * Strict schemas reject unknown keys, which zod reports without a field, so each unknown key
 * is added here as { "<path.key>": ["Unexpected field"] } (long names are cut short).
 */
const validationErrors = (error) => {
    const errors = Object.assign(Object.create(null), z.flattenError(error).fieldErrors);

    for (const issue of error.issues) {
        if (issue.code !== "unrecognized_keys") continue;

        for (const key of issue.keys) {
            const name = [...issue.path, key].join(".").slice(0, MAX_NAME_LENGTH);
            errors[name] = [...(errors[name] ?? []), "Unexpected field"];
        }
    }

    return errors;
};

export { validationErrors };
