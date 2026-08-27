import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readLastLines } from "../lib/file-utils";
import { composePublicFuturesPaperBundleForWrite } from "../lib/futuresPaperBundleCore";

import type { PaperClosedPositionRecord, PaperOpenPositionRecord } from "../models/types";
import { migrateLegacyExecutorAtEntry } from "../strategy/executors/executor-normalize";
import { buildPaperDashboard, parseHealthHistoryJsonl, type PaperDashboardTradeControl, type OkxLiveBalance } from "./paper-dashboard";
import { buildPaperHealthReport, paperHealthHistoryJsonlLine, type PaperHealthReport } from "./paper-health";
import type { AiBlockEvaluationCriteria } from "./ai-block-evaluator";
import {
  buildSymbolPriceMap,
  isAiBlockedEventNeedingEval,
  toAiBlockedEvalFromEvent,
  tryUpdateAiBlockedEventEval
} from "./ai-block-evaluator";
import {
  buildPaperDailySummaryFromHistory,
  buildPaperSummaryFromHistory,
  buildPaperSummaryByRegimeFromHistory,
  attachObservationToReports,
  buildPaperWindowSummaryFromHistory
} from "./paper-summary";

export const RUNS_INDEX_MAX_ITEMS = 50;

function isPaperOpenRecord(x: unknown): x is PaperOpenPositionRecord {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return o.status === "open" && typeof o.symbol === "string";
}

