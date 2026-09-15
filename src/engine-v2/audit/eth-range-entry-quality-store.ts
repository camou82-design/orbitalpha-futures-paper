import * as fs from "node:fs";
import * as path from "node:path";

const AUDIT_SUBDIR = path.join("audit", "eth-range-entry-quality");
const RETENTION_DAYS = 30;

export type EthRangeEntryQualityStoreWriter = {
    appendOpportunityLine: (line: string) => void;
    appendOutcomeLine: (line: string) => void;
};

let activeDayKey: string | null = null;
let activeOpportunityPath: string | null = null;
let activeOutcomePath: string | null = null;

function resolveDataDir(explicit?: string | null): string {
    const raw = explicit ?? process.env.DATA_DIR ?? "./data";
    return path.resolve(raw);
}

function dayKeyUtc(ms: number): string {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}${m}${day}`;
}

function ensureRotatedPaths(baseDir: string, nowMs: number): { oppPath: string; outPath: string } {
    const day = dayKeyUtc(nowMs);
    if (activeDayKey !== day || !activeOpportunityPath || !activeOutcomePath) {
        activeDayKey = day;
        const dir = path.join(baseDir, AUDIT_SUBDIR);
        activeOpportunityPath = path.join(dir, `opportunities-${day}.jsonl`);
        activeOutcomePath = path.join(dir, `outcomes-${day}.jsonl`);
        fs.mkdirSync(dir, { recursive: true });
        pruneOldAuditFiles(dir, RETENTION_DAYS);
    }
    return { oppPath: activeOpportunityPath!, outPath: activeOutcomePath! };
}

function pruneOldAuditFiles(dir: string, retentionDays: number): void {
    try {
        const files = fs.readdirSync(dir);
        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        for (const f of files) {
            const m = /^(opportunities|outcomes)-(\d{8})\.jsonl$/.exec(f);
            if (!m) continue;
            const y = Number(m[2].slice(0, 4));
            const mo = Number(m[2].slice(4, 6)) - 1;
            const d = Number(m[2].slice(6, 8));
            const ts = Date.UTC(y, mo, d);
            if (ts < cutoff) {
                try {
                    fs.unlinkSync(path.join(dir, f));
                } catch {
                    /* fail-open */
                }
            }
        }
    } catch {
        /* fail-open */
    }
}

function appendLineFailOpen(filePath: string, line: string): void {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, line.endsWith("\n") ? line : `${line}\n`, "utf8");
    } catch {
        /* fail-open: trading must never depend on audit persistence */
    }
}

export function createEthRangeEntryQualityStore(dataDir?: string | null): EthRangeEntryQualityStoreWriter {
    const baseDir = resolveDataDir(dataDir);
    return {
        appendOpportunityLine(line: string) {
            const { oppPath } = ensureRotatedPaths(baseDir, Date.now());
            appendLineFailOpen(oppPath, line);
            appendLineFailOpen(path.join(baseDir, AUDIT_SUBDIR, "opportunities.jsonl"), line);
        },
        appendOutcomeLine(line: string) {
            const { outPath } = ensureRotatedPaths(baseDir, Date.now());
            appendLineFailOpen(outPath, line);
            appendLineFailOpen(path.join(baseDir, AUDIT_SUBDIR, "outcomes.jsonl"), line);
        }
    };
}

/** Test-only: reset rotation state. */
export function resetEthRangeEntryQualityStoreRotationForTests(): void {
    activeDayKey = null;
    activeOpportunityPath = null;
    activeOutcomePath = null;
}
