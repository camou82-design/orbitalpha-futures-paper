/**
 * Read-only HTTP API: serves JSON from this repo's `data/` on disk (Lightsail).
 *
 * Env:
 *   ORBITALPHA_FUTURES_PAPER_ROOT — absolute path to orbitalpha-futures-paper clone (contains data/)
 *   ORBITALPHA_FUTURES_PAPER_API_SECRET — shared with Vercel homepage
 *   PORT — default 3991
 */
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import express, { Request, Response } from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monitorDir = path.join(__dirname, "..", "monitor");

const app = express();
const PORT = Number(process.env.PORT ?? 3991);
const secret = process.env.ORBITALPHA_FUTURES_PAPER_API_SECRET?.trim();
const root = process.env.ORBITALPHA_FUTURES_PAPER_ROOT?.trim();

const DATA_ROUTE_TIMEOUT_MS = Number(process.env.FUTURES_PAPER_DATA_ROUTE_TIMEOUT_MS ?? 2_500);
const HEALTH_ROUTE_TIMEOUT_MS = Number(process.env.FUTURES_PAPER_HEALTH_ROUTE_TIMEOUT_MS ?? 800);
const LATEST_SNAPSHOT_PATH = path.join("data", "snapshots", "latest.json");
const SUMMARY_PATH = path.join("data", "reports", "summary.json");
const SUMMARY_WINDOW_PATH = path.join("data", "reports", "summary-window.json");
const SUMMARY_HEALTH_PATH = path.join("data", "reports", "summary-health.json");

type SymbolRow = Readonly<{
  symbol: string;
  signal?: string;
  trendOk?: boolean;
  candidateStrength?: string;
  sidewaysMode?: boolean;
  entryCandidate?: boolean;
  qualityScore?: number;
  emaGap?: number;
  volumeRatioProxy?: number;
  boxHigh?: number;
  boxLow?: number;
  boxPos?: number;
  boxRel?: number;
  gateExpectedMove?: number;
  gateRequiredMove?: number;
  lastPrice?: number;
  fundingRate?: number;
  fetchedAt?: number;
}>;

type HealthHistoryItem = Readonly<{
  generatedAt?: number;
  status?: string;
  reasons?: string[];
}>;

type DataBundle = Readonly<{
  configured: boolean;
  configHint: string | null;
  summaryRange: unknown | null;
  summaryTrend: unknown | null;
  summaryDaily: unknown | null;
  summary: unknown | null;
  summaryWindow: unknown | null;
  summaryHealth: unknown | null;
  dashboard: unknown | null;
  engineState: unknown | null;
  paperOperational: unknown | null;
  latestSnapshot: unknown | null;
  latestMeta: unknown | null;
  symbolRows: SymbolRow[];
  healthHistoryRecent: HealthHistoryItem[];
  ledgerPerformance: unknown | null;
  openPositions: unknown[];
  positionsHistory: unknown[];
  eventsRecent: unknown[];
  generatedAt: number;
}>;

let lastKnownSafeBundle: DataBundle | null = null;

const isProd = process.env.NODE_ENV === "production";
if (!isProd) {
  console.warn("!! WARNING: Running in non-production mode. Ensure this is intentional.");
}

const placeholders = ["PLACEHOLDER_CHANGE_ME", "REPLACE_WITH_STRONG_SECRET", "123456", "SECRET"];
if (!secret || placeholders.includes(secret.toUpperCase())) {
  console.error("!! FATAL: Insecure or missing ORBITALPHA_FUTURES_PAPER_API_SECRET. Boot aborted.");
  process.exit(1);
}
if (!root) {
  console.error("!! FATAL: ORBITALPHA_FUTURES_PAPER_ROOT is NOT set. Boot aborted.");
  process.exit(1);
}

function requestPaperToken(req: Request): string {
  const x = String(req.headers["x-orbitalpha-futures-paper-token"] ?? "").trim();
  if (x) return x;
  const auth = String(req.headers.authorization ?? "").trim();
  const m = /^Bearer\s+(\S+)/i.exec(auth);
  return m ? m[1].trim() : "";
}

app.disable("x-powered-by");

