import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { PaperClosedPositionRecord, PaperOpenPositionRecord } from "../models/types";
import { buildPaperDashboard, parseHealthHistoryJsonl } from "./paper-dashboard";
import { buildPaperHealthReport, paperHealthHistoryJsonlLine, type PaperHealthReport } from "./paper-health";
import {
  buildPaperDailySummaryFromHistory,
  buildPaperSummaryFromHistory,
  buildPaperWindowSummaryFromHistory
} from "./paper-summary";

export const RUNS_INDEX_MAX_ITEMS = 50;

export type CandidateRunIndexItem = Readonly<{
  fetchedAt: number;
  runPath: string;
  strategyVersion: string;
  longCandidates: number;
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

/** Payload written to `runs/{fetchedAt}.json` when a long candidate exists. */
export type PaperCandidateRunPayload = Readonly<{
  fetchedAt: number;
  strategyVersion: string;
  longCandidates: number;
  candidateSymbols: string[];
  snapshots: unknown;
  latestSnapshotPath?: string;
  latestMetaPath?: string;
  /** Immutable `snapshots/{fetchedAt}.json` for this run (if available). */
  timestampSnapshotPath?: string;
}>;

export class JsonStore {
  constructor(private readonly baseDir: string) {}

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

  /** Read `reports/health-history.jsonl` (empty if missing). */
  async readHealthHistoryJsonlFile(): Promise<ReturnType<typeof parseHealthHistoryJsonl>> {
    const fullPath = path.resolve(this.baseDir, "reports/health-history.jsonl");
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      return parseHealthHistoryJsonl(raw);
    } catch {
      return [];
    }
  }

  async writeSnapshotLatest(data: unknown): Promise<string> {
    return await this.writeJson("snapshots/latest.json", data);
  }

  async writeSnapshotLatestMeta(data: unknown): Promise<string> {
    return await this.writeJson("snapshots/latest-meta.json", data);
  }

  /** Only call when at least one snapshot is a long candidate; writes `runs/{timestamp}.json`. */
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

  async readPositionsOpen(): Promise<PaperOpenPositionRecord | null> {
    const rel = "positions/open.json";
    try {
      const fullPath = path.resolve(this.baseDir, rel);
      const raw = await fs.readFile(fullPath, "utf8");
      const j = JSON.parse(raw) as unknown;
      if (!j || typeof j !== "object" || (j as { status?: string }).status !== "open") return null;
      return j as PaperOpenPositionRecord;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return null;
      throw e;
    }
  }

  async writePositionsOpen(pos: PaperOpenPositionRecord): Promise<string> {
    return await this.writeJson("positions/open.json", pos);
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
    const fullPath = path.resolve(this.baseDir, "positions/open.json");
    try {
      await fs.unlink(fullPath);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw e;
    }
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
  async writePaperSummaryReport(): Promise<{
    summaryPath: string;
    dailyPath: string;
    windowPath: string;
    healthPath: string;
    health: PaperHealthReport;
  }> {
    const history = await this.readPositionsHistory();
    const generatedAt = Date.now();
    const summary = buildPaperSummaryFromHistory(history, generatedAt);
    const daily = buildPaperDailySummaryFromHistory(history, generatedAt);
    const window = buildPaperWindowSummaryFromHistory(history, generatedAt);
    const health = buildPaperHealthReport(window);
    const summaryPath = await this.writeJson("reports/summary.json", summary);
    const dailyPath = await this.writeJson("reports/summary-daily.json", daily);
    const windowPath = await this.writeJson("reports/summary-window.json", window);
    const healthPath = await this.writeJson("reports/summary-health.json", health);
    await this.appendJsonlLine("reports/health-history.jsonl", paperHealthHistoryJsonlLine(health));
    const healthHistoryLines = await this.readHealthHistoryJsonlFile();
    const dashboard = buildPaperDashboard({ summary, window, health, healthHistoryLines });
    await this.writeJson("reports/dashboard.json", dashboard);
    return { summaryPath, dailyPath, windowPath, healthPath, health };
  }
}

