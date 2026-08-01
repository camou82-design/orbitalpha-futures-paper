"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLogger = createLogger;
const levelRank = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40
};
function formatLine(level, msg, meta) {
    const ts = new Date().toISOString();
    if (meta === undefined)
        return `[${ts}] ${level.toUpperCase()} ${msg}`;
    try {
        return `[${ts}] ${level.toUpperCase()} ${msg} ${JSON.stringify(meta)}`;
    }
    catch {
        return `[${ts}] ${level.toUpperCase()} ${msg} (meta_unserializable)`;
    }
}
function createLogger(minLevel = "info") {
    const min = levelRank[minLevel];
    const write = (level, msg, meta) => {
        if (levelRank[level] < min)
            return;
        const line = formatLine(level, msg, meta);
        if (level === "error")
            console.error(line);
        else if (level === "warn")
            console.warn(line);
        else
            console.log(line);
    };
    return {
        debug: (m, meta) => write("debug", m, meta),
        info: (m, meta) => write("info", m, meta),
        warn: (m, meta) => write("warn", m, meta),
        error: (m, meta) => write("error", m, meta)
    };
}
