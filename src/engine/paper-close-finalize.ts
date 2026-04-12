import type {
  MarketSymbol,
  PaperClosedPositionRecord,
  PaperExitType,
  PaperOpenPositionRecord
} from "../models/types";

/** JSON 직렬화 시 `null`이 되는 NaN 방지용 — 값이 없으면 0. */
export function finiteUsd(n: number): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export type PaperCloseLegMetrics = Readonly<{
  pnlUsdGross: number;
  pnlUsdNet: number;
  pnlPctNet: number;
  feeUsd: number;
  fundingUsd: number;
  fundingPeriods: number;
  fundingRateAppliedOpen: number;
  fundingRateAppliedClose: number;
  fundingRateAverage: number;
  holdingMs: number;
}>;

export function computePaperCloseLegMetrics(input: Readonly<{
  open: PaperOpenPositionRecord;
  closePrice: number;
  closedAt: number;
  snapFundingRate: number;
  marginUsd: number;
  paperTakerFeeRate: number;
  paperFundingIntervalHours: number;
}>): PaperCloseLegMetrics {
  const feeRate = input.paperTakerFeeRate;
  const lev = input.open.leverage;
  const marginRaw = input.marginUsd;
  const margin =
    typeof marginRaw === "number" && Number.isFinite(marginRaw) && marginRaw > 0 ? marginRaw : 0;
  const openNotionalUsd = margin * lev;
  const closeNotionalUsd = margin * lev;
  const feeUsd = (openNotionalUsd + closeNotionalUsd) * feeRate;

  const ep = input.open.entryPrice;
  const entryOk = typeof ep === "number" && Number.isFinite(ep) && ep > 0;
  const pnlUsdGross = !entryOk
    ? 0
    : input.open.side === "long"
      ? ((input.closePrice - ep) / ep) * margin * lev
      : ((ep - input.closePrice) / ep) * margin * lev;

  const rawOpenFr = input.open.openFundingRate;
  const fundingRateAppliedOpen = typeof rawOpenFr === "number" && Number.isFinite(rawOpenFr) ? rawOpenFr : 0;
  const rawCloseFr = input.snapFundingRate;
  const fundingRateAppliedClose =
    typeof rawCloseFr === "number" && Number.isFinite(rawCloseFr)
      ? rawCloseFr
      : fundingRateAppliedOpen !== 0
        ? fundingRateAppliedOpen
        : 0;
  const fundingRateAverage = (fundingRateAppliedOpen + fundingRateAppliedClose) / 2;

  const intervalH = input.paperFundingIntervalHours;
  const intervalMs = intervalH * 60 * 60 * 1000;
  const holdingMsRaw = input.closedAt - input.open.openedAt;
  const holdingMs = holdingMsRaw <= 0 ? 0 : holdingMsRaw;
  const fundingPeriods = intervalMs > 0 && holdingMs > 0 ? holdingMs / intervalMs : 0;
  const fundingUsd = margin * lev * fundingRateAverage * fundingPeriods;
  const pnlUsdNet = pnlUsdGross - feeUsd - fundingUsd;
  const pnlPctNet = margin > 0 ? pnlUsdNet / margin : 0;

  return {
    pnlUsdGross: finiteUsd(pnlUsdGross),
    pnlUsdNet: finiteUsd(pnlUsdNet),
    pnlPctNet: finiteUsd(pnlPctNet),
    feeUsd: finiteUsd(feeUsd),
    fundingUsd: finiteUsd(fundingUsd),
    fundingPeriods: finiteUsd(fundingPeriods),
    fundingRateAppliedOpen: finiteUsd(fundingRateAppliedOpen),
    fundingRateAppliedClose: finiteUsd(fundingRateAppliedClose),
    fundingRateAverage: finiteUsd(fundingRateAverage),
    holdingMs: finiteUsd(holdingMs)
  };
}

