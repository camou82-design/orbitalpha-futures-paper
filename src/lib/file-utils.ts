import * as fs from "node:fs/promises";

/**
 * Reads approximately the last N lines of a file without loading the whole file into memory.
 * Uses a fixed buffer and reads from the end of the file backwards.
 * @param fullPath Absolute path to the file
 * @param lineCount Target number of lines
 * @param bufferSize How many bytes to read in one chunk (default 64KB)
 */
export async function readLastLines(fullPath: string, lineCount: number = 100, bufferSize: number = 65536): Promise<string[]> {
    let handle: fs.FileHandle | null = null;
    try {
        handle = await fs.open(fullPath, "r");
        const stats = await handle.stat();
        if (stats.size === 0) return [];

        let lines: string[] = [];
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
            } else {
                leftover = "";
            }

            lines = [...currentLines, ...lines];
        }

        // Filter out empty lines and return the last lineCount elements
        return lines.filter(l => l.trim().length > 0).slice(-lineCount);
    } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return [];
        throw e;
    } finally {
        if (handle) await handle.close();
    }
}