/** 실시간 판단형 모니터 (정적 UI, 기존 JSON 번들만 사용) */
app.use("/monitor", express.static(monitorDir));

app.get("/health", (_req: Request, res: Response) => {
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    console.error("[lightsail-futures-paper-api] health_hit timeout", {
      elapsedMs: Date.now() - startedAt,
      timeoutMs: HEALTH_ROUTE_TIMEOUT_MS
    });
    if (!res.headersSent) {
      res.status(503).json({
        ok: false,
        error: "health_timeout",
        service: "lightsail-futures-paper-api",
        timestamp: Date.now()
      });
    }
  }, HEALTH_ROUTE_TIMEOUT_MS);
  timer.unref();

  try {
    const body = {
      ok: true,
      alive: true,
      service: "lightsail-futures-paper-api",
      timestamp: Date.now()
    };
    res.json(body);
    console.info("[lightsail-futures-paper-api] health_hit", {
      elapsedMs: Date.now() - startedAt
    });
  } finally {
    clearTimeout(timer);
  }
});

function timeoutPromise<T>(ms: number, message: string): Promise<T> {
  return new Promise<T>((_, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    t.unref();
  });
}

async function readJsonSafe(projectRoot: string, relPath: string): Promise<{ file: string; value: unknown | null }> {
  const fullPath = path.join(projectRoot, relPath);
  try {
    const raw = await fs.readFile(fullPath, "utf8");
    if (!raw.trim()) return { file: relPath, value: null };
    return { file: relPath, value: JSON.parse(raw) as unknown };
  } catch {
    return { file: relPath, value: null };
  }
}

