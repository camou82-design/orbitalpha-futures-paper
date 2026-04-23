import type {
  MarketSymbol,
  PaperCloseSource,
  PaperClosedPositionRecord,
  PaperExitType,
  PaperOpenPositionRecord
} from "../models/types";

export type PaperCloseReasonLike = PaperClosedPositionRecord["closeReason"] | string;

/** 디스크·레거시에 남은 Highway 60 EMA 전량 종료 원문 → 표준 closeReason 코드. */
export function coerceCanonicalPaperCloseReason(closeReason: PaperCloseReasonLike): PaperCloseReasonLike {
  if (typeof closeReason !== "string") return closeReason;
  const t = closeReason.trim();
  if (
    t === "Highway 60 EMA Breakout (Short)" ||
    t === "Highway 60 EMA Breakdown (Long)" ||
    t === "Highway 60 EMA Breakout (Long)"
  ) {
    return t.includes("Short") ? "highway_ema60_break_short" : "highway_ema60_break_long";
  }
  return closeReason;
}

export function defaultLabelForExitType(t: PaperExitType): string {
  switch (t) {
    case "EXIT_SL":
      return "손절";
    case "EXIT_TP":
      return "익절";
    case "EXIT_TP_1":
      return "1차 익절";
    case "EXIT_TP_2":
      return "2차 익절";
    case "EXIT_PARTIAL_SPLIT_1":
      return "1차 분할 청산";
    case "EXIT_PARTIAL_SPLIT_2":
      return "2차 분할 청산";
    case "EXIT_PARTIAL_TP":
      return "분할 익절";
    case "EXIT_TRAILING":
      return "트레일링 스탑";
    case "EXIT_TIME_STOP":
      return "시간 청산";
    case "EXIT_TREND_BREAK":
      return "추세 이탈 청산";
    case "EXIT_REGIME":
      return "레짐 청산";
    case "EXIT_REGIME_BREAK":
      return "레짐·구조 이탈 청산";
    case "EXIT_SIGNAL_LOST":
      return "진입 후보 약화로 정리";
    case "EXIT_RANGE_REBALANCE":
      return "횡보 리밸런스 청산";
    case "EXIT_TREND_SWITCH":
      return "추세 스위칭(청산+역진입)";
    case "EXIT_RISK":
      return "리스크 강제 정리";
    case "EXIT_LONG_CRASH_FORCE":
      return "급락 보호 롱 강제 종료";
    case "EXIT_LONG_CRASH_REDUCE":
      return "급락 보호 롱 50% 축소";
    case "EXIT_SHORT_MOMENTUM_TRAIL":
      return "급락 중 숏 수익보호 전환";
    case "EXIT_CRASH_FORCE":
      return "급락 보호 강제 청산";
    case "EXIT_CRASH_REDUCE":
      return "급락 위험 비중 축소";
    case "EXIT_UNKNOWN":
      return "미분류 청산";
    default: {
      const _e: never = t;
      return _e;
    }
  }
}

/** `exitType`·내부 `closeReason`으로 UI/저장용 종료 출처 코드. */
export function inferPaperCloseSourceFromExitType(et: PaperExitType): PaperCloseSource {
  switch (et) {
    case "EXIT_SL":
      return "SL";
    case "EXIT_TP":
      return "TP";
    case "EXIT_TP_1":
    case "EXIT_TP_2":
    case "EXIT_PARTIAL_TP":
      return "TP_PARTIAL";
    case "EXIT_PARTIAL_SPLIT_1":
    case "EXIT_PARTIAL_SPLIT_2":
      return "PARTIAL_SPLIT";
    case "EXIT_TRAILING":
      return "TRAIL";
    case "EXIT_TIME_STOP":
      return "TIME";
    case "EXIT_TREND_BREAK":
      return "TREND_BREAK";
    case "EXIT_REGIME":
      return "REGIME_EXIT";
    case "EXIT_REGIME_BREAK":
      return "TREND_BREAK";
    case "EXIT_SIGNAL_LOST":
      return "SIGNAL_LOST";
    case "EXIT_RANGE_REBALANCE":
      return "STRUCTURAL";
    case "EXIT_TREND_SWITCH":
      return "SWITCH";
    case "EXIT_RISK":
      return "RISK";
    case "EXIT_LONG_CRASH_FORCE":
    case "EXIT_LONG_CRASH_REDUCE":
      return "CRASH_LONG_DEFENSE";
    case "EXIT_SHORT_MOMENTUM_TRAIL":
      return "CRASH_SHORT_MOMENTUM";
    case "EXIT_CRASH_FORCE":
    case "EXIT_CRASH_REDUCE":
      return "CRASH";
    case "EXIT_UNKNOWN":
    default:
      return "UNKNOWN";
  }
}

