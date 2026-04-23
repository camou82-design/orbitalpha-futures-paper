import fs from "node:fs/promises";
import path from "node:path";

import type { EngineRoutingDecision, PaperEngineRoutingKind, PaperOperationalSnapshot, PaperRegimeState, PaperSymbolDecisionRecord } from "../models/types";
import { buildLedgerPerformanceFromHistory, type FuturesPaperLedgerPerformance } from "./futuresPaperLedgerStats";
import { normalizePositionsHistoryArray } from "./paperClosedHistoryNormalize";

export {
  normalizePositionsHistoryArray,
  normalizeClosedHistoryRow,
  displayFieldsForClosedRow
} from "./paperClosedHistoryNormalize";
export type { NormalizedPaperClosedRow, ClosedRowDisplayFields } from "./paperClosedHistoryNormalize";
import { readLastLines } from "./file-utils";
function isRoutingKind(x: unknown): x is PaperEngineRoutingKind {
  return x === "RANGE" || x === "TREND" || x === "IDLE";
}

function isNewEntryPolicy(x: unknown): x is EngineRoutingDecision["newEntryPolicy"] {
  return x === "full" || x === "reduced" || x === "paused";
}

/** `engine-state.json`에서 대시보드 상단용 운영 스냅샷을 만든다. */
export function paperOperationalFromEngineState(engineState: unknown): PaperOperationalSnapshot | null {
  if (!engineState || typeof engineState !== "object") return null;
  const o = engineState as Record<string, unknown>;
  const expl = o.explanation;
  let modeReasonLabel = "";
  let engineReasonLabel = "";
  let riskReasonLabel = "";
  let activeEngine: PaperEngineRoutingKind = "IDLE";
  let newEntryPolicy: EngineRoutingDecision["newEntryPolicy"] = "paused";
  if (expl && typeof expl === "object") {
    const e = expl as Record<string, unknown>;
    if (typeof e.modeReasonLabel === "string") modeReasonLabel = e.modeReasonLabel;
    if (typeof e.engineReasonLabel === "string") engineReasonLabel = e.engineReasonLabel;
    if (typeof e.riskReasonLabel === "string") riskReasonLabel = e.riskReasonLabel;
    if (isRoutingKind(e.activeEngine)) activeEngine = e.activeEngine;
    if (isNewEntryPolicy(e.newEntryPolicy)) newEntryPolicy = e.newEntryPolicy;
  }
  const mm = o.market_mode_selector;
  if ((!modeReasonLabel || !engineReasonLabel) && mm && typeof mm === "object") {
    const m = mm as Record<string, unknown>;
    if (!modeReasonLabel && typeof m.modeReasonLabel === "string") modeReasonLabel = m.modeReasonLabel;
    const r = m.routing;
    if (r && typeof r === "object") {
      const rr = r as Record<string, unknown>;
      if (!engineReasonLabel && typeof rr.routingReasonLabel === "string") {
        engineReasonLabel = `라우팅: ${rr.routingReasonLabel}`;
      }
      if (isRoutingKind(rr.activeEngine)) activeEngine = rr.activeEngine;
      if (isNewEntryPolicy(rr.newEntryPolicy)) newEntryPolicy = rr.newEntryPolicy;
    }
  }
  const risk = o.risk_exposure;
  let riskStanceLabel = "";
  if (risk && typeof risk === "object") {
    const rx = risk as Record<string, unknown>;
    if (!riskReasonLabel && typeof rx.riskReasonLabel === "string") riskReasonLabel = rx.riskReasonLabel;
    if (typeof rx.riskStanceLabel === "string") riskStanceLabel = rx.riskStanceLabel;
  }
  let lastExitReasonLabel = "";
  let lastSwitchReasonLabel = "";
  if (typeof o.last_exit_reason === "string") lastExitReasonLabel = o.last_exit_reason;
  if (typeof o.last_switch_reason === "string") lastSwitchReasonLabel = o.last_switch_reason;
  if (expl && typeof expl === "object") {
    const e = expl as Record<string, unknown>;
    if (!lastExitReasonLabel && typeof e.exitReasonLabel === "string") lastExitReasonLabel = e.exitReasonLabel;
    if (!lastSwitchReasonLabel && typeof e.switchReasonLabel === "string") lastSwitchReasonLabel = e.switchReasonLabel;
  }
  if (!modeReasonLabel) modeReasonLabel = "시장 모드 정보 없음";
  if (!engineReasonLabel) engineReasonLabel = "엔진 라우팅 정보 없음";
  if (!riskReasonLabel) riskReasonLabel = "리스크 정보 없음";
  if (!lastExitReasonLabel) lastExitReasonLabel = "직전 청산 없음";
  if (!lastSwitchReasonLabel) lastSwitchReasonLabel = "직전 스위칭 없음";
  const symbolDecisionsRaw =
    (o.symbol_decisions as Record<string, Record<string, unknown>> | undefined) ?? {};
  const symbolDecisionRows = Object.values(symbolDecisionsRaw);
  const selectedDecisionMeta =
    symbolDecisionRows.find((d) => d?.v2_decision === "ENTER") ??
    symbolDecisionRows[0] ??
    null;

  const policyLine =
    newEntryPolicy === "full"
      ? "진입 정책: 전량"
      : newEntryPolicy === "reduced"
        ? "진입 정책: 축소"
        : "진입 정책: 보류";

  const engineLineShort =
    activeEngine === "RANGE"
      ? "운용: RANGE 양방향"
      : activeEngine === "TREND"
        ? "운용: TREND 돌파"
        : "운용: 대기";

  const stanceLine =
    riskStanceLabel.trim().length > 0
      ? `공격/보수: ${riskStanceLabel}`
      : `공격/보수: ${riskReasonLabel.includes("정상") ? "보통" : "주의"}`;

  const dashboardLines = {
    currentMarketJudgment: `시장 판단: ${modeReasonLabel}`,
    currentActiveEngine: engineLineShort,
    newEntryPolicyLine: policyLine,
    currentRiskState: riskReasonLabel.startsWith("리스크:") ? riskReasonLabel : `리스크: ${riskReasonLabel}`,
    stanceLine,
    lastExitReasonLine: `직전 종료: ${lastExitReasonLabel}`,
    lastSwitchReasonLine: `직전 전환: ${lastSwitchReasonLabel}`
  };

  return {
    modeReasonLabel,
    engineReasonLabel,
    riskReasonLabel,
    activeEngine,
    newEntryPolicy,
    lastExitReasonLabel,
    lastSwitchReasonLabel,
    dashboardLines,
    exchange: (o.exchange as "okx") || "okx",
    okx_demo_enabled: !!o.okx_demo_enabled,
    okx_demo_keys_loaded: !!o.okx_demo_keys_loaded,
    okx_signed_rest_ready: !!o.okx_signed_rest_ready,
    okx_account_config_ok: !!o.okx_account_config_ok,
    okx_balance_ok: !!o.okx_balance_ok,
    okx_positions_ok: !!o.okx_positions_ok,
    okx_order_submit_ok: !!o.okx_order_submit_ok,
    strategy_executor: (o.strategy_executor as PaperEngineRoutingKind) || activeEngine,
    current_regime: (o.current_regime as PaperRegimeState) || (activeEngine === "IDLE" ? "NO_TRADE" : activeEngine),
    entryAllowedLong: !!o.entryAllowedLong,
    entryAllowedShort: !!o.entryAllowedShort,
    directional_shock_state: String(o.directional_shock_state ?? "NONE"),
    long_allow: !!o.long_allow,
    short_allow: !!o.short_allow,
    server_trade_enabled: !!o.server_trade_enabled,
    close_only_mode: !!o.close_only_mode,
    close_only_mode_effective: !!o.close_only_mode_effective,
    serverTradeEnabled: !!(o.serverTradeEnabled ?? o.server_trade_enabled),
    closeOnlyMode: !!(o.closeOnlyMode ?? o.close_only_mode),
    closeOnlyModeEffective: !!(o.closeOnlyModeEffective ?? o.close_only_mode_effective),
    killSwitch: !!(o.killSwitch ?? o.kill_switch_active),
    reconcileSafeMode: !!(o.reconcileSafeMode ?? o.reconcile_safe_mode_active),
    entry_quality_grade:
      selectedDecisionMeta && typeof selectedDecisionMeta.entry_quality_grade === "string"
        ? selectedDecisionMeta.entry_quality_grade
        : null,
    leverage_profile:
      selectedDecisionMeta && typeof selectedDecisionMeta.leverage_profile === "string"
        ? selectedDecisionMeta.leverage_profile
        : null,
    applied_leverage:
      selectedDecisionMeta && typeof selectedDecisionMeta.applied_leverage === "number"
        ? selectedDecisionMeta.applied_leverage
        : null,
    leverage_reason:
      selectedDecisionMeta && typeof selectedDecisionMeta.leverage_reason === "string"
        ? selectedDecisionMeta.leverage_reason
        : null,
    leverage_block_reason:
      selectedDecisionMeta && typeof selectedDecisionMeta.leverage_block_reason === "string"
        ? selectedDecisionMeta.leverage_block_reason
        : null,
    exposure_notional_krw:
      selectedDecisionMeta && typeof selectedDecisionMeta.exposure_notional_krw === "number"
        ? selectedDecisionMeta.exposure_notional_krw
        : null,
    equity_multiple:
      selectedDecisionMeta && typeof selectedDecisionMeta.equity_multiple === "number"
        ? selectedDecisionMeta.equity_multiple
        : null,
    authority_source: typeof o.authority_source === "string" ? o.authority_source : undefined,
    fresh_tick_age_ms: typeof o.fresh_tick_age_ms === "number" ? o.fresh_tick_age_ms : null,
    snapshot_age_ms: typeof o.snapshot_age_ms === "number" ? o.snapshot_age_ms : null,
    position_tracking_alive: !!o.position_tracking_alive,
    entry_pipeline_ready: !!o.entry_pipeline_ready,
    exit_pipeline_ready: !!o.exit_pipeline_ready,
    reconcile_safe_mode_active: !!o.reconcile_safe_mode_active,
    reconcile_last_mismatch_reason:
      typeof o.reconcile_last_mismatch_reason === "string" ? o.reconcile_last_mismatch_reason : null,
    symbol_decisions: (o.symbol_decisions as Record<string, { decision: PaperSymbolDecisionRecord; adaptiveOk: boolean }>) || {}
  };
}

