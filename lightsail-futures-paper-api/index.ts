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
const READ_PATHS = [
  path.join("data", "snapshots", "latest.json"),
  path.join("data", "snapshots", "latest-meta.json"),
  path.join("data", "reports", "summary.json"),
  path.join("data", "reports", "summary-window.json"),
  path.join("data", "reports", "summary-health.json"),
  path.join("data", "reports", "summary-range.json"),
  path.join("data", "reports", "summary-trend.json"),
  path.join("data", "reports", "summary-daily.json"),
  path.join("data", "reports", "dashboard.json"),
  path.join("data", "reports", "engine-state.json"),
  path.join("data", "positions", "open.json"),
  path.join("data", "positions", "history.json"),
  path.join("data", "reports", "events.jsonl")
];

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
  summary: unknown | null;
  summaryRange: unknown | null;
  summaryTrend: unknown | null;
  summaryDaily: unknown | null;
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

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function toFiniteNumber(x: unknown, fallback: number = 0): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

function normalizePositionsHistoryArray(rows: unknown[]): unknown[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((raw) => {
    const o = asRecord(raw) ?? {};
    const pnlUsdNet = toFiniteNumber(o.pnlUsdNet, toFiniteNumber(o.pnlUsd, toFiniteNumber(o.realizedPnlUsd, 0)));
    const feeUsd = toFiniteNumber(o.feeUsd, 0);
    const fundingUsd = toFiniteNumber(o.fundingUsd, 0);
    const pnlUsdGross = toFiniteNumber(o.pnlUsdGross, pnlUsdNet + feeUsd + fundingUsd);
    const closePrice = toFiniteNumber(o.closePrice, toFiniteNumber(o.exitPrice, toFiniteNumber(o.avgExitPrice, 0)));
    const sizeUsd = toFiniteNumber(o.sizeUsd, 0);
    const closedAt = toFiniteNumber(o.closedAt, 0);
    const winLoss = pnlUsdNet > 0 ? "win" : pnlUsdNet < 0 ? "loss" : "flat";
    return {
      ...o,
      pnlUsdNet,
      pnlUsd: toFiniteNumber(o.pnlUsd, pnlUsdNet),
      pnlUsdGross,
      feeUsd,
      fundingUsd,
      closePrice,
      sizeUsd,
      closedAt,
      realizedPnlUsd: toFiniteNumber(o.realizedPnlUsd, pnlUsdNet),
      realizedPnlPct:
        typeof o.realizedPnlPct === "number" && Number.isFinite(o.realizedPnlPct)
          ? o.realizedPnlPct
          : sizeUsd > 0
            ? pnlUsdNet / sizeUsd
            : 0,
      outcomeStatus:
        o.outcomeStatus === "win" || o.outcomeStatus === "loss" || o.outcomeStatus === "flat" ? o.outcomeStatus : winLoss,
      exitReason:
        typeof o.exitReason === "string" && o.exitReason.trim().length > 0
          ? o.exitReason
          : typeof o.closeReasonLabel === "string" && o.closeReasonLabel.trim().length > 0
            ? o.closeReasonLabel
            : typeof o.closeReason === "string" && o.closeReason.trim().length > 0
              ? o.closeReason
              : "기록 없음"
    };
  });
}

function aggregateLedgerWindow(rows: Record<string, unknown>[]): Record<string, unknown> {
  const totalTrades = rows.length;
  let winTrades = 0;
  let lossTrades = 0;
  let totalPnlUsdNet = 0;
  let totalPnlUsdGross = 0;
  let totalFeeUsd = 0;
  let totalFundingUsd = 0;
  for (const row of rows) {
    const pnlNet = toFiniteNumber(row.pnlUsdNet, 0);
    if (pnlNet > 0) winTrades += 1;
    else if (pnlNet < 0) lossTrades += 1;
    totalPnlUsdNet += pnlNet;
    totalPnlUsdGross += toFiniteNumber(row.pnlUsdGross, pnlNet + toFiniteNumber(row.feeUsd, 0) + toFiniteNumber(row.fundingUsd, 0));
    totalFeeUsd += toFiniteNumber(row.feeUsd, 0);
    totalFundingUsd += toFiniteNumber(row.fundingUsd, 0);
  }
  return {
    totalTrades,
    winTrades,
    lossTrades,
    winRate: totalTrades > 0 ? winTrades / totalTrades : 0,
    totalPnlUsdNet,
    totalPnlUsdGross,
    totalFeeUsd,
    totalFundingUsd,
    averagePnlUsdNet: totalTrades > 0 ? totalPnlUsdNet / totalTrades : 0
  };
}

