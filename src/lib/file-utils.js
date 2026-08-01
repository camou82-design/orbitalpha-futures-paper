"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.readLastLines = readLastLines;
const fs = __importStar(require("node:fs/promises"));
/**
 * Reads approximately the last N lines of a file without loading the whole file into memory.
 * Uses a fixed buffer and reads from the end of the file backwards.
 * @param fullPath Absolute path to the file
 * @param lineCount Target number of lines
 * @param bufferSize How many bytes to read in one chunk (default 64KB)
 */
async function readLastLines(fullPath, lineCount = 100, bufferSize = 65536) {
    let handle = null;
    try {
        handle = await fs.open(fullPath, "r");
        const stats = await handle.stat();
        if (stats.size === 0)
            return [];
        let lines = [];
        let position = stats.size;
        let leftover = "";
        while (position > 0 && lines.length <= lineCount) {
            const sizeToRead = Math.min(position, bufferSize);
            position -= sizeToRead;
            const buffer = Buffer.alloc(sizeToRead);
            await handle.read(buffer, 0, sizeToRead, position);
            const chunk = buffer.toString("utf8") + leftover;
            const currentLines = chunk.split("\n");
            if (position > 0) {
                leftover = currentLines.shift() || "";
            }
            else {
                leftover = "";
            }
            lines = [...currentLines, ...lines];
        }
        // Filter out empty lines and return the last lineCount elements
        return lines.filter(l => l.trim().length > 0).slice(-lineCount);
    }
    catch (e) {
        const err = e;
        if (err.code === "ENOENT")
            return [];
        throw e;
    }
    finally {
        if (handle)
            await handle.close();
    }
}
