import fs from "node:fs/promises";
import path from "node:path";

export type FuturesPaperSymbolRow = Readonly<{
  symbol: string;
  signal?: string;
  trendOk?: boolean;
  lastPrice?: number;
  fundingRate?: number;
  fetchedAt?: number;
}>;

export type FuturesPaperHealthHistoryItem = Readonly<{
  generatedAt?: number;
  status?: string;
  reasons?: string[];
}>;

export type FuturesPaperDataBundle = Readonly<{
  configured: boolean;
  configHint: string | null;
  summary: unknown | null;
  summaryDaily: unknown | null;
  summaryWindow: unknown | null;
  summaryHealth: unknown | null;
  dashboard: unknown | null;
  latestSnapshot: unknown | null;
  latestMeta: unknown | null;
  symbolRows: FuturesPaperSymbolRow[];
  healthHistoryRecent: FuturesPaperHealthHistoryItem[];
}>;

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function pickSymbolRows(latest: unknown): FuturesPaperSymbolRow[] {
  if (!latest || typeof latest !== "object") return [];
  const o = latest as Record<string, unknown>;
  const snaps = o.snapshots;
  if (!Array.isArray(snaps)) return [];
  const want = new Set(["BTCUSDT", "ETHUSDT"]);
  const out: FuturesPaperSymbolRow[] = [];
  for (const s of snaps) {
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    const sym = String(r.symbol ?? "");
    if (!want.has(sym)) continue;
    out.push({
      symbol: sym,
      signal: typeof r.signal === "string" ? r.signal : undefined,
      trendOk: typeof r.trendOk === "boolean" ? r.trendOk : undefined,
      lastPrice: typeof r.lastPrice === "number" ? r.lastPrice : undefined,
      fundingRate: typeof r.fundingRate === "number" ? r.fundingRate : undefined,
      fetchedAt: typeof r.fetchedAt === "number" ? r.fetchedAt : undefined
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

async function readHealthHistoryTail(dataDir: string, maxLines: number): Promise<FuturesPaperHealthHistoryItem[]> {
  const p = path.join(dataDir, "reports", "health-history.jsonl");
  try {
    const raw = await fs.readFile(p, "utf8");
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const tail = lines.slice(-maxLines);
    const out: FuturesPaperHealthHistoryItem[] = [];
    for (const line of tail) {
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        out.push({
          generatedAt: typeof j.generatedAt === "number" ? j.generatedAt : undefined,
          status: typeof j.status === "string" ? j.status : undefined,
          reasons: Array.isArray(j.reasons) ? j.reasons.filter((x): x is string => typeof x === "string") : undefined
        });
      } catch {
        /* skip bad line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Read orbitalpha-futures-paper `data/` from a local project root (Lightsail or dev).
 */
export async function loadFuturesPaperBundleFromDiskRoot(projectRoot: string): Promise<FuturesPaperDataBundle> {
  const root = path.resolve(projectRoot.trim());
  const dataDir = path.join(root, "data");
  const reports = path.join(dataDir, "reports");
  const snaps = path.join(dataDir, "snapshots");

  const [
    summary,
    summaryDaily,
    summaryWindow,
    summaryHealth,
    dashboard,
    latestSnapshot,
    latestMeta
  ] = await Promise.all([
    readJsonFile(path.join(reports, "summary.json")),
    readJsonFile(path.join(reports, "summary-daily.json")),
    readJsonFile(path.join(reports, "summary-window.json")),
    readJsonFile(path.join(reports, "summary-health.json")),
    readJsonFile(path.join(reports, "dashboard.json")),
    readJsonFile(path.join(snaps, "latest.json")),
    readJsonFile(path.join(snaps, "latest-meta.json"))
  ]);

  const symbolRows = pickSymbolRows(latestSnapshot);
  const healthHistoryRecent = await readHealthHistoryTail(dataDir, 10);

  return {
    configured: true,
    configHint: null,
    summary,
    summaryDaily,
    summaryWindow,
    summaryHealth,
    dashboard,
    latestSnapshot,
    latestMeta,
    symbolRows,
    healthHistoryRecent
  };
}