export function paperExitDisplayMeta(
  closeReason: PaperClosedPositionRecord["closeReason"]
): Readonly<{ exitType: PaperExitType; closeReasonLabel: string }> {
  switch (closeReason) {
    case "candidate_lost":
      return { exitType: "EXIT_SIGNAL_LOST", closeReasonLabel: "진입 후보 약화로 정리" };
    case "partial_exit_1":
      return { exitType: "EXIT_PARTIAL_TP", closeReasonLabel: "1차 익절" };
    case "partial_exit_2":
      return { exitType: "EXIT_PARTIAL_TP", closeReasonLabel: "2차 익절" };
    case "take_profit":
      return { exitType: "EXIT_TP", closeReasonLabel: "익절" };
    case "stop_loss":
      return { exitType: "EXIT_SL", closeReasonLabel: "손절" };
    case "trailing_stop":
      return { exitType: "EXIT_TRAILING", closeReasonLabel: "트레일링 스탑" };
    case "time_based_exit":
      return { exitType: "EXIT_TIME_STOP", closeReasonLabel: "시간 청산" };
    case "trend_break_exit":
      return { exitType: "EXIT_TREND_BREAK", closeReasonLabel: "추세 이탈 청산" };
    case "regime_exit":
      return { exitType: "EXIT_REGIME", closeReasonLabel: "레짐 청산" };
    default: {
      const _exhaustive: never = closeReason;
      return _exhaustive;
    }
  }
}

type FinalizeClosedInput = Readonly<{
  open: PaperOpenPositionRecord;
  symbol: MarketSymbol;
  closePrice: number;
  closedAt: number;
  closeReason: PaperClosedPositionRecord["closeReason"];
  /** 청산 레그의 마진(USD). 전량이면 열린 포지션 `sizeUsd`, 분할이면 해당 분할 마진. */
  legMarginUsd: number;
  metrics: PaperCloseLegMetrics;
  feeRate: number;
  fundingIntervalHours: number;
  strategyVersion: string;
  latestSnapshotPath?: string;
  latestMetaPath?: string;
  timestampSnapshotPath?: string;
}>;

/** 모든 종료·부분종료 레코드는 이 함수로 마감해 숫자 NaN → JSON null을 막고 exit 메타를 통일한다. */
export function finalizePaperClosedRecord(input: FinalizeClosedInput): PaperClosedPositionRecord {
  const m = input.metrics;
  const { exitType, closeReasonLabel } = paperExitDisplayMeta(input.closeReason);
  const sizeUsd = finiteUsd(input.legMarginUsd);
  const net = finiteUsd(m.pnlUsdNet);
  const gross = finiteUsd(m.pnlUsdGross);
  return {
    openedAt: input.open.openedAt,
    closedAt: input.closedAt,
    symbol: input.symbol,
    side: input.open.side,
    entryPrice: finiteUsd(input.open.entryPrice),
    closePrice: finiteUsd(input.closePrice),
    leverage: finiteUsd(input.open.leverage),
    sizeUsd,
    pnlUsd: net,
    pnlUsdGross: gross,
    pnlUsdNet: net,
    feeRate: finiteUsd(input.feeRate),
    feeUsd: finiteUsd(m.feeUsd),
    fundingModel: "avg_open_close_rate_v3",
    fundingIntervalHours: finiteUsd(input.fundingIntervalHours),
    holdingMs: finiteUsd(m.holdingMs),
    fundingPeriods: finiteUsd(m.fundingPeriods),
    fundingRateAppliedOpen: finiteUsd(m.fundingRateAppliedOpen),
    fundingRateAppliedClose: finiteUsd(m.fundingRateAppliedClose),
    fundingRateAverage: finiteUsd(m.fundingRateAverage),
    fundingUsd: finiteUsd(m.fundingUsd),
    strategyVersion: input.strategyVersion,
    sourceSignal: input.open.sourceSignal,
    sourceRunPath: input.open.sourceRunPath,
    regimeAtEntry: input.open.regimeAtEntry,
    entryStageAtClose: input.open.entryStage ?? 1,
    ...(input.latestSnapshotPath ? { latestSnapshotPath: input.latestSnapshotPath } : {}),
    ...(input.latestMetaPath ? { latestMetaPath: input.latestMetaPath } : {}),
    ...(input.timestampSnapshotPath ? { timestampSnapshotPath: input.timestampSnapshotPath } : {}),
    closeReason: input.closeReason,
    exitType,
    closeReasonLabel
  };
}
