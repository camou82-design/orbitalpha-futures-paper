/**
 * Closed-trade ledger aggregates for /futures-paper bundle.
 * Mirrors `src/storage/paper-summary.ts` window + win/loss rules
 * so UI matches `data/positions/history.json` at bundle load time.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function utcMonthStartMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}

type ParsedHistoryRow = Readonly<{
  pnlUsdNet: number;
  pnlUsdGross: number;
  feeUsd: number;
  fundingUsd: number;
  holdingMs: number | undefined;
  closedAt: number | undefined;
}>;

function parseRow(r: unknown): ParsedHistoryRow | null {
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
  const g = o.pnlUsdGross;
  let pnlUsdGross: number;
  if (typeof g === "number" && Number.isFinite(g)) pnlUsdGross = g;
  else pnlUsdGross = pnl + feeUsd + fundingUsd;
  return { pnlUsdNet: pnl, pnlUsdGross, feeUsd, fundingUsd, holdingMs, closedAt };
}

export type FuturesPaperLedgerWindowStats = Readonly<{
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  winRate: number;
  totalPnlUsdNet: number;
  totalPnlUsdGross: number;
  totalFeeUsd: number;
  totalFundingUsd: number;
  averagePnlUsdNet: number;
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

export type FuturesPaperLedgerPerformance = Readonly<{
  generatedAt: number;
  parsedTradeCount: number;
  all: FuturesPaperLedgerWindowStats;
  last7d: FuturesPaperLedgerWindowStats;
  last30d: FuturesPaperLedgerWindowStats;
  monthToDate: FuturesPaperLedgerWindowStats;
}>;

function aggregateRows(rows: ParsedHistoryRow[]): FuturesPaperLedgerWindowStats {
  const totalTrades = rows.length;
  let winTrades = 0;
  let lossTrades = 0;
  let totalPnlUsdNet = 0;
  let totalPnlUsdGross = 0;
  let totalFeeUsd = 0;
  let totalFundingUsd = 0;
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
  }

  const winRate = totalTrades > 0 ? winTrades / totalTrades : 0;
  const averagePnlUsdNet = totalTrades > 0 ? totalPnlUsdNet / totalTrades : 0;
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
    totalPnlUsdGross,
    totalFeeUsd,
    totalFundingUsd,
    averagePnlUsdNet,
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

export function buildLedgerPerformanceFromHistory(
  history: unknown[],
  generatedAt: number = Date.now()
): FuturesPaperLedgerPerformance {
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
    parsedTradeCount: rows.length,
    all: aggregateRows(rows),
    last7d: aggregateRows(last7d),
    last30d: aggregateRows(last30d),
    monthToDate: aggregateRows(monthToDate)
  };
}