function pickSymbolRows(latestSnapshot: unknown): SymbolRow[] {
  if (!latestSnapshot || typeof latestSnapshot !== "object") return [];
  const snapshots = (latestSnapshot as Record<string, unknown>).snapshots;
  if (!Array.isArray(snapshots)) return [];
  const wanted = new Set(["BTCUSDT", "ETHUSDT"]);
  const rows: SymbolRow[] = [];
  for (const item of snapshots) {
    if (!item || typeof item !== "object") continue;
    const src = item as Record<string, unknown>;
    const symbol = String(src.symbol ?? "");
    if (!wanted.has(symbol)) continue;
    rows.push({
      symbol,
      signal: typeof src.signal === "string" ? src.signal : undefined,
      trendOk: typeof src.trendOk === "boolean" ? src.trendOk : undefined,
      candidateStrength:
        src.candidateStrength === "strong" || src.candidateStrength === "weak" ? src.candidateStrength : undefined,
      sidewaysMode: typeof src.sidewaysMode === "boolean" ? src.sidewaysMode : undefined,
      entryCandidate: typeof src.entryCandidate === "boolean" ? src.entryCandidate : undefined,
      qualityScore: typeof src.qualityScore === "number" ? src.qualityScore : undefined,
      emaGap: typeof src.emaGap === "number" ? src.emaGap : undefined,
      volumeRatioProxy: typeof src.volumeRatioProxy === "number" ? src.volumeRatioProxy : undefined,
      boxHigh: typeof src.boxHigh === "number" ? src.boxHigh : undefined,
      boxLow: typeof src.boxLow === "number" ? src.boxLow : undefined,
      boxPos: typeof src.boxPos === "number" ? src.boxPos : undefined,
      boxRel: typeof src.boxRel === "number" ? src.boxRel : undefined,
      gateExpectedMove: typeof src.gateExpectedMove === "number" ? src.gateExpectedMove : undefined,
      gateRequiredMove: typeof src.gateRequiredMove === "number" ? src.gateRequiredMove : undefined,
      lastPrice: typeof src.lastPrice === "number" ? src.lastPrice : undefined,
      fundingRate: typeof src.fundingRate === "number" ? src.fundingRate : undefined,
      fetchedAt: typeof src.fetchedAt === "number" ? src.fetchedAt : undefined
    });
  }
  return rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function pickHealthHistory(summaryHealth: unknown): HealthHistoryItem[] {
  if (!summaryHealth || typeof summaryHealth !== "object") return [];
  const history = (summaryHealth as Record<string, unknown>).history;
  if (!Array.isArray(history)) return [];
  const rows: HealthHistoryItem[] = [];
  for (const item of history) {
    if (!item || typeof item !== "object") continue;
    const src = item as Record<string, unknown>;
    rows.push({
      generatedAt: typeof src.generatedAt === "number" ? src.generatedAt : undefined,
      status: typeof src.status === "string" ? src.status : undefined,
      reasons: Array.isArray(src.reasons) ? src.reasons.filter((x): x is string => typeof x === "string") : undefined
    });
  }
  return rows.slice(-10);
}

async function loadDataBundleFromStaticFiles(projectRoot: string): Promise<{ bundle: DataBundle; readFiles: string[] }> {
  const [latestSnapshot, summary, summaryWindow, summaryHealth] = await Promise.all([
    readJsonSafe(projectRoot, LATEST_SNAPSHOT_PATH),
    readJsonSafe(projectRoot, SUMMARY_PATH),
    readJsonSafe(projectRoot, SUMMARY_WINDOW_PATH),
    readJsonSafe(projectRoot, SUMMARY_HEALTH_PATH)
  ]);
  const readFiles = [latestSnapshot.file, summary.file, summaryWindow.file, summaryHealth.file];
  const symbolRows = pickSymbolRows(latestSnapshot.value);
  const healthHistoryRecent = pickHealthHistory(summaryHealth.value);
  const bundle: DataBundle = {
    configured: true,
    configHint: null,
    summary: summary.value,
    summaryRange: null,
    summaryTrend: null,
    summaryDaily: null,
    summaryWindow: summaryWindow.value,
    summaryHealth: summaryHealth.value,
    dashboard: null,
    engineState: null,
    paperOperational: null,
    latestSnapshot: latestSnapshot.value,
    latestMeta: null,
    symbolRows,
    healthHistoryRecent,
    ledgerPerformance: null,
    openPositions: [],
    positionsHistory: [],
    eventsRecent: [],
    generatedAt: Date.now()
  };
  return { bundle, readFiles };
}

app.get("/api/futures-paper/data", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  console.info("[lightsail-futures-paper-api] data_route_start", { startedAt });
  const token = requestPaperToken(req);
  if (!secret || token !== secret) {
    console.error("[lightsail-futures-paper-api] data_route_fail", {
      reason: "unauthorized",
      elapsedMs: Date.now() - startedAt
    });
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!root) {
    console.error("[lightsail-futures-paper-api] data_route_fail", {
      reason: "misconfigured_root",
      elapsedMs: Date.now() - startedAt
    });
    res.status(500).json({ error: "ORBITALPHA_FUTURES_PAPER_ROOT not set" });
    return;
  }
  try {
    const { bundle, readFiles } = await Promise.race([
      loadDataBundleFromStaticFiles(root),
      timeoutPromise<{ bundle: DataBundle; readFiles: string[] }>(DATA_ROUTE_TIMEOUT_MS, "data_route_timeout")
    ]);
    lastKnownSafeBundle = bundle;
    res.setHeader("X-Orbitalpha-Futures-Paper-Source", "static-snapshot");
    res.setHeader("X-Orbitalpha-Futures-Paper-Read-Files", readFiles.join(","));
    res.json(bundle);
    console.info("[lightsail-futures-paper-api] data_route_success", {
      elapsedMs: Date.now() - startedAt,
      readFiles
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "bundle_failed";
    if (lastKnownSafeBundle) {
      res.setHeader("X-Orbitalpha-Futures-Paper-Source", "last-known-safe");
      res.json(lastKnownSafeBundle);
      console.error("[lightsail-futures-paper-api] data_route_fail", {
        elapsedMs: Date.now() - startedAt,
        reason: message,
        fallback: "last-known-safe"
      });
      return;
    }
    console.error("[lightsail-futures-paper-api] data_route_fail", {
      elapsedMs: Date.now() - startedAt,
      reason: message,
      fallback: "none"
    });
    const status = message === "data_route_timeout" ? 503 : 500;
    res.status(status).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`lightsail-futures-paper-api listening on :${PORT}`);
});