/** 심볼+방향 단위 유일(양방향 RANGE: 동일 심볼 롱/숏 동시 보유). */
function dedupeOpensBySymbol(list: readonly PaperOpenPositionRecord[]): PaperOpenPositionRecord[] {
  const seen = new Set<string>();
  const out: PaperOpenPositionRecord[] = [];
  for (const r of list) {
    const sym = String(r.symbol);
    const side = r.side === "short" ? "short" : "long";
    const key = `${sym}:${side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export type CandidateRunIndexItem = Readonly<{
  fetchedAt: number;
  runPath: string;
  strategyVersion: string;
  longCandidates: number;
  shortCandidates: number;
  candidateSymbols: string[];
  /** Paths to `snapshots/latest.json` and `snapshots/latest-meta.json` at the time of this run (if available). */
  latestSnapshotPath?: string;
  latestMetaPath?: string;
  /** Absolute path to the immutable `snapshots/{fetchedAt}.json` for this run (if available). */
  timestampSnapshotPath?: string;
}>;

export type CandidateRunIndex = Readonly<{
  updatedAt: number;
  total: number;
  items: CandidateRunIndexItem[];
}>;

/** Payload written to `runs/{fetchedAt}.json` when any long or short candidate exists. */
export type PaperCandidateRunPayload = Readonly<{
  fetchedAt: number;
  strategyVersion: string;
  longCandidates: number;
  shortCandidates: number;
  candidateSymbols: string[];
  snapshots: unknown;
  latestSnapshotPath?: string;
  latestMetaPath?: string;
  /** Immutable `snapshots/{fetchedAt}.json` for this run (if available). */
  timestampSnapshotPath?: string;
}>;

export class JsonStore {
  constructor(private readonly baseDir: string) { }

  private async readTradeControlForDashboard(): Promise<PaperDashboardTradeControl> {
    const defaults: PaperDashboardTradeControl = {
      serverTradeEnabled: false,
      closeOnlyMode: false,
      killSwitch: false,
      updatedAt: 0,
      reason: "control_file_missing_default_off",
      source: "server_state"
    };
    const rel = "control/trade-control.json";
    const fullPath = path.resolve(this.baseDir, rel);
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const serverTradeEnabled =
        (parsed.serverTradeEnabled === true) || (parsed.server_trade_enabled === true);
      const closeOnlyMode =
        (parsed.closeOnlyMode === true) || (parsed.close_only_mode === true);
      const killSwitch =
        (parsed.killSwitch === true) || (parsed.kill_switch_active === true) || (parsed.kill_switch === true);
      const updatedAt =
        typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : typeof parsed.updated_at === "number" && Number.isFinite(parsed.updated_at)
            ? parsed.updated_at
            : 0;
      const reason =
        typeof parsed.reason === "string" ? parsed.reason :
          parsed.reason === null ? null :
            defaults.reason;
      const source =
        typeof parsed.source === "string"
          ? parsed.source
          : typeof parsed.authority_source === "string"
            ? parsed.authority_source
            : defaults.source;
      return { serverTradeEnabled, closeOnlyMode, killSwitch, updatedAt, reason, source };
    } catch {
      return defaults;
    }
  }

  async readManualTakeoverDoc(): Promise<{ updatedAt: number; bySymbol: Record<string, any> }> {
    const rel = "control/manual-takeover.json";
    const fullPath = path.resolve(this.baseDir, rel);
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const bySymbol = parsed.bySymbol && typeof parsed.bySymbol === "object" ? (parsed.bySymbol as Record<string, any>) : {};
      const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now();
      return { updatedAt, bySymbol };
    } catch {
      return { updatedAt: Date.now(), bySymbol: {} };
    }
  }

  async writeManualTakeoverDoc(doc: { updatedAt: number; bySymbol: Record<string, any> }): Promise<string> {
    return await this.writeJson("control/manual-takeover.json", doc);
  }

  async writeJson(relativePath: string, data: unknown): Promise<string> {
    const fullPath = path.resolve(this.baseDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, JSON.stringify(data, null, 2), "utf8");
    return fullPath;
  }

  /** Append one JSON Lines row (`\n`-terminated). Creates parent dirs and file if missing. */
  async appendJsonlLine(relativePath: string, data: unknown): Promise<string> {
    const fullPath = path.resolve(this.baseDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const line = `${JSON.stringify(data)}\n`;
    await fs.appendFile(fullPath, line, "utf8");
    return fullPath;
  }

  /**
   * Persist latest `V2_NO_ENTRY_REASON_AUDIT_PROOF` rows for ops monitor (`data/runtime/latest-no-entry-audit.json`).
   * Per-symbol merge only; does not alter trading logic.
   */
  async mergeNoEntryAuditSnapshot(
    symbol: string,
    row: Record<string, unknown>
  ): Promise<void> {
    const rel = "runtime/latest-no-entry-audit.json";
    const fullPath = path.resolve(this.baseDir, rel);
    const now = Date.now();
    let bySymbol: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const prior = parsed.bySymbol;
      if (prior && typeof prior === "object" && !Array.isArray(prior)) {
        bySymbol = { ...(prior as Record<string, unknown>) };
      }
    } catch {
      /* start fresh */
    }
    const symKey = String(symbol).trim().toUpperCase() || symbol;
    bySymbol[symKey] = { ...row, symbol: symKey, ts: now };
    const doc = { updatedAt: now, bySymbol };
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, JSON.stringify(doc, null, 2), "utf8");
  }

  /** Read `reports/health-history.jsonl` (empty if missing). Tails last 2000 lines. */
  async readHealthHistoryJsonlFile(): Promise<ReturnType<typeof parseHealthHistoryJsonl>> {
    const fullPath = path.resolve(this.baseDir, "reports/health-history.jsonl");
    try {
      const lines = await readLastLines(fullPath, 2000);
      return parseHealthHistoryJsonl(lines.join("\n"));
    } catch {
      return [];
    }
  }

  /** Tails last 50,000 events to prevent memory exhaustion in summary reporting. */
  async readEventsJsonlFile(): Promise<unknown[]> {
    const fullPath = path.resolve(this.baseDir, "reports/events.jsonl");
    try {
      const lines = await readLastLines(fullPath, 2000);
      const out: unknown[] = [];
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t) as unknown);
        } catch {
          /* skip */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async readAiBlockEvalJson(): Promise<unknown | null> {
    const fullPath = path.resolve(this.baseDir, "reports/ai-block-eval.json");
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  async writeAiBlockEvalJson(data: unknown): Promise<string> {
    return await this.writeJson("reports/ai-block-eval.json", data);
  }

  private lastAiEvalMs = 0;

  /**
   * Update AI-block evaluation store using current prices.
   * Frequency gated (every 2 mins) to avoid 13MB reads choking the CPU.
   */
  async updateAiBlockEvaluations(input: Readonly<{ now: number; symbolRows: readonly any[]; events: unknown[] }>, force = false): Promise<string | null> {
    const minInterval = 120_000;
    if (!force && input.now - this.lastAiEvalMs < minInterval) return null;
    this.lastAiEvalMs = input.now;

    const criteria: AiBlockEvaluationCriteria = {
      good_block_threshold_pct: (input as any).criteria?.good_block_threshold_pct ?? -0.25,
      missed_opportunity_threshold_pct: (input as any).criteria?.missed_opportunity_threshold_pct ?? 0.35,
      evaluation_horizon_priority: (input as any).criteria?.evaluation_horizon_priority ?? [30, 15, 5]
    };
    const priceMap = buildSymbolPriceMap(input.symbolRows as any);
    const priorRaw = await this.readAiBlockEvalJson();
    const prior = priorRaw && typeof priorRaw === "object" ? (priorRaw as Record<string, unknown>) : {};
    const evals: Record<string, unknown> = prior.evals && typeof prior.evals === "object" ? { ...(prior.evals as any) } : {};

    for (const ev of input.events) {
      if (!isAiBlockedEventNeedingEval(ev)) continue;
      const parsed = toAiBlockedEvalFromEvent(ev);
      if (!parsed) continue;
      const key = `${parsed.ts}:${parsed.symbol}:${parsed.reason}`;
      const existing = evals[key];
      const base = existing && typeof existing === "object" ? (existing as any) : parsed;
      const merged = { ...parsed, ...base };
      const pNow = priceMap.get(parsed.symbol) ?? null;
      const updated = tryUpdateAiBlockedEventEval({ now: input.now, ev: merged, symbolPriceNow: pNow, criteria });
      evals[key] = updated;
    }

    // If nothing changed, still write (small file) for simplicity.
    return await this.writeAiBlockEvalJson({ updatedAt: input.now, criteria, evals });
  }

  async writeSnapshotLatest(data: unknown): Promise<string> {
    return await this.writeJson("snapshots/latest.json", data);
  }

  async writeSnapshotLatestMeta(data: unknown): Promise<string> {
    return await this.writeJson("snapshots/latest-meta.json", data);
  }

  async writeLightweightStatus(data: unknown): Promise<string> {
    return await this.writeJson("runtime/status.json", data);
  }

  /** Only call when at least one snapshot is a long or short candidate; writes `runs/{timestamp}.json`. */
  async writePaperCandidateRun(timestamp: number, payload: PaperCandidateRunPayload): Promise<string> {
    return await this.writeJson(`runs/${timestamp}.json`, payload);
  }

  /**
   * Merge `newItem` into `runs/index.json`: newest first, dedupe by `fetchedAt`, cap at RUNS_INDEX_MAX_ITEMS.
   */
  async updateRunsIndex(newItem: CandidateRunIndexItem): Promise<string> {
    const indexRel = "runs/index.json";
    let prior: CandidateRunIndex | null = null;
    try {
      const fullPath = path.resolve(this.baseDir, indexRel);
      const raw = await fs.readFile(fullPath, "utf8");
      prior = JSON.parse(raw) as CandidateRunIndex;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw e;
    }

    const oldItems = Array.isArray(prior?.items) ? prior!.items : [];
    const withoutDup = oldItems.filter((it) => it.fetchedAt !== newItem.fetchedAt);
    const merged = [newItem, ...withoutDup];
    const items = merged
      .sort((a, b) => b.fetchedAt - a.fetchedAt)
      .slice(0, RUNS_INDEX_MAX_ITEMS);

    const next: CandidateRunIndex = {
      updatedAt: Date.now(),
      total: items.length,
      items
    };
    return await this.writeJson(indexRel, next);
  }

  /**
   * `positions/open.json`: JSON array of open records (v2), or legacy single object `{ status:"open", ... }`.
   */
  async readPositionsOpenAll(): Promise<PaperOpenPositionRecord[]> {
    const rel = "positions/open.json";
    const fullPath = path.resolve(this.baseDir, rel);
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const j = JSON.parse(raw) as unknown;
      if (Array.isArray(j)) {
        return j
          .filter((x): x is PaperOpenPositionRecord => isPaperOpenRecord(x))
          .map(migrateLegacyExecutorAtEntry);
      }
      if (j && typeof j === "object" && isPaperOpenRecord(j)) {
        return [migrateLegacyExecutorAtEntry(j)];
      }
      return [];
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return [];
      throw e;
    }
  }

  async writePositionsOpenAll(list: readonly PaperOpenPositionRecord[]): Promise<string> {
    const dedup = dedupeOpensBySymbol(list);
    return await this.writeJson("positions/open.json", dedup);
  }

  // --- PENDING ENTRY REGISTRY ---
  async readPendingEntryOrders(): Promise<import("../models/types").PendingEntryOrderRecord[]> {
    const rel = "runtime/pending-entry-orders.json";
    const fullPath = path.resolve(this.baseDir, rel);
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e: unknown) {
      return [];
    }
  }

  async writePendingEntryOrders(list: readonly import("../models/types").PendingEntryOrderRecord[]): Promise<string> {
    return await this.writeJson("runtime/pending-entry-orders.json", list);
  }

  /** Ensure `positions/history.json` exists as an empty array. */
  async ensurePositionsHistoryEmpty(): Promise<void> {
    const rel = "positions/history.json";
    const fullPath = path.resolve(this.baseDir, rel);
    try {
      await fs.access(fullPath);
    } catch {
      await this.writeJson(rel, []);
    }
  }

  async appendPositionsHistory(record: PaperClosedPositionRecord): Promise<void> {
    await this.ensurePositionsHistoryEmpty();
    const rel = "positions/history.json";
    const fullPath = path.resolve(this.baseDir, rel);
    const raw = await fs.readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? [...parsed] : [];
    list.push(record);
    await fs.writeFile(fullPath, JSON.stringify(list, null, 2), "utf8");
  }

  async deletePositionsOpen(): Promise<void> {
    await this.writePositionsOpenAll([]);
  }

  /** Full `positions/history.json` array (ensures file exists). */
  async readPositionsHistory(): Promise<unknown[]> {
    await this.ensurePositionsHistoryEmpty();
    const rel = "positions/history.json";
    const fullPath = path.resolve(this.baseDir, rel);
    const raw = await fs.readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  }

  /** Regenerate summary reports from current history (shared `generatedAt`). */
  async writePaperSummaryReport(okxBalance?: OkxLiveBalance): Promise<{
    summaryPath: string;
    dailyPath: string;
    windowPath: string;
    healthPath: string;
    publicBundlePath: string;
    health: PaperHealthReport;
  }> {
    const history = await this.readPositionsHistory();
    const generatedAt = Date.now();
    const events = await this.readEventsJsonlFile();
    const aiBlockEval = await this.readAiBlockEvalJson();
    const summaryBase = buildPaperSummaryFromHistory(history, generatedAt);
    const byRegime = buildPaperSummaryByRegimeFromHistory(history, generatedAt);
    const dailyBase = buildPaperDailySummaryFromHistory(history, generatedAt);
    const { summary, daily } = attachObservationToReports({
      summary: summaryBase,
      daily: dailyBase,
      byRegimeAll: { range: byRegime.range, trend: byRegime.trend },
      history,
      events,
      aiBlockEval
    });
    const window = buildPaperWindowSummaryFromHistory(history, generatedAt);
    const health = buildPaperHealthReport(window);
    const summaryPath = await this.writeJson("reports/summary.json", summary);
    await this.writeJson("reports/summary-range.json", { generatedAt, ...byRegime.range });
    await this.writeJson("reports/summary-trend.json", { generatedAt, ...byRegime.trend });
    const dailyPath = await this.writeJson("reports/summary-daily.json", daily);
    const windowPath = await this.writeJson("reports/summary-window.json", window);
    const healthPath = await this.writeJson("reports/summary-health.json", health);
    await this.appendJsonlLine("reports/health-history.jsonl", paperHealthHistoryJsonlLine(health));
    const healthHistoryLines = await this.readHealthHistoryJsonlFile();
    const tradeControl = await this.readTradeControlForDashboard();
    const dashboard = buildPaperDashboard({ summary, window, health, healthHistoryLines, tradeControl, okx_balance: okxBalance });
    await this.writeJson("reports/dashboard.json", dashboard);
    const projectRoot = path.resolve(this.baseDir, "..");
    const publicBundleRel = "reports/public-futures-paper-bundle.json";
    const publicBundleAbs = path.resolve(this.baseDir, publicBundleRel);
    console.log(
      JSON.stringify({
        event: "PUBLIC_BUNDLE_WRITE_START",
        path: publicBundleAbs,
        at: Date.now()
      })
    );
    try {
      const publicBundle = await composePublicFuturesPaperBundleForWrite({
        projectRoot,
        summary,
        summaryRange: { generatedAt, ...byRegime.range },
        summaryTrend: { generatedAt, ...byRegime.trend },
        summaryDaily: daily,
        summaryWindow: window,
        summaryHealth: health,
        dashboard,
        positionsHistoryRaw: history,
        eventsParsed: events,
        healthHistoryParsed: healthHistoryLines
      });
      const publicBundlePath = await this.writeJson(publicBundleRel, publicBundle);
      const st = await fs.stat(publicBundlePath);
      const openPositionsCount = Array.isArray(publicBundle.openPositions) ? publicBundle.openPositions.length : -1;
      const positionsHistoryCount = Array.isArray(publicBundle.positionsHistory) ? publicBundle.positionsHistory.length : -1;
      const symbolRowsCount = Array.isArray(publicBundle.symbolRows) ? publicBundle.symbolRows.length : -1;
      const hasDashboard = publicBundle.dashboard != null;
      const hasEngineState = publicBundle.engineState != null;
      console.log(
        JSON.stringify({
          event: "PUBLIC_BUNDLE_WRITE_SUCCESS",
          path: publicBundlePath,
          bytes: st.size,
          generatedAt: publicBundle.generatedAt,
          openPositionsCount,
          positionsHistoryCount,
          symbolRowsCount,
          hasDashboard,
          hasEngineState
        })
      );
      return { summaryPath, dailyPath, windowPath, healthPath, publicBundlePath, health };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      const reason = e instanceof Error ? e.name : "unknown";
      const stackSlice =
        e instanceof Error && e.stack ? e.stack.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 400) : undefined;
      console.error(
        JSON.stringify({
          event: "PUBLIC_BUNDLE_WRITE_FAIL",
          path: publicBundleAbs,
          reason,
          message,
          stackSlice
        })
      );
      throw e;
    }
  }
}

