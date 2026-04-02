import type { PaperWindowSummaryReport } from "./paper-summary";

/** Default gates for health status (mirrored in `summary-health.json` → `thresholds`). */
export const DEFAULT_HEALTH_THRESHOLDS = {
  minRecentTrades: 3,
  weakLast30dWinRate: 0.45,
  weakLast7dPnlUsdNet: 0,
  highFeeToPnlRatio: 0.5,
  highFundingToPnlRatio: 0.3
} as const;

export type PaperHealthThresholds = Readonly<{
  minRecentTrades: number;
  weakLast30dWinRate: number;
  weakLast7dPnlUsdNet: number;
  highFeeToPnlRatio: number;
  highFundingToPnlRatio: number;
}>;

export type PaperHealthMetrics = Readonly<{
  last7dTotalTrades: number;
  last7dTotalPnlUsdNet: number;
  last30dTotalTrades: number;
  last30dWinRate: number;
  monthToDateTotalPnlUsdNet: number;
  totalTradesAll: number;
  totalFeeUsdAll: number;
  totalFundingUsdAll: number;
  feeToPnlRatioAll: number | null;
  fundingToPnlRatioAll: number | null;
}>;

export type PaperHealthStatus = "healthy" | "weak" | "cold" | "insufficient-data";

export type PaperHealthReport = Readonly<{
  generatedAt: number;
  status: PaperHealthStatus;
  reasons: string[];
  metrics: PaperHealthMetrics;
  thresholds: PaperHealthThresholds;
}>;

const EPS = 1e-9;

function safeRatio(numerator: number, absPnl: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(absPnl) || absPnl <= EPS) return null;
  const r = numerator / absPnl;
  return Number.isFinite(r) ? r : null;
}

/** Operational health from `summary-window` (same `generatedAt` as other reports). */
export function buildPaperHealthReport(window: PaperWindowSummaryReport): PaperHealthReport {
  const thresholds: PaperHealthThresholds = { ...DEFAULT_HEALTH_THRESHOLDS };
  const { last7d, last30d, monthToDate, all } = window.windows;

  const absPnlAll = Math.abs(all.totalPnlUsdNet);
  const feeToPnlRatioAll = safeRatio(all.totalFeeUsd, absPnlAll);
  const fundingToPnlRatioAll = safeRatio(Math.abs(all.totalFundingUsd), absPnlAll);

  const metrics: PaperHealthMetrics = {
    last7dTotalTrades: last7d.totalTrades,
    last7dTotalPnlUsdNet: last7d.totalPnlUsdNet,
    last30dTotalTrades: last30d.totalTrades,
    last30dWinRate: last30d.winRate,
    monthToDateTotalPnlUsdNet: monthToDate.totalPnlUsdNet,
    totalTradesAll: all.totalTrades,
    totalFeeUsdAll: all.totalFeeUsd,
    totalFundingUsdAll: all.totalFundingUsd,
    feeToPnlRatioAll,
    fundingToPnlRatioAll
  };

  const reasons: string[] = [];

  // 1. No history
  if (all.totalTrades === 0) {
    reasons.push("trade_count_too_small");
    return {
      generatedAt: window.generatedAt,
      status: "insufficient-data",
      reasons,
      metrics,
      thresholds
    };
  }

  // 2. No trades in both rolling windows (stale activity)
  if (last7d.totalTrades === 0 && last30d.totalTrades === 0) {
    reasons.push("no_recent_trades");
    return {
      generatedAt: window.generatedAt,
      status: "cold",
      reasons,
      metrics,
      thresholds
    };
  }

  // 3. Sample too small in last 30d
  if (last30d.totalTrades < thresholds.minRecentTrades) {
    reasons.push("trade_count_too_small");
    return {
      generatedAt: window.generatedAt,
      status: "insufficient-data",
      reasons,
      metrics,
      thresholds
    };
  }

  // 4. Weak signals
  if (last7d.totalPnlUsdNet < thresholds.weakLast7dPnlUsdNet) {
    reasons.push("last7d_pnl_negative");
  }
  if (last30d.winRate < thresholds.weakLast30dWinRate) {
    reasons.push("last30d_win_rate_low");
  }
  if (feeToPnlRatioAll !== null && feeToPnlRatioAll > thresholds.highFeeToPnlRatio) {
    reasons.push("fee_drag_high");
  }
  if (fundingToPnlRatioAll !== null && fundingToPnlRatioAll > thresholds.highFundingToPnlRatio) {
    reasons.push("funding_drag_high");
  }

  if (reasons.length > 0) {
    return {
      generatedAt: window.generatedAt,
      status: "weak",
      reasons,
      metrics,
      thresholds
    };
  }

  return {
    generatedAt: window.generatedAt,
    status: "healthy",
    reasons: [],
    metrics,
    thresholds
  };
}

/** Sentinel when `feeToPnlRatioAll` / `fundingToPnlRatioAll` are not defined (avoids null in console JSON). */
export const PAPER_HEALTH_LOG_RATIO_MISSING = -1;

/** One-line `PAPER_HEALTH_STATUS` log payload (finite numbers only; missing ratios → `PAPER_HEALTH_LOG_RATIO_MISSING`). */
export type PaperHealthStatusLogPayload = Readonly<{
  status: string;
  reasons: string[];
  last7dTotalTrades: number;
  last7dTotalPnlUsdNet: number;
  last30dTotalTrades: number;
  last30dWinRate: number;
  monthToDateTotalPnlUsdNet: number;
  totalTradesAll: number;
  feeToPnlRatioAll: number;
  fundingToPnlRatioAll: number;
}>;

function toFiniteOr(n: number, fallback: number): number {
  return Number.isFinite(n) ? n : fallback;
}

export function paperHealthStatusLogPayload(health: PaperHealthReport): PaperHealthStatusLogPayload {
  const m = health.metrics;
  const ratio = (v: number | null): number =>
    v === null || !Number.isFinite(v) ? PAPER_HEALTH_LOG_RATIO_MISSING : v;
  return {
    status: health.status,
    reasons: [...health.reasons],
    last7dTotalTrades: toFiniteOr(m.last7dTotalTrades, 0),
    last7dTotalPnlUsdNet: toFiniteOr(m.last7dTotalPnlUsdNet, 0),
    last30dTotalTrades: toFiniteOr(m.last30dTotalTrades, 0),
    last30dWinRate: toFiniteOr(m.last30dWinRate, 0),
    monthToDateTotalPnlUsdNet: toFiniteOr(m.monthToDateTotalPnlUsdNet, 0),
    totalTradesAll: toFiniteOr(m.totalTradesAll, 0),
    feeToPnlRatioAll: ratio(m.feeToPnlRatioAll),
    fundingToPnlRatioAll: ratio(m.fundingToPnlRatioAll)
  };
}

/** One JSON Lines row for `health-history.jsonl` (same numeric rules as `paperHealthStatusLogPayload`). */
export type PaperHealthHistoryJsonlLine = Readonly<
  { generatedAt: number } & PaperHealthStatusLogPayload
>;

export function paperHealthHistoryJsonlLine(health: PaperHealthReport): PaperHealthHistoryJsonlLine {
  return {
    generatedAt: health.generatedAt,
    ...paperHealthStatusLogPayload(health)
  };
}