function buildLedgerPerformanceFromHistory(history: unknown[], generatedAt: number): Record<string, unknown> {
  const rows = history
    .map((x) => asRecord(x))
    .filter((x): x is Record<string, unknown> => x !== null);
  const day7 = generatedAt - 7 * 24 * 60 * 60 * 1000;
  const day30 = generatedAt - 30 * 24 * 60 * 60 * 1000;
  const monthStart = Date.UTC(new Date(generatedAt).getUTCFullYear(), new Date(generatedAt).getUTCMonth(), 1, 0, 0, 0, 0);
  const inRange = (fromMs: number) =>
    rows.filter((row) => typeof row.closedAt === "number" && Number.isFinite(row.closedAt) && row.closedAt >= fromMs);
  return {
    generatedAt,
    parsedTradeCount: rows.length,
    all: aggregateLedgerWindow(rows),
    last7d: aggregateLedgerWindow(inRange(day7)),
    last30d: aggregateLedgerWindow(inRange(day30)),
    monthToDate: aggregateLedgerWindow(inRange(monthStart))
  };
}

function paperOperationalFromEngineState(engineState: unknown): Record<string, unknown> | null {
  const o = asRecord(engineState);
  if (!o) return null;
  const explanation = asRecord(o.explanation);
  const modeReason = typeof explanation?.modeReasonLabel === "string" ? explanation.modeReasonLabel : "시장 모드 정보 없음";
  const engineReason = typeof explanation?.engineReasonLabel === "string" ? explanation.engineReasonLabel : "엔진 라우팅 정보 없음";
  const riskReason = typeof explanation?.riskReasonLabel === "string" ? explanation.riskReasonLabel : "리스크 정보 없음";
  const activeEngine = o.current_regime === "RANGE" || o.current_regime === "TREND" ? o.current_regime : "IDLE";
  const policy = o.entryAllowed === true ? "full" : o.entryAllowed === false ? "paused" : "reduced";
  const lastExit = typeof explanation?.exitReasonLabel === "string" ? explanation.exitReasonLabel : "직전 청산 없음";
  const lastSwitch = typeof explanation?.switchReasonLabel === "string" ? explanation.switchReasonLabel : "직전 스위칭 없음";
  return {
    modeReasonLabel: modeReason,
    engineReasonLabel: engineReason,
    riskReasonLabel: riskReason,
    activeEngine,
    newEntryPolicy: policy,
    lastExitReasonLabel: lastExit,
    lastSwitchReasonLabel: lastSwitch,
    dashboardLines: {
      currentMarketJudgment: `시장 판단: ${modeReason}`,
      currentActiveEngine: `운용: ${activeEngine}`,
      newEntryPolicyLine: `진입 정책: ${policy}`,
      currentRiskState: `리스크: ${riskReason}`,
      stanceLine: "공격/보수: 보통",
      lastExitReasonLine: `직전 종료: ${lastExit}`,
      lastSwitchReasonLine: `직전 전환: ${lastSwitch}`
    }
  };
}

function pickWindow(summaryWindow: unknown, key: string): Record<string, unknown> | null {
  const sw = asRecord(summaryWindow);
  const windows = sw ? asRecord(sw.windows) : null;
  const w = windows ? asRecord(windows[key]) : null;
  return w ?? null;
}