export function derivePaperCloseSource(
  closeReason: PaperCloseReasonLike,
  exitType: PaperExitType
): PaperCloseSource {
  if (exitType === "EXIT_RISK") return "RISK";
  if (exitType === "EXIT_LONG_CRASH_FORCE" || exitType === "EXIT_LONG_CRASH_REDUCE") return "CRASH_LONG_DEFENSE";
  if (exitType === "EXIT_SHORT_MOMENTUM_TRAIL") return "CRASH_SHORT_MOMENTUM";
  if (exitType === "EXIT_CRASH_FORCE" || exitType === "EXIT_CRASH_REDUCE") return "CRASH";

  switch (closeReason) {
    case "EXIT_LONG_CRASH_FORCE":
    case "EXIT_LONG_CRASH_REDUCE":
      return "CRASH_LONG_DEFENSE";
    case "EXIT_SHORT_MOMENTUM_TRAIL":
      return "CRASH_SHORT_MOMENTUM";
    case "EXIT_CRASH_FORCE":
    case "EXIT_CRASH_REDUCE":
      return "CRASH";
    case "stop_loss":
      return "SL";
    case "take_profit":
      return "TP";
    case "partial_exit_1":
    case "partial_exit_2":
      if (exitType === "EXIT_PARTIAL_SPLIT_1" || exitType === "EXIT_PARTIAL_SPLIT_2") return "PARTIAL_SPLIT";
      return "TP_PARTIAL";
    case "trailing_stop":
      return "TRAIL";
    case "range_profit_trail":
      return "TRAIL";
    case "time_based_exit":
      return "TIME";
    case "trend_break_exit":
      return "TREND_BREAK";
    case "regime_exit":
      return "REGIME_EXIT";
    case "range_box_break":
    case "structural_regime_shift":
      return "STRUCTURAL";
    case "trend_switch":
      return "SWITCH";
    case "candidate_lost":
      return "SIGNAL_LOST";
    default:
      if (exitType !== "EXIT_UNKNOWN") return inferPaperCloseSourceFromExitType(exitType);
      return "UNKNOWN";
  }
}

export function outcomeStatusFromNetPnl(netUsd: number): "win" | "loss" | "flat" {
  const eps = 1e-9;
  if (netUsd > eps) return "win";
  if (netUsd < -eps) return "loss";
  return "flat";
}

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
  mark: number;
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
    holdingMs: finiteUsd(holdingMs),
    mark: finiteUsd(input.closePrice)
  };
}

