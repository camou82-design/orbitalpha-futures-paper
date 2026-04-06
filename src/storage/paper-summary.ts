/** Core metrics shared by overall and per-day reports (no `generatedAt`). */
export type PaperSummaryStats = Readonly<{
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  /** `winTrades / totalTrades` when `totalTrades > 0`, else `0`. Breakeven trades count as neither win nor loss but do count in `totalTrades`. */
  winRate: number;
  totalPnlUsdNet: number;
  averagePnlUsdNet: number;
  bestTradePnlUsdNet: number | null;
  worstTradePnlUsdNet: number | null;
  totalFeeUsd: number;
  totalFundingUsd: number;
  averageHoldingMs: number;
  latestClosedAt: number | null;
  strategyVersions: string[];
  symbolsTraded: Record<string, number>;
  /** 종료 거래 gross 합 (수수료·펀딩 전). */
  totalPnlUsdGross: number;
  /** 승리 건 순손익 평균 (승 없으면 null). */
  averageWinPnlUsdNet: number | null;
  /** 패배 건 순손익 평균, 음수 (패 없으면 null). */
  averageLossPnlUsdNet: number | null;
  /** 건당 평균 수수료. */
  averageFeeUsdPerTrade: number;
  /** 순손익 기준 profit factor: Σ(승 net) / |Σ(패 net)|. */
  profitFactorNet: number | null;
  /** |평균 승| / |평균 패| (둘 다 있을 때). */
  avgWinToAvgLossRatio: number | null;
  /** gross > 0 이지만 net < 0 인 거래 수 (수수료 등으로 역전). */
  tradesGrossPositiveNetNegative: number;
  /** 위 비중 / totalTrades. */
  tradesGrossPositiveNetNegativeRatio: number;
  /** totalNet / totalGross (gross 0이면 null). */
  netToGrossRatio: number | null;
  /** gross 대비 수수료 비율 totalFee/totalGross (gross 0이면 null). */
  feeToGrossRatio: number | null;
}>;

/** Written to `data/reports/summary.json` from `positions/history.json`. */
export type PaperSummaryReport = Readonly<PaperSummaryStats & { generatedAt: number }>;

/** One UTC calendar day bucket for `summary-daily.json`. */
export type PaperDayBucket = Readonly<PaperSummaryStats & { date: string }>;

/** Written to `data/reports/summary-daily.json`. */
export type PaperDailySummaryReport = Readonly<{
  generatedAt: number;
  bucketType: "daily";
  days: Record<string, PaperDayBucket>;
}>;

/** Rolling / MTD / full-history windows for `summary-window.json`. */
export type PaperWindowSummaryReport = Readonly<{
  generatedAt: number;
  windows: Readonly<{
    last7d: PaperSummaryStats;
    last30d: PaperSummaryStats;
    monthToDate: PaperSummaryStats;
    all: PaperSummaryStats;
  }>;
}>;

function parseRow(
  r: unknown
): {
  pnlUsdNet: number;
  pnlUsdGross: number;
  feeUsd: number;
  fundingUsd: number;
  holdingMs: number | undefined;
  closedAt: number | undefined;
  strategyVersion: string | undefined;
  symbol: string | undefined;
} | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const pnl = o.pnlUsdNet;
  if (typeof pnl !== "number" || !Number.isFinite(pnl)) return null;
  const fee = o.feeUsd;
  const fund = o.fundingUsd;
  const feeUsd = typeof fee === "number" && Number.isFinite(fee) ? fee : 0;
  const fundingUsd = typeof fund === "number" && Number.isFinite(fund) ? fund : 0;
  const hm = o.holdingMs;
  const holdingMs = typeof hm === "number" && Number.isFinite(hm) && hm >= 0 ? hm : undefined;
  const ca = o.closedAt;
  const closedAt = typeof ca === "number" && Number.isFinite(ca) ? ca : undefined;
  const sv = o.strategyVersion;
  const strategyVersion = typeof sv === "string" && sv.length > 0 ? sv : undefined;
  const sym = o.symbol;
  const symbol = typeof sym === "string" && sym.length > 0 ? sym : undefined;
  const g = o.pnlUsdGross;
  let pnlUsdGross: number;
  if (typeof g === "number" && Number.isFinite(g)) pnlUsdGross = g;
  else pnlUsdGross = pnl + feeUsd + fundingUsd;
  return { pnlUsdNet: pnl, pnlUsdGross, feeUsd, fundingUsd, holdingMs, closedAt, strategyVersion, symbol };
}