function pickSymbolRows(latestSnapshot: unknown): DataBundle["symbolRows"] {
  const latest = asRecord(latestSnapshot);
  const snapshots = Array.isArray(latest?.snapshots) ? latest.snapshots : [];
  const wanted = new Set(["BTCUSDT", "ETHUSDT"]);
  const rows: DataBundle["symbolRows"] = [];
  for (const item of snapshots) {
    const src = asRecord(item);
    if (!src) continue;
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

function fallbackSummarySlice(source: Record<string, unknown> | null, generatedAt: number): Record<string, unknown> {
  return {
    generatedAt,
    totalTrades: typeof source?.totalTrades === "number" ? source.totalTrades : 0,
    winTrades: typeof source?.winTrades === "number" ? source.winTrades : 0,
    lossTrades: typeof source?.lossTrades === "number" ? source.lossTrades : 0,
    winRate: typeof source?.winRate === "number" ? source.winRate : 0,
    totalPnlUsdGross: typeof source?.totalPnlUsdGross === "number" ? source.totalPnlUsdGross : 0,
    totalFeeUsd: typeof source?.totalFeeUsd === "number" ? source.totalFeeUsd : 0,
    totalPnlUsdNet: typeof source?.totalPnlUsdNet === "number" ? source.totalPnlUsdNet : 0,
    averagePnlUsdNet: typeof source?.averagePnlUsdNet === "number" ? source.averagePnlUsdNet : 0,
    feeToGrossRatio: typeof source?.feeToGrossRatio === "number" ? source.feeToGrossRatio : null
  };
}

function ensureSummarySlice(
  current: unknown,
  fallbackSource: Record<string, unknown> | null,
  generatedAt: number
): Record<string, unknown> {
  const fallback = fallbackSummarySlice(fallbackSource, generatedAt);
  const cur = asRecord(current);
  if (!cur) return fallback;
  return { ...fallback, ...cur };
}

function deriveEngineStateFromSnapshot(
  latestSnapshot: unknown,
  summaryHealth: unknown,
  generatedAt: number
): Record<string, unknown> {
  const latest = asRecord(latestSnapshot);
  const health = asRecord(summaryHealth);
  const status = typeof health?.status === "string" ? health.status : "unknown";
  const reasons = Array.isArray(health?.reasons) ? health.reasons : [];
  const snapshots = Array.isArray(latest?.snapshots) ? latest.snapshots : [];
  return {
    generatedAt,
    engine_status: status.toUpperCase(),
    execution_state: snapshots.length > 0 ? "PAPER_READY" : "NO_SNAPSHOT",
    entryAllowed: status === "ok",
    blockedReasons: reasons,
    strategy_executor: "UNKNOWN",
    current_regime: "UNKNOWN"
  };
}

function buildDashboardFallback(bundle: DataBundle): Record<string, unknown> {
  const lp = asRecord(bundle.ledgerPerformance);
  const last7d = lp ? asRecord(lp.last7d) : null;
  const last30d = lp ? asRecord(lp.last30d) : null;
  const all = lp ? asRecord(lp.all) : null;
  const rows = Array.isArray(bundle.positionsHistory) ? bundle.positionsHistory : [];
  const now = bundle.generatedAt;
  const dayAgo = now - 24 * 60 * 60 * 1000;
  let dayTrades = 0;
  let dayWins = 0;
  let dayNet = 0;
  for (const row of rows) {
    const r = asRecord(row);
    if (!r || typeof r.closedAt !== "number" || r.closedAt < dayAgo) continue;
    dayTrades += 1;
    if (typeof r.pnlUsdNet === "number") {
      dayNet += r.pnlUsdNet;
      if (r.pnlUsdNet > 0) dayWins += 1;
    }
  }
  const health = asRecord(bundle.summaryHealth);
  const reasons = Array.isArray(health?.reasons) ? health.reasons : [];
  const status = typeof health?.status === "string" ? health.status : "unknown";
  return {
    generatedAt: now,
    reasons,
    snapshot: {
      last24h: {
        totalTrades: dayTrades,
        winRate: dayTrades > 0 ? dayWins / dayTrades : 0,
        totalPnlUsdNet: dayNet
      },
      last7d: last7d ?? null,
      last30d: last30d ?? null,
      all: all ?? null
    },
    recentPnl24h: dayNet,
    recentPnl7d: typeof last7d?.totalPnlUsdNet === "number" ? last7d.totalPnlUsdNet : 0,
    recentPnl30d: typeof last30d?.totalPnlUsdNet === "number" ? last30d.totalPnlUsdNet : 0,
    recent7dWinRate: typeof last7d?.winRate === "number" ? last7d.winRate : 0,
    recentClosedTrades: typeof last7d?.totalTrades === "number" ? last7d.totalTrades : 0,
    pnl24hUsd: dayNet,
    pnl7dUsd: typeof last7d?.totalPnlUsdNet === "number" ? last7d.totalPnlUsdNet : 0,
    pnl30dUsd: typeof last30d?.totalPnlUsdNet === "number" ? last30d.totalPnlUsdNet : 0,
    winRate7d: typeof last7d?.winRate === "number" ? last7d.winRate : 0,
    closedTradesRecent: typeof last7d?.totalTrades === "number" ? last7d.totalTrades : 0,
    openPositionsCount: Array.isArray(bundle.openPositions) ? bundle.openPositions.length : 0,
    healthStatus: status
  };
}

async function readJsonFromRoot(projectRoot: string, relPath: string): Promise<unknown | null> {
  const fullPath = path.join(projectRoot, relPath);
  try {
    const raw = await fs.readFile(fullPath, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function readJsonArrayFromRoot(projectRoot: string, relPath: string): Promise<unknown[]> {
  const j = await readJsonFromRoot(projectRoot, relPath);
  return Array.isArray(j) ? j : [];
}

async function readJsonlTailFromRoot(projectRoot: string, relPath: string, maxLines: number): Promise<unknown[]> {
  const fullPath = path.join(projectRoot, relPath);
  try {
    const raw = await fs.readFile(fullPath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-maxLines);
    const out: unknown[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as unknown);
      } catch {
        // skip broken lines
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function loadDataBundleFromStaticFiles(projectRoot: string): Promise<{ bundle: DataBundle; readFiles: string[] }> {
  const [
    summary,
    summaryRangeRaw,
    summaryTrendRaw,
    summaryDailyRaw,
    summaryWindow,
    summaryHealth,
    dashboardRaw,
    engineStateRaw,
    latestSnapshot,
    latestMeta,
    openPositions,
    positionsHistoryRaw,
    healthHistoryRecent,
    eventsRecent
  ] = await Promise.all([
    readJsonFromRoot(projectRoot, path.join("data", "reports", "summary.json")),
    readJsonFromRoot(projectRoot, path.join("data", "reports", "summary-range.json")),
    readJsonFromRoot(projectRoot, path.join("data", "reports", "summary-trend.json")),
    readJsonFromRoot(projectRoot, path.join("data", "reports", "summary-daily.json")),
    readJsonFromRoot(projectRoot, path.join("data", "reports", "summary-window.json")),
    readJsonFromRoot(projectRoot, path.join("data", "reports", "summary-health.json")),
    readJsonFromRoot(projectRoot, path.join("data", "reports", "dashboard.json")),
    readJsonFromRoot(projectRoot, path.join("data", "reports", "engine-state.json")),
    readJsonFromRoot(projectRoot, path.join("data", "snapshots", "latest.json")),
    readJsonFromRoot(projectRoot, path.join("data", "snapshots", "latest-meta.json")),
    readJsonArrayFromRoot(projectRoot, path.join("data", "positions", "open.json")),
    readJsonArrayFromRoot(projectRoot, path.join("data", "positions", "history.json")),
    readJsonlTailFromRoot(projectRoot, path.join("data", "reports", "health-history.jsonl"), 10),
    readJsonlTailFromRoot(projectRoot, path.join("data", "reports", "events.jsonl"), 20)
  ]);
  const positionsHistory = normalizePositionsHistoryArray(positionsHistoryRaw);
  const generatedAt = Date.now();
  const ledgerPerformance = buildLedgerPerformanceFromHistory(positionsHistory as unknown[], generatedAt);
  const loaded: DataBundle = {
    configured: true,
    configHint: null,
    summary,
    summaryRange: summaryRangeRaw,
    summaryTrend: summaryTrendRaw,
    summaryDaily: summaryDailyRaw,
    summaryWindow,
    summaryHealth,
    dashboard: dashboardRaw,
    engineState: engineStateRaw,
    paperOperational: paperOperationalFromEngineState(engineStateRaw),
    latestSnapshot,
    latestMeta,
    symbolRows: pickSymbolRows(latestSnapshot),
    healthHistoryRecent: healthHistoryRecent as DataBundle["healthHistoryRecent"],
    ledgerPerformance,
    openPositions,
    positionsHistory,
    eventsRecent,
    generatedAt
  };
  const summaryObj = asRecord(loaded.summary);
  const summaryWindowObj = loaded.summaryWindow;
  const rangeObs = summaryObj ? asRecord(summaryObj.observation) : null;
  const rangeSliceFromObs = rangeObs ? asRecord(rangeObs.range) : null;
  const trendSliceFromObs = rangeObs ? asRecord(rangeObs.trend) : null;
  const allWindow = pickWindow(summaryWindowObj, "all");
  const sevenWindow = pickWindow(summaryWindowObj, "last7d");

  const summaryRange = ensureSummarySlice(loaded.summaryRange, rangeSliceFromObs ?? allWindow, generatedAt);
  const summaryTrend = ensureSummarySlice(loaded.summaryTrend, trendSliceFromObs ?? allWindow, generatedAt);
  const summaryDaily = ensureSummarySlice(
    loaded.summaryDaily,
    pickWindow(summaryWindowObj, "last24h") ?? sevenWindow ?? allWindow,
    generatedAt
  );

  const engineState =
    loaded.engineState ??
    deriveEngineStateFromSnapshot(loaded.latestSnapshot, loaded.summaryHealth, generatedAt);
  const paperOperational =
    loaded.paperOperational ??
    paperOperationalFromEngineState(engineState) ??
    {
      modeReasonLabel: `운영 상태: ${String(asRecord(loaded.summaryHealth)?.status ?? "unknown")}`,
      engineReasonLabel: `실행 상태: ${String(asRecord(engineState)?.execution_state ?? "UNKNOWN")}`,
      riskReasonLabel: `리스크 상태: ${String(asRecord(engineState)?.risk_state ?? "UNKNOWN")}`,
      activeEngine: "IDLE" as const,
      newEntryPolicy: "paused" as const,
      lastExitReasonLabel: "직전 청산 정보 없음",
      lastSwitchReasonLabel: "직전 전환 정보 없음",
      dashboardLines: {
        currentMarketJudgment: "시장 판단: fallback",
        currentActiveEngine: "운용: 대기",
        newEntryPolicyLine: "진입 정책: 보류",
        currentRiskState: `리스크: ${String(asRecord(engineState)?.risk_state ?? "UNKNOWN")}`,
        stanceLine: `공격/보수: ${Array.isArray(loaded.openPositions) ? loaded.openPositions.length : 0}개 포지션`,
        lastExitReasonLine: `직전 종료: ${String(asRecord(engineState)?.engine_status ?? "UNKNOWN")}`,
        lastSwitchReasonLine: `직전 전환: ${String(asRecord(engineState)?.execution_state ?? "UNKNOWN")}`
      }
    };

  const dashboard = { ...buildDashboardFallback(loaded), ...(asRecord(loaded.dashboard) ?? {}) };
  const bundle: DataBundle = {
    ...loaded,
    summaryRange,
    summaryTrend,
    summaryDaily,
    engineState,
    paperOperational,
    dashboard
  };
  return { bundle, readFiles: READ_PATHS };
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
