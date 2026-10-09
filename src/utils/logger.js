// Minimal logger. Never pass request bodies, OTPs, passwords, tokens, phone numbers or email bodies.
const format = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "object" && value !== null) {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
};

const write = (level, stream, args) => {
    const line = `${new Date().toISOString()} [${level}] ${args.map(format).join(" ")}`;
    stream(line);
};

const logger = {
    info: (...args) => write("INFO", console.log, args),
    warn: (...args) => write("WARN", console.warn, args),
    error: (...args) => write("ERROR", console.error, args),
};

export { logger };
