import type { PaperHealthHistoryJsonlLine, PaperHealthReport, PaperHealthStatus } from "./paper-health";
import type { PaperSummaryReport, PaperSummaryStats, PaperWindowSummaryReport } from "./paper-summary";

export type PaperDashboardSnapshot = Readonly<{
  all: Readonly<{
    totalTrades: number;
    winRate: number;
    totalPnlUsdNet: number;
    totalFeeUsd: number;
    totalFundingUsd: number;
  }>;
  last7d: Readonly<{
    totalTrades: number;
    winRate: number;
    totalPnlUsdNet: number;
  }>;
  last30d: Readonly<{
    totalTrades: number;
    winRate: number;
    totalPnlUsdNet: number;
  }>;
  monthToDate: Readonly<{
    totalTrades: number;
    winRate: number;
    totalPnlUsdNet: number;
  }>;
}>;

/** 수수료·gross·손익비 요약 (리포트/모니터용). */
export type PaperDashboardFeeSlice = Readonly<{
  totalTrades: number;
  totalPnlUsdGross: number;
  totalFeeUsd: number;
  totalFundingUsd: number;
  totalPnlUsdNet: number;
  averageWinPnlUsdNet: number | null;
  averageLossPnlUsdNet: number | null;
  averageFeeUsdPerTrade: number;
  profitFactorNet: number | null;
  avgWinToAvgLossRatio: number | null;
  tradesGrossPositiveNetNegative: number;
  tradesGrossPositiveNetNegativeRatio: number;
  netToGrossRatio: number | null;
  feeToGrossRatio: number | null;
}>;

export type PaperDashboardRecentTrend = Readonly<{
  latestStatuses: string[];
  statusCounts: Record<string, number>;
  changed: boolean;
  latestGeneratedAt: number | null;
  previousGeneratedAt: number | null;
}>;

export type PaperDashboardTradeControl = Readonly<{
  serverTradeEnabled: boolean;
  closeOnlyMode: boolean;
  killSwitch: boolean;
  updatedAt: number;
  reason: string | null;
  source: string;
}>;

export type OkxLiveBalance = Readonly<{
  okx_balance_mode?: string;
  okx_balance_source?: string;
  okx_available_balance_usdt: number | null;
  okx_total_equity_usdt: number | null;
  okx_cash_balance_usdt: number | null;
  okx_margin_used_usdt: number | null;
  okx_unrealized_pnl_usdt: number | null;
  okx_balance_updated_at: number;
  okx_balance_age_ms: number | null;
  okx_balance_fresh: boolean;
  okx_balance_error: string | null;
}>;

export type PaperDashboardReport = Readonly<{
  generatedAt: number;
  status: PaperHealthStatus;
  reasons: string[];
  headline: string;
  tradeControl: PaperDashboardTradeControl;
  okx_balance?: OkxLiveBalance;
  snapshot: PaperDashboardSnapshot;
  /** gross·fee·net·profit factor 등 (last7d/30d/전체). */
  feeAnalytics: Readonly<{
    last7d: PaperDashboardFeeSlice;
    last30d: PaperDashboardFeeSlice;
    all: PaperDashboardFeeSlice;
  }>;
  recentTrend: PaperDashboardRecentTrend;
  observation: import("./paper-summary").PaperObservationMetrics;
}>;

function pickWinSlice(s: PaperSummaryStats): { totalTrades: number; winRate: number; totalPnlUsdNet: number } {
  return {
    totalTrades: s.totalTrades,
    winRate: s.winRate,
    totalPnlUsdNet: s.totalPnlUsdNet
  };
}

function pickFeeSlice(s: PaperSummaryStats): PaperDashboardFeeSlice {
  return {
    totalTrades: s.totalTrades,
    totalPnlUsdGross: s.totalPnlUsdGross,
    totalFeeUsd: s.totalFeeUsd,
    totalFundingUsd: s.totalFundingUsd,
    totalPnlUsdNet: s.totalPnlUsdNet,
    averageWinPnlUsdNet: s.averageWinPnlUsdNet,
    averageLossPnlUsdNet: s.averageLossPnlUsdNet,
    averageFeeUsdPerTrade: s.averageFeeUsdPerTrade,
    profitFactorNet: s.profitFactorNet,
    avgWinToAvgLossRatio: s.avgWinToAvgLossRatio,
    tradesGrossPositiveNetNegative: s.tradesGrossPositiveNetNegative,
    tradesGrossPositiveNetNegativeRatio: s.tradesGrossPositiveNetNegativeRatio,
    netToGrossRatio: s.netToGrossRatio,
    feeToGrossRatio: s.feeToGrossRatio
  };
}