type ParsedHistoryRow = NonNullable<ReturnType<typeof parseRow>>;

function utcDayKeyFromMs(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function utcMonthStartMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function aggregateRows(rows: ParsedHistoryRow[]): PaperSummaryStats {
  const totalTrades = rows.length;
  let winTrades = 0;
  let lossTrades = 0;
  let totalPnlUsdNet = 0;
  let totalPnlUsdGross = 0;
  let totalFeeUsd = 0;
  let totalFundingUsd = 0;
  let totalHoldingMs = 0;
  let holdingCount = 0;
  let best: number | null = null;
  let worst: number | null = null;
  let latestClosedAt: number | null = null;
  const versionSet = new Set<string>();
  const symbolsTraded: Record<string, number> = {};
  let sumWinNet = 0;
  let sumLossNet = 0;
  let tradesGrossPositiveNetNegative = 0;

  for (const row of rows) {
    const p = row.pnlUsdNet;
    totalPnlUsdNet += p;
    totalPnlUsdGross += row.pnlUsdGross;
    totalFeeUsd += row.feeUsd;
    totalFundingUsd += row.fundingUsd;
    if (p > 0) {
      winTrades += 1;
      sumWinNet += p;
    } else if (p < 0) {
      lossTrades += 1;
      sumLossNet += p;
    }
    if (row.pnlUsdGross > 0 && row.pnlUsdNet < 0) tradesGrossPositiveNetNegative += 1;
    if (best === null || p > best) best = p;
    if (worst === null || p < worst) worst = p;
    if (row.holdingMs !== undefined) {
      totalHoldingMs += row.holdingMs;
      holdingCount += 1;
    }
    if (row.closedAt !== undefined) {
      if (latestClosedAt === null || row.closedAt > latestClosedAt) latestClosedAt = row.closedAt;
    }
    if (row.strategyVersion) versionSet.add(row.strategyVersion);
    if (row.symbol) {
      const k = row.symbol;
      symbolsTraded[k] = (symbolsTraded[k] ?? 0) + 1;
    }
  }

  const winRate = totalTrades > 0 ? winTrades / totalTrades : 0;
  const averagePnlUsdNet = totalTrades > 0 ? totalPnlUsdNet / totalTrades : 0;
  const averageHoldingMs = holdingCount > 0 ? totalHoldingMs / holdingCount : 0;
  const strategyVersions = [...versionSet].sort();

  const averageWinPnlUsdNet = winTrades > 0 ? sumWinNet / winTrades : null;
  const averageLossPnlUsdNet = lossTrades > 0 ? sumLossNet / lossTrades : null;
  const averageFeeUsdPerTrade = totalTrades > 0 ? totalFeeUsd / totalTrades : 0;
  const lossAbs = sumLossNet < 0 ? Math.abs(sumLossNet) : 0;
  const profitFactorNet = lossAbs > 0 && sumWinNet > 0 ? sumWinNet / lossAbs : null;
  const avgWinToAvgLossRatio =
    averageWinPnlUsdNet !== null &&
    averageLossPnlUsdNet !== null &&
    averageLossPnlUsdNet !== 0
      ? Math.abs(averageWinPnlUsdNet / averageLossPnlUsdNet)
      : null;
  const tradesGrossPositiveNetNegativeRatio =
    totalTrades > 0 ? tradesGrossPositiveNetNegative / totalTrades : 0;
  const netToGrossRatio =
    totalPnlUsdGross !== 0 && Number.isFinite(totalPnlUsdGross) ? totalPnlUsdNet / totalPnlUsdGross : null;
  const feeToGrossRatio =
    totalPnlUsdGross !== 0 && Number.isFinite(totalPnlUsdGross) ? totalFeeUsd / totalPnlUsdGross : null;

  return {
    totalTrades,
    winTrades,
    lossTrades,
    winRate,
    totalPnlUsdNet,
    averagePnlUsdNet,
    bestTradePnlUsdNet: totalTrades > 0 ? best : null,
    worstTradePnlUsdNet: totalTrades > 0 ? worst : null,
    totalFeeUsd,
    totalFundingUsd,
    averageHoldingMs,
    latestClosedAt,
    strategyVersions,
    symbolsTraded,
    totalPnlUsdGross,
    averageWinPnlUsdNet,
    averageLossPnlUsdNet,
    averageFeeUsdPerTrade,
    profitFactorNet,
    avgWinToAvgLossRatio,
    tradesGrossPositiveNetNegative,
    tradesGrossPositiveNetNegativeRatio,
    netToGrossRatio,
    feeToGrossRatio
  };
}

/** Aggregate closed-position rows from `history.json` (unknown[]). Skips invalid entries. */
export function buildPaperSummaryFromHistory(history: unknown[], generatedAt: number = Date.now()): PaperSummaryReport {
  const rows: ParsedHistoryRow[] = [];
  for (const r of history) {
    const row = parseRow(r);
    if (row) rows.push(row);
  }
  return { generatedAt, ...aggregateRows(rows) };
}

/**
 * Per UTC calendar day (`closedAt`), same win/loss/PnL rules as `buildPaperSummaryFromHistory`.
 * Rows without a finite `closedAt` are omitted from `days` (not counted in any bucket).
 */
export function buildPaperDailySummaryFromHistory(history: unknown[], generatedAt: number = Date.now()): PaperDailySummaryReport {
  const rows: ParsedHistoryRow[] = [];
  for (const r of history) {
    const row = parseRow(r);
    if (row) rows.push(row);
  }

  const byDay = new Map<string, ParsedHistoryRow[]>();
  for (const row of rows) {
    if (row.closedAt === undefined) continue;
    const key = utcDayKeyFromMs(row.closedAt);
    const list = byDay.get(key);
    if (list) list.push(row);
    else byDay.set(key, [row]);
  }

  const days: Record<string, PaperDayBucket> = {};
  const sortedKeys = [...byDay.keys()].sort();
  for (const key of sortedKeys) {
    const dayRows = byDay.get(key)!;
    days[key] = { date: key, ...aggregateRows(dayRows) };
  }

  return { generatedAt, bucketType: "daily", days };
}

/**
 * Time-window stats from `history.json` using `closedAt` (UTC) for last7d / last30d / monthToDate.
 * Rows without `closedAt` are excluded from those windows only; `all` matches overall `summary.json`.
 */
export function buildPaperWindowSummaryFromHistory(history: unknown[], generatedAt: number = Date.now()): PaperWindowSummaryReport {
  const rows: ParsedHistoryRow[] = [];
  for (const r of history) {
    const row = parseRow(r);
    if (row) rows.push(row);
  }

  const inClosedRange = (row: ParsedHistoryRow, fromInclusive: number): boolean =>
    row.closedAt !== undefined && row.closedAt >= fromInclusive && row.closedAt <= generatedAt;

  const last7d = rows.filter((r) => inClosedRange(r, generatedAt - 7 * MS_PER_DAY));
  const last30d = rows.filter((r) => inClosedRange(r, generatedAt - 30 * MS_PER_DAY));
  const monthStart = utcMonthStartMs(generatedAt);
  const monthToDate = rows.filter((r) => inClosedRange(r, monthStart));

  return {
    generatedAt,
    windows: {
      last7d: aggregateRows(last7d),
      last30d: aggregateRows(last30d),
      monthToDate: aggregateRows(monthToDate),
      all: aggregateRows(rows)
    }
  };
}