export function paperExitDisplayMeta(
  closeReason: PaperCloseReasonLike
): Readonly<{ exitType: PaperExitType; closeReasonLabel: string }> {
  switch (closeReason) {
    case "EXIT_LONG_CRASH_FORCE":
      return { exitType: "EXIT_LONG_CRASH_FORCE", closeReasonLabel: defaultLabelForExitType("EXIT_LONG_CRASH_FORCE") };
    case "EXIT_LONG_CRASH_REDUCE":
      return { exitType: "EXIT_LONG_CRASH_REDUCE", closeReasonLabel: defaultLabelForExitType("EXIT_LONG_CRASH_REDUCE") };
    case "EXIT_SHORT_MOMENTUM_TRAIL":
      return { exitType: "EXIT_SHORT_MOMENTUM_TRAIL", closeReasonLabel: defaultLabelForExitType("EXIT_SHORT_MOMENTUM_TRAIL") };
    case "EXIT_CRASH_FORCE":
      return { exitType: "EXIT_CRASH_FORCE", closeReasonLabel: defaultLabelForExitType("EXIT_CRASH_FORCE") };
    case "EXIT_CRASH_REDUCE":
      return { exitType: "EXIT_CRASH_REDUCE", closeReasonLabel: defaultLabelForExitType("EXIT_CRASH_REDUCE") };
    case "candidate_lost":
      return { exitType: "EXIT_SIGNAL_LOST", closeReasonLabel: defaultLabelForExitType("EXIT_SIGNAL_LOST") };
    case "partial_exit_1":
      return { exitType: "EXIT_TP_1", closeReasonLabel: defaultLabelForExitType("EXIT_TP_1") };
    case "partial_exit_2":
      return { exitType: "EXIT_TP_2", closeReasonLabel: defaultLabelForExitType("EXIT_TP_2") };
    case "take_profit":
      return { exitType: "EXIT_TP", closeReasonLabel: defaultLabelForExitType("EXIT_TP") };
    case "stop_loss":
      return { exitType: "EXIT_SL", closeReasonLabel: defaultLabelForExitType("EXIT_SL") };
    case "trailing_stop":
      return { exitType: "EXIT_TRAILING", closeReasonLabel: defaultLabelForExitType("EXIT_TRAILING") };
    case "time_based_exit":
      return { exitType: "EXIT_TIME_STOP", closeReasonLabel: defaultLabelForExitType("EXIT_TIME_STOP") };
    case "trend_break_exit":
      return { exitType: "EXIT_REGIME_BREAK", closeReasonLabel: defaultLabelForExitType("EXIT_REGIME_BREAK") };
    case "regime_exit":
      return { exitType: "EXIT_REGIME", closeReasonLabel: defaultLabelForExitType("EXIT_REGIME") };
    case "range_box_break":
      return { exitType: "EXIT_RANGE_REBALANCE", closeReasonLabel: "박스 붕괴·구조 이탈" };
    case "range_profit_trail":
      return { exitType: "EXIT_TRAILING", closeReasonLabel: "수익권 되돌림 추종" };
    case "structural_regime_shift":
      return { exitType: "EXIT_REGIME_BREAK", closeReasonLabel: "구조적 추세 전환" };
    case "trend_switch":
      return { exitType: "EXIT_TREND_SWITCH", closeReasonLabel: defaultLabelForExitType("EXIT_TREND_SWITCH") };
    default: {
      const coerced = coerceCanonicalPaperCloseReason(closeReason);
      if (coerced !== closeReason) {
        return paperExitDisplayMeta(coerced as PaperClosedPositionRecord["closeReason"]);
      }
      const raw = typeof closeReason === "string" && closeReason.trim().length > 0 ? closeReason : "unknown";
      return { exitType: "EXIT_UNKNOWN", closeReasonLabel: `미분류 청산 (${raw})` };
    }
  }
}

/** 종료 행에 쓰는 진입 문맥 alias(저장 정합성). */
function closedHistoryContextAliases(open: PaperOpenPositionRecord): Readonly<{
  strategy?: PaperOpenPositionRecord["executorAtEntry"];
  regime?: PaperOpenPositionRecord["regimeAtEntry"];
  entryReason: string;
  authority?: string;
  authoritySide?: string;
}> {
  const authRaw =
    open.authoritySourceAtEntry ??
    (typeof open.authority === "string" && open.authority.trim().length > 0 ? open.authority : undefined);
  const sideRaw =
    open.authoritySideAtEntry ??
    (typeof open.authoritySide === "string" && open.authoritySide.trim().length > 0
      ? open.authoritySide
      : undefined);
  return {
    ...(open.executorAtEntry !== undefined ? { strategy: open.executorAtEntry } : {}),
    ...(open.regimeAtEntry !== undefined ? { regime: open.regimeAtEntry } : {}),
    entryReason: open.sourceSignal,
    ...(authRaw !== undefined ? { authority: authRaw } : {}),
    ...(sideRaw !== undefined ? { authoritySide: sideRaw } : {})
  };
}

type FinalizeClosedInput = Readonly<{
  open: PaperOpenPositionRecord;
  symbol: MarketSymbol;
  closePrice: number;
  closedAt: number;
  closeReason: PaperCloseReasonLike;
  /** 청산 레그의 마진(USD). 전량이면 열린 포지션 `sizeUsd`, 분할이면 해당 분할 마진. */
  legMarginUsd: number;
  metrics: PaperCloseLegMetrics;
  feeRate: number;
  fundingIntervalHours: number;
  strategyVersion: string;
  latestSnapshotPath?: string;
  latestMetaPath?: string;
  timestampSnapshotPath?: string;
  /** 스위칭·리밸런스 등 `closeReason` 맵 외 표준 코드 강제 시 사용. */
  exitTypeOverride?: PaperExitType;
  closeReasonLabelOverride?: string;
  closeSourceOverride?: PaperCloseSource;
}>;