function buildHeadline(health: PaperHealthReport, window: PaperWindowSummaryReport): string {
  const st = health.status;
  const w = window.windows;
  const l7 = w.last7d.totalPnlUsdNet;

  if (st === "insufficient-data") {
    return "insufficient-data · 표본 부족";
  }
  if (st === "cold") {
    return "cold · 최근 거래 없음";
  }
  if (st === "weak") {
    const bits: string[] = [];
    if (l7 < 0) bits.push("최근 7일 손익 음수");
    if (health.reasons.includes("last30d_win_rate_low")) bits.push("최근 30일 승률 낮음");
    if (health.reasons.includes("fee_drag_high")) bits.push("수수료 부담 큼");
    if (health.reasons.includes("funding_drag_high")) bits.push("펀딩 부담 큼");
    if (bits.length === 0) bits.push("지표 약세");
    return `weak · ${bits.join(" · ")}`;
  }

  const l7Label = l7 >= 0 ? "최근 7일 손익 플러스" : "최근 7일 손익 음수";
  return `healthy · ${l7Label} · 최근 30일 승률 양호`;
}

function buildRecentTrend(lines: readonly PaperHealthHistoryJsonlLine[]): PaperDashboardRecentTrend {
  if (lines.length === 0) {
    return {
      latestStatuses: [],
      statusCounts: {},
      changed: false,
      latestGeneratedAt: null,
      previousGeneratedAt: null
    };
  }

  const last10 = lines.slice(-10);
  const latestStatuses = [...last10].reverse().map((r) => r.status);

  const statusCounts: Record<string, number> = {};
  for (const r of last10) {
    statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
  }

  const latest = lines[lines.length - 1]!;
  const previous = lines.length >= 2 ? lines[lines.length - 2]! : null;

  return {
    latestStatuses,
    statusCounts,
    changed: previous !== null && previous.status !== latest.status,
    latestGeneratedAt: latest.generatedAt,
    previousGeneratedAt: previous !== null ? previous.generatedAt : null
  };
}

/** Parse `health-history.jsonl` content (may be empty). */
export function parseHealthHistoryJsonl(raw: string): PaperHealthHistoryJsonlLine[] {
  const out: PaperHealthHistoryJsonlLine[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const j = JSON.parse(t) as unknown;
      if (!j || typeof j !== "object") continue;
      const o = j as Record<string, unknown>;
      const ga = o.generatedAt;
      const st = o.status;
      if (typeof ga !== "number" || !Number.isFinite(ga)) continue;
      if (typeof st !== "string") continue;
      out.push(j as PaperHealthHistoryJsonlLine);
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

export function buildPaperDashboard(input: Readonly<{
  summary: PaperSummaryReport;
  window: PaperWindowSummaryReport;
  health: PaperHealthReport;
  healthHistoryLines: readonly PaperHealthHistoryJsonlLine[];
  tradeControl: PaperDashboardTradeControl;
  okx_balance?: OkxLiveBalance;
}>): PaperDashboardReport {
  const { summary, window, health, healthHistoryLines, tradeControl, okx_balance } = input;
  const w = window.windows;

  const snapshot: PaperDashboardSnapshot = {
    all: {
      totalTrades: summary.totalTrades,
      winRate: summary.winRate,
      totalPnlUsdNet: summary.totalPnlUsdNet,
      totalFeeUsd: summary.totalFeeUsd,
      totalFundingUsd: summary.totalFundingUsd
    },
    last7d: pickWinSlice(w.last7d),
    last30d: pickWinSlice(w.last30d),
    monthToDate: pickWinSlice(w.monthToDate)
  };

  const feeAnalytics = {
    last7d: pickFeeSlice(w.last7d),
    last30d: pickFeeSlice(w.last30d),
    all: pickFeeSlice(w.all)
  };

  return {
    generatedAt: health.generatedAt,
    status: health.status,
    reasons: [...health.reasons],
    headline: buildHeadline(health, window),
    tradeControl,
    okx_balance,
    snapshot,
    feeAnalytics,
    recentTrend: buildRecentTrend(healthHistoryLines),
    observation: summary.observation
  };
}