export type FuturesPaperSymbolRow = Readonly<{
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

export type FuturesPaperHealthHistoryItem = Readonly<{
  generatedAt?: number;
  status?: string;
  reasons?: string[];
}>;

export type FuturesPaperDataBundle = Readonly<{
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
  /** `engineState`에서 파생한 운영 대시보드 요약 */
  paperOperational: PaperOperationalSnapshot | null;
  latestSnapshot: unknown | null;
  latestMeta: unknown | null;
  symbolRows: FuturesPaperSymbolRow[];
  healthHistoryRecent: FuturesPaperHealthHistoryItem[];
  ledgerPerformance: FuturesPaperLedgerPerformance | null;
  openPositions: unknown[];
  positionsHistory: unknown[];
  eventsRecent: unknown[];
  generatedAt: number;
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
    const strength =
      r.candidateStrength === "strong" || r.candidateStrength === "weak" ? r.candidateStrength : undefined;
    out.push({
      symbol: sym,
      signal: typeof r.signal === "string" ? r.signal : undefined,
      trendOk: typeof r.trendOk === "boolean" ? r.trendOk : undefined,
      candidateStrength: strength,
      sidewaysMode: typeof r.sidewaysMode === "boolean" ? r.sidewaysMode : undefined,
      entryCandidate: typeof r.entryCandidate === "boolean" ? r.entryCandidate : undefined,
      qualityScore: typeof r.qualityScore === "number" ? r.qualityScore : undefined,
      emaGap: typeof r.emaGap === "number" ? r.emaGap : undefined,
      volumeRatioProxy: typeof r.volumeRatioProxy === "number" ? r.volumeRatioProxy : undefined,
      boxHigh: typeof r.boxHigh === "number" ? r.boxHigh : undefined,
      boxLow: typeof r.boxLow === "number" ? r.boxLow : undefined,
      boxPos: typeof r.boxPos === "number" ? r.boxPos : undefined,
      boxRel: typeof r.boxRel === "number" ? r.boxRel : undefined,
      gateExpectedMove: typeof r.gateExpectedMove === "number" ? r.gateExpectedMove : undefined,
      gateRequiredMove: typeof r.gateRequiredMove === "number" ? r.gateRequiredMove : undefined,
      lastPrice: typeof r.lastPrice === "number" ? r.lastPrice : undefined,
      fundingRate: typeof r.fundingRate === "number" ? r.fundingRate : undefined,
      fetchedAt: typeof r.fetchedAt === "number" ? r.fetchedAt : undefined
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

async function readPositionsHistoryArray(dataDir: string): Promise<unknown[]> {
  const p = path.join(dataDir, "positions", "history.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function readPositionsOpenArray(dataDir: string): Promise<unknown[]> {
  const p = path.join(dataDir, "positions", "open.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}


async function readHealthHistoryTail(dataDir: string, maxLines: number): Promise<FuturesPaperHealthHistoryItem[]> {
  const p = path.join(dataDir, "reports", "health-history.jsonl");
  const tail = await readLastLines(p, maxLines);
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
}

async function readEventsTail(dataDir: string, maxLines: number): Promise<unknown[]> {
  const p = path.join(dataDir, "reports", "events.jsonl");
  const tail = await readLastLines(p, maxLines);
  const out: unknown[] = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line) as unknown);
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

const PUBLIC_BUNDLE_REL_PARTS = ["data", "reports", "public-futures-paper-bundle.json"] as const;

function publishedBundlePath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot.trim()), ...PUBLIC_BUNDLE_REL_PARTS);
}

function isFiniteRecordBundle(x: unknown): x is FuturesPaperDataBundle {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (o.configured !== true) return false;
  if (typeof o.generatedAt !== "number" || !Number.isFinite(o.generatedAt)) return false;
  if (!Array.isArray(o.openPositions)) return false;
  if (!Array.isArray(o.positionsHistory)) return false;
  if (!Array.isArray(o.eventsRecent)) return false;
  if (!Array.isArray(o.symbolRows)) return false;
  return true;
}

/** Prefer the prebuilt public bundle (single-file read) when present and valid. */
async function tryReadPublishedPublicBundle(projectRoot: string): Promise<FuturesPaperDataBundle | null> {
  try {
    const raw = await fs.readFile(publishedBundlePath(projectRoot), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isFiniteRecordBundle(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function mapHealthHistorySlice(lines: readonly unknown[]): FuturesPaperHealthHistoryItem[] {
  const out: FuturesPaperHealthHistoryItem[] = [];
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const j = line as Record<string, unknown>;
    out.push({
      generatedAt: typeof j.generatedAt === "number" ? j.generatedAt : undefined,
      status: typeof j.status === "string" ? j.status : undefined,
      reasons: Array.isArray(j.reasons) ? j.reasons.filter((x): x is string => typeof x === "string") : undefined
    });
  }
  return out;
}

/**
 * Build the public API bundle during `writePaperSummaryReport` without re-reading
 * summary/dashboard/history inputs that are already in memory.
 */
export type ComposePublicFuturesPaperBundleInput = Readonly<{
  projectRoot: string;
  summary: unknown;
  summaryRange: unknown;
  summaryTrend: unknown;
  summaryDaily: unknown;
  summaryWindow: unknown;
  summaryHealth: unknown;
  dashboard: unknown;
  /** Same rows as `positions/history.json` (pre-normalize). */
  positionsHistoryRaw: unknown[];
  /** Parsed objects from `readEventsJsonlFile` (or equivalent). */
  eventsParsed: readonly unknown[];
  /** Parsed rows from `readHealthHistoryJsonlFile` (or equivalent). */
  healthHistoryParsed: readonly unknown[];
}>;

export async function composePublicFuturesPaperBundleForWrite(
  input: ComposePublicFuturesPaperBundleInput
): Promise<FuturesPaperDataBundle> {
  const root = path.resolve(input.projectRoot.trim());
  const dataDir = path.join(root, "data");
  const [engineState, latestSnapshot, latestMeta, openPositions] = await Promise.all([
    readJsonFile(path.join(dataDir, "reports", "engine-state.json")),
    readJsonFile(path.join(dataDir, "snapshots", "latest.json")),
    readJsonFile(path.join(dataDir, "snapshots", "latest-meta.json")),
    readPositionsOpenArray(dataDir)
  ]);

  const symbolRows = pickSymbolRows(latestSnapshot);
  const eventsRecent = input.eventsParsed.slice(-20);
  const healthHistoryRecent = mapHealthHistorySlice(input.healthHistoryParsed.slice(-10));
  const positionsHistory = normalizePositionsHistoryArray(input.positionsHistoryRaw);
  const generatedAt = Date.now();
  const ledgerPerformance = buildLedgerPerformanceFromHistory(positionsHistory as unknown[], generatedAt);
  const paperOperational = paperOperationalFromEngineState(engineState);

  return {
    configured: true,
    configHint: null,
    summary: input.summary,
    summaryRange: input.summaryRange,
    summaryTrend: input.summaryTrend,
    summaryDaily: input.summaryDaily,
    summaryWindow: input.summaryWindow,
    summaryHealth: input.summaryHealth,
    dashboard: input.dashboard,
    engineState,
    paperOperational,
    latestSnapshot,
    latestMeta,
    symbolRows,
    healthHistoryRecent,
    ledgerPerformance,
    openPositions,
    positionsHistory,
    eventsRecent,
    generatedAt
  };
}

/**
 * Full disk assembly (bootstrap / missing public bundle). Avoid on hot request paths.
 */
async function assembleFuturesPaperBundleFromDiskSources(projectRoot: string): Promise<FuturesPaperDataBundle> {
  const root = path.resolve(projectRoot.trim());
  const dataDir = path.join(root, "data");
  const reports = path.join(dataDir, "reports");
  const snaps = path.join(dataDir, "snapshots");

  const [
    summary,
    summaryRange,
    summaryTrend,
    summaryDaily,
    summaryWindow,
    summaryHealth,
    dashboard,
    engineState,
    latestSnapshot,
    latestMeta
  ] =
    await Promise.all([
      readJsonFile(path.join(reports, "summary.json")),
      readJsonFile(path.join(reports, "summary-range.json")),
      readJsonFile(path.join(reports, "summary-trend.json")),
      readJsonFile(path.join(reports, "summary-daily.json")),
      readJsonFile(path.join(reports, "summary-window.json")),
      readJsonFile(path.join(reports, "summary-health.json")),
      readJsonFile(path.join(reports, "dashboard.json")),
      readJsonFile(path.join(reports, "engine-state.json")),
      readJsonFile(path.join(snaps, "latest.json")),
      readJsonFile(path.join(snaps, "latest-meta.json"))
    ]);

  const [symbolRows, healthHistoryRecent, positionsHistoryRaw, openPositions, eventsRecent] = await Promise.all([
    Promise.resolve(pickSymbolRows(latestSnapshot)),
    readHealthHistoryTail(dataDir, 10),
    readPositionsHistoryArray(dataDir),
    readPositionsOpenArray(dataDir),
    readEventsTail(dataDir, 20)
  ]);

  const positionsHistory = normalizePositionsHistoryArray(positionsHistoryRaw);
  const generatedAt = Date.now();
  const ledgerPerformance = buildLedgerPerformanceFromHistory(positionsHistory as unknown[], generatedAt);
  const paperOperational = paperOperationalFromEngineState(engineState);

  return {
    configured: true,
    configHint: null,
    summary,
    summaryRange,
    summaryTrend,
    summaryDaily,
    summaryWindow,
    summaryHealth,
    dashboard,
    engineState,
    paperOperational,
    latestSnapshot,
    latestMeta,
    symbolRows,
    healthHistoryRecent,
    ledgerPerformance,
    openPositions,
    positionsHistory,
    eventsRecent,
    generatedAt
  };
}

/**
 * Read orbitalpha-futures-paper `data/` from a local project root (Lightsail or dev).
 * When `data/reports/public-futures-paper-bundle.json` exists, returns it with a single read.
 */
export async function loadFuturesPaperBundleFromDiskRoot(projectRoot: string): Promise<FuturesPaperDataBundle> {
  const published = await tryReadPublishedPublicBundle(projectRoot);
  if (published) return published;
  return assembleFuturesPaperBundleFromDiskSources(projectRoot);
}