/** 모든 종료·부분종료 레코드는 이 함수로 마감해 숫자 NaN → JSON null을 막고 exit 메타를 통일한다. */
export function finalizePaperClosedRecord(input: FinalizeClosedInput): PaperClosedPositionRecord {
  const m = input.metrics;
  const closeReasonNorm = coerceCanonicalPaperCloseReason(input.closeReason);
  const fromReason = paperExitDisplayMeta(closeReasonNorm);
  const eps = 1e-9;
  const netForTpGate = finiteUsd(m.pnlUsdNet);
  const pctForTpGate = finiteUsd(m.pnlPctNet);
  const partialTpSemanticsOk = netForTpGate > eps && pctForTpGate > eps;
  const isPartialStage =
    closeReasonNorm === "partial_exit_1" || closeReasonNorm === "partial_exit_2";

  let exitType = input.exitTypeOverride ?? fromReason.exitType;
  let neutralPartialLabel: string | null = null;
  if (isPartialStage && input.exitTypeOverride == null && !partialTpSemanticsOk) {
    exitType = closeReasonNorm === "partial_exit_1" ? "EXIT_PARTIAL_SPLIT_1" : "EXIT_PARTIAL_SPLIT_2";
    neutralPartialLabel = closeReasonNorm === "partial_exit_1" ? "1차 분할 청산" : "2차 분할 청산";
  }

  const closeReasonLabel =
    input.closeReasonLabelOverride ??
    neutralPartialLabel ??
    (input.exitTypeOverride != null ? defaultLabelForExitType(input.exitTypeOverride) : fromReason.closeReasonLabel);
  const closeSource =
    input.closeSourceOverride ??
    (neutralPartialLabel != null ? ("PARTIAL_SPLIT" as PaperCloseSource) : derivePaperCloseSource(closeReasonNorm, exitType));
  const outcomeStatus = outcomeStatusFromNetPnl(finiteUsd(m.pnlUsdNet));
  const sizeUsd = finiteUsd(input.legMarginUsd);
  const net = finiteUsd(m.pnlUsdNet);
  const gross = finiteUsd(m.pnlUsdGross);
  const pct = finiteUsd(m.pnlPctNet);
  const ctxAliases = closedHistoryContextAliases(input.open);
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
    ...(input.open.executorAtEntry !== undefined ? { executorAtEntry: input.open.executorAtEntry } : {}),
    regimeAtEntry: input.open.regimeAtEntry,
    ...(ctxAliases.strategy !== undefined ? { strategy: ctxAliases.strategy } : {}),
    ...(ctxAliases.regime !== undefined ? { regime: ctxAliases.regime } : {}),
    entryReason: ctxAliases.entryReason,
    ...(ctxAliases.authority !== undefined ? { authority: ctxAliases.authority } : {}),
    ...(ctxAliases.authoritySide !== undefined ? { authoritySide: ctxAliases.authoritySide } : {}),
    ...(input.open.rangeEntryBoxPos !== undefined ? { rangeEntryBoxPos: input.open.rangeEntryBoxPos } : {}),
    ...(input.open.rangeEntryZone !== undefined ? { rangeEntryZone: input.open.rangeEntryZone } : {}),
    ...(input.open.rangeEntryFromReversalSwitch === true ? { rangeEntryFromReversalSwitch: true } : {}),
    entryStageAtClose: input.open.entryStage ?? 1,
    ...(input.latestSnapshotPath ? { latestSnapshotPath: input.latestSnapshotPath } : {}),
    ...(input.latestMetaPath ? { latestMetaPath: input.latestMetaPath } : {}),
    ...(input.timestampSnapshotPath ? { timestampSnapshotPath: input.timestampSnapshotPath } : {}),
    closeReason: closeReasonNorm as PaperClosedPositionRecord["closeReason"],
    exitType,
    closeReasonLabel,
    exitReason: closeReasonLabel,
    closeSource,
    realizedPnlUsd: net,
    realizedPnlPct: pct,
    outcomeStatus
  };
}
