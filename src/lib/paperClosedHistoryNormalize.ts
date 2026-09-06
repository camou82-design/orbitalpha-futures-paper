import type { PaperCloseSource, PaperClosedPositionRecord, PaperExitType } from "../models/types";
import {
  coerceCanonicalPaperCloseReason,
  defaultLabelForExitType,
  derivePaperCloseSource,
  finiteUsd,
  inferPaperCloseSourceFromExitType,
  outcomeStatusFromNetPnl,
  paperExitDisplayMeta
} from "../engine/paper-close-finalize";

const MISSING = "기록 없음";

const VALID_CLOSE_REASONS = new Set<string>([
  "candidate_lost",
  "take_profit",
  "stop_loss",
  "trailing_stop",
  "time_based_exit",
  "trend_break_exit",
  "regime_exit",
  "partial_exit_1",
  "partial_exit_2",
  "range_box_break",
  "range_profit_trail",
  "structural_regime_shift",
  "trend_switch",
  "EXIT_LONG_CRASH_FORCE",
  "EXIT_LONG_CRASH_REDUCE",
  "EXIT_SHORT_MOMENTUM_TRAIL",
  "EXIT_CRASH_FORCE",
  "EXIT_CRASH_REDUCE",
  "v2_exit_authority"
]);

const VALID_EXIT_TYPES = new Set<PaperExitType>([
  "EXIT_SL",
  "EXIT_TP",
  "EXIT_TP_1",
  "EXIT_TP_2",
  "EXIT_PARTIAL_SPLIT_1",
  "EXIT_PARTIAL_SPLIT_2",
  "EXIT_PARTIAL_TP",
  "EXIT_TRAILING",
  "EXIT_TIME_STOP",
  "EXIT_TREND_BREAK",
  "EXIT_REGIME",
  "EXIT_REGIME_BREAK",
  "EXIT_SIGNAL_LOST",
  "EXIT_RANGE_REBALANCE",
  "EXIT_TREND_SWITCH",
  "EXIT_RISK",
  "EXIT_LONG_CRASH_FORCE",
  "EXIT_LONG_CRASH_REDUCE",
  "EXIT_SHORT_MOMENTUM_TRAIL",
  "EXIT_CRASH_FORCE",
  "EXIT_CRASH_REDUCE",
  "EXIT_V2_AUTHORITY",
  "EXIT_UNKNOWN"
]);

function isLegacyHighwayEmaReason(x: unknown): boolean {
  if (typeof x !== "string") return false;
  const t = x.trim();
  return (
    t === "highway_ema60_break_long" ||
    t === "highway_ema60_break_short" ||
    t === "Highway 60 EMA Breakout (Short)" ||
    t === "Highway 60 EMA Breakdown (Long)" ||
    t === "Highway 60 EMA Breakout (Long)"
  );
}

function isPaperCloseReason(x: unknown): x is PaperClosedPositionRecord["closeReason"] {
  return typeof x === "string" && VALID_CLOSE_REASONS.has(x);
}

function parseFinite(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "") {
    const n = parseFloat(String(x).replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseExitType(x: unknown, fallback: PaperExitType): PaperExitType {
  if (typeof x === "string" && VALID_EXIT_TYPES.has(x as PaperExitType)) return x as PaperExitType;
  return fallback;
}

function resolveCloseReasonText(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const t = val.trim();
  if (t === "" || t === MISSING) return null;

  const coerced = coerceCanonicalPaperCloseReason(t as PaperClosedPositionRecord["closeReason"]);
  if (isPaperCloseReason(coerced)) {
    const meta = paperExitDisplayMeta(coerced);
    return meta.closeReasonLabel !== MISSING ? meta.closeReasonLabel : null;
  }
  return t;
}

/**
 * STEP 2: Canonical Display Source Label Resolver
 * BOT => "자동"
 * MANUAL / exchange-created => "수동"
 * ADOPTED_EXTERNAL => "외부포지션 인계"
 * OPERATOR_MANAGED => "수동관리"
 * HYBRID:
 * 자동 진입 + 수동 청산 => "자동→수동"
 * 수동 진입 + 봇 청산 => "수동→자동"
 * 판별 불가하나 OKX 실제 체결 증거 존재 => "거래소 체결"
 * UNKNOWN으로 숨기지 않는다.
 */
export function resolveDisplayTradeSourceLabel(row: unknown): string {
  if (!row || typeof row !== "object") return "거래소 체결";
  const o = row as Record<string, unknown>;

  const str = (v: unknown): string => (typeof v === "string" ? v.trim().toUpperCase() : "");

  const authority = str(o.authority ?? o.authoritySourceAtEntry);
  const source = str(o.source ?? o.tradeSource);
  const strategy = str(o.strategy ?? o.executorAtEntry);
  const closeSource = str(o.closeSource);
  const closeReason = str(o.closeReason ?? o.exitReason);
  const entrySource = str(o.entrySource);

  // 1. ADOPTED_EXTERNAL
  const isAdopted =
    authority.includes("ADOPTED") ||
    source.includes("ADOPTED") ||
    strategy.includes("ADOPTED") ||
    o.isAdopted === true ||
    Boolean(o.adoptedFrom);

  // 2. OPERATOR_MANAGED
  const isOperatorManaged =
    authority.includes("OPERATOR") ||
    source.includes("OPERATOR") ||
    strategy.includes("OPERATOR") ||
    closeReason.includes("OPERATOR") ||
    closeSource.includes("OPERATOR");

  // 진입 주체 판별 (Entry: Bot vs Manual/Exchange)
  const isManualEntry =
    source === "MANUAL" ||
    source === "MANUAL_EXTERNAL" ||
    entrySource === "MANUAL" ||
    o.isManual === true ||
    strategy.includes("MANUAL") ||
    strategy.includes("EXTERNAL_DISCRETIONARY") ||
    authority === "MANUAL" ||
    authority === "OPERATOR";

  const isBotEntry =
    source === "V2" ||
    source === "BOT" ||
    source === "BOT_V2" ||
    entrySource === "BOT" ||
    strategy.includes("V2") ||
    strategy.includes("BOT") ||
    strategy.includes("HIGHWAY") ||
    Boolean(o.flowId);

  // 청산 주체 판별 (Exit: Bot vs Manual/Exchange)
  const isManualExit =
    closeSource.includes("MANUAL") ||
    closeSource.includes("OPERATOR") ||
    closeReason.includes("MANUAL") ||
    closeReason.includes("USER") ||
    closeReason.includes("OPERATOR");

  const isBotExit =
    closeSource.includes("BOT") ||
    closeSource.includes("ENGINE") ||
    closeSource.includes("INTERNAL") ||
    closeReason.includes("TP") ||
    closeReason.includes("SL") ||
    closeReason.includes("TRAILING") ||
    closeReason.includes("REGIME") ||
    closeReason.includes("DYNAMIC");

  // HYBRID 체크 우선
  if (isBotEntry && isManualExit) {
    return "자동→수동";
  }
  if (isManualEntry && isBotExit) {
    return "수동→자동";
  }

  // 특수 분류
  if (isAdopted) {
    return "외부포지션 인계";
  }
  if (isOperatorManaged) {
    return "수동관리";
  }

  // 순수 자동 / 수동
  if (isBotEntry && !isManualEntry) {
    return "자동";
  }
  if (isManualEntry) {
    return "수동";
  }

  // fallback: closeSource나 exitReason 등에 수동 흔적이 있으면 "수동"
  if (isManualExit) {
    return "수동";
  }
  if (isBotExit) {
    return "자동";
  }

  // 판별 불가하나 거래 증거가 있는 경우 UNKNOWN 대신:
  return "거래소 체결";
}

/** 번들·UI용: 디스크 `history.json` 한 행을 항상 표시 가능한 형태로 보강한다. */
export type NormalizedPaperClosedRow = Readonly<
  PaperClosedPositionRecord & {
    realizedPnlUsd: number;
    realizedPnlPct: number;
    exitReason: string;
    closeSource: PaperCloseSource;
    outcomeStatus: "win" | "loss" | "flat";
    sourceLabel: string;
    exchangeOrdId?: string;
    exitOrdId?: string;
    exchangeEntryOrdIds?: string[];
    exchangeExitOrdIds?: string[];
    exchangeFillIds?: string[];
    lifecycleId?: string;
  }
>;

export function normalizeClosedHistoryRow(raw: unknown): NormalizedPaperClosedRow {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const pnlNet = parseFinite(o.pnlUsdNet) ?? parseFinite(o.pnlUsd) ?? parseFinite(o.realizedPnlUsd) ?? 0;
  const sizeUsd = finiteUsd(parseFinite(o.sizeUsd) ?? 0);
  const closedAt = parseFinite(o.closedAt) ?? 0;
  const entryPrice = parseFinite(o.entryPrice);
  const closePrice = parseFinite(o.closePrice) ?? parseFinite(o.exitPrice) ?? parseFinite(o.avgExitPrice) ?? 0;
  const leverage = parseFinite(o.leverage) ?? 1;
  const side = (typeof o.side === "string" ? o.side.toLowerCase() : "long") as "long" | "short";

  const crRaw = o.closeReason;
  const isLegacyHighwayReason = isLegacyHighwayEmaReason(crRaw);
  const crNorm = typeof crRaw === "string" ? coerceCanonicalPaperCloseReason(crRaw) : null;
  const meta =
    crNorm !== null && isPaperCloseReason(crNorm)
      ? paperExitDisplayMeta(crNorm)
      : { exitType: "EXIT_UNKNOWN" as PaperExitType, closeReasonLabel: MISSING };

  let exitType = parseExitType(o.exitType, meta.exitType);
  if (exitType === "EXIT_UNKNOWN" && crNorm !== null && isPaperCloseReason(crNorm) && meta.exitType !== "EXIT_UNKNOWN") {
    exitType = meta.exitType;
  }
  if (isLegacyHighwayReason && (exitType === "EXIT_REGIME_BREAK" || exitType === "EXIT_TREND_BREAK")) {
    exitType = "EXIT_UNKNOWN";
  }

  let computedPnlPct: number | null = null;
  if (entryPrice && entryPrice > 0 && closePrice && closePrice > 0) {
    const move = side === "long" ? (closePrice - entryPrice) / entryPrice : (entryPrice - closePrice) / entryPrice;
    computedPnlPct = move * leverage;
  }
  const realizedPnlPct =
    parseFinite(o.realizedPnlPct) ??
    (sizeUsd > 0 && Number.isFinite(pnlNet) ? finiteUsd(pnlNet / sizeUsd) : (computedPnlPct ?? 0));

  const rowEps = 1e-9;
  const isPartialCr = crNorm === "partial_exit_1" || crNorm === "partial_exit_2";
  const partialProfitable = pnlNet > rowEps && realizedPnlPct > rowEps;
  if (isPartialCr && !partialProfitable) {
    exitType = crNorm === "partial_exit_1" ? "EXIT_PARTIAL_SPLIT_1" : "EXIT_PARTIAL_SPLIT_2";
  }

  const resolvedCloseReasonCandidate = resolveCloseReasonText(crRaw);

  /**
   * 종료 사유 우선순위 (B):
   * closeReasonLabel > exitReason > resolveCloseReasonText(closeReason) > exitType > closeSource
   */
  let mappedReasonLabel = (() => {
    const vals = [
      o.closeReasonLabel,
      o.exitReason,
      resolvedCloseReasonCandidate,
      defaultLabelForExitType(exitType),
      o.closeSource
    ];
    for (const v of vals) {
      if (typeof v === "string" && v.trim().length > 0 && v !== MISSING) return v.trim();
    }
    return exitType === "EXIT_UNKNOWN" ? "종료 사유 미기록 (EXIT_UNKNOWN)" : defaultLabelForExitType(exitType);
  })();
  if (isLegacyHighwayReason) {
    mappedReasonLabel = "레거시 EMA60 종료";
  }
  if (isPartialCr && !partialProfitable) {
    mappedReasonLabel = crNorm === "partial_exit_1" ? "1차 분할 청산" : "2차 분할 청산";
  }

  const closeReasonLabel = mappedReasonLabel;
  const exitReason = mappedReasonLabel;

  let closeSource: PaperCloseSource =
    crNorm !== null && isPaperCloseReason(crNorm)
      ? derivePaperCloseSource(crNorm, exitType)
      : inferPaperCloseSourceFromExitType(exitType);
  if (isLegacyHighwayReason) {
    closeSource = "UNKNOWN";
  }
  if (closeSource === "UNKNOWN") {
    closeSource = inferPaperCloseSourceFromExitType(exitType);
  }

  const outcomeRaw = o.outcomeStatus;
  const outcomeStatus =
    outcomeRaw === "win" || outcomeRaw === "loss" || outcomeRaw === "flat"
      ? outcomeRaw
      : outcomeStatusFromNetPnl(pnlNet);

  const closeReasonForRecord: PaperClosedPositionRecord["closeReason"] =
    crNorm !== null && isPaperCloseReason(crNorm)
      ? (crNorm as PaperClosedPositionRecord["closeReason"])
      : typeof crRaw === "string" && crRaw.length > 0
        ? (crRaw as PaperClosedPositionRecord["closeReason"])
        : "regime_exit";

  const pnlGross =
    parseFinite(o.pnlUsdGross) ??
    finiteUsd(pnlNet + (parseFinite(o.feeUsd) ?? 0) + (parseFinite(o.fundingUsd) ?? 0));

  const sourceLabel = resolveDisplayTradeSourceLabel(raw);

  const base = raw && typeof raw === "object" ? { ...(raw as object) } : {};

  const record: NormalizedPaperClosedRow = Object.assign(base, {
    closedAt,
    entryPrice: entryPrice ?? (base as any).entryPrice ?? 0,
    closePrice,
    pnlUsd: finiteUsd(pnlNet),
    pnlUsdNet: finiteUsd(pnlNet),
    pnlUsdGross: pnlGross,
    sizeUsd,
    closeReason: closeReasonForRecord,
    exitType,
    closeReasonLabel,
    exitReason,
    closeSource,
    realizedPnlUsd: finiteUsd(pnlNet),
    realizedPnlPct,
    outcomeStatus,
    sourceLabel
  }) as NormalizedPaperClosedRow;

  // Proof Log (D)
  console.log("EXIT_HISTORY_MAPPING_PROOF", {
    symbol: String(o.symbol ?? "UNKNOWN"),
    closed_at: closedAt,
    raw_close_reason_label: o.closeReasonLabel ?? null,
    raw_exit_reason: o.exitReason ?? null,
    raw_close_reason: crRaw ?? null,
    resolved_close_reason_candidate: resolvedCloseReasonCandidate,
    raw_exit_type: o.exitType ?? null,
    raw_close_source: o.closeSource ?? null,
    mapped_exit_reason_label: mappedReasonLabel,
    raw_close_price: o.closePrice ?? null,
    mapped_close_price: closePrice,
    raw_realized_pnl_pct: o.realizedPnlPct ?? null,
    computed_realized_pnl_pct: computedPnlPct,
    mapped_realized_pnl_pct: realizedPnlPct,
    mapping_fallback_used: (closePrice === 0 && (o.closePrice == null)) || exitType === "EXIT_UNKNOWN",
    source_label: sourceLabel
  });

  /** raw에 이미 있으면 유지; 없을 때만 동일 의미 필드로 보강(덮어쓰기 금지). */
  const enriched = record as Record<string, unknown>;
  if (enriched.sourceLabel === undefined) {
    enriched.sourceLabel = sourceLabel;
  }
  if (enriched.strategy === undefined && typeof o.executorAtEntry === "string") {
    enriched.strategy = o.executorAtEntry;
  }
  if (enriched.regime === undefined && typeof o.regimeAtEntry === "string") {
    enriched.regime = o.regimeAtEntry;
  }
  if (
    enriched.entryReason === undefined &&
    typeof o.sourceSignal === "string" &&
    o.sourceSignal.trim().length > 0
  ) {
    enriched.entryReason = o.sourceSignal;
  }
  if (enriched.authority === undefined) {
    const auth =
      typeof o.authoritySourceAtEntry === "string" && String(o.authoritySourceAtEntry).trim().length > 0
        ? o.authoritySourceAtEntry
        : typeof o.authority === "string" && String(o.authority).trim().length > 0
          ? o.authority
          : undefined;
    if (auth !== undefined) enriched.authority = auth;
  }
  if (enriched.authoritySide === undefined) {
    const asd =
      typeof o.authoritySideAtEntry === "string" && String(o.authoritySideAtEntry).trim().length > 0
        ? o.authoritySideAtEntry
        : typeof o.authoritySide === "string" && String(o.authoritySide).trim().length > 0
          ? o.authoritySide
          : undefined;
    if (asd !== undefined) enriched.authoritySide = asd;
  }
  if (enriched.executorAtEntry === undefined && typeof o.executorAtEntry === "string") {
    enriched.executorAtEntry = o.executorAtEntry;
  }

  return enriched as NormalizedPaperClosedRow;
}

export type ClosedRowDisplayFields = Readonly<{
  exitType: string;
  exitReason: string;
  status: string;
  closeSource: string;
  closePriceLabel: string;
  pnlPctLabel: string;
  sourceLabel: string;
}>;

/** UI: "해당 없음" 대신 우선순위 fallback — 모두 비면 `기록 없음`. */
export function displayFieldsForClosedRow(row: unknown): ClosedRowDisplayFields {
  const o = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;

  // 만약 normalize를 거친 record라면 이미 강화된 필드들이 있을 것임.
  const nz = (...vals: unknown[]): string => {
    for (const x of vals) {
      if (typeof x === "string" && x.trim().length > 0 && x !== MISSING) return x.trim();
    }
    return MISSING;
  };

  const et = parseExitType(o.exitType, "EXIT_UNKNOWN");

  /** 우선순위 (C): exitReason > closeReasonLabel > resolveCloseReasonText(closeReason) > fallback */
  const exitReason = nz(
    o.exitReason,
    o.closeReasonLabel,
    resolveCloseReasonText(o.closeReason),
    et === "EXIT_UNKNOWN" ? "종료 사유 미기록 (EXIT_UNKNOWN)" : defaultLabelForExitType(et)
  );

  const st = o.outcomeStatus;
  const status =
    st === "win"
      ? "익"
      : st === "loss"
        ? "손"
        : st === "flat"
          ? "보합"
          : nz(
            o.positionStatus,
            (o as any).status
          );

  const closeSource = nz(
    o.closeSource,
    inferPaperCloseSourceFromExitType(et),
    "UNKNOWN"
  );

  const cp = parseFinite(o.closePrice);
  const closePriceLabel = cp !== null && cp > 0 ? cp.toLocaleString() : MISSING;

  const pct = parseFinite(o.realizedPnlPct);
  const pnlPctLabel = pct !== null ? `${(pct * 100).toFixed(2)}%` : MISSING;

  const sourceLabel =
    typeof o.sourceLabel === "string" && o.sourceLabel.trim().length > 0
      ? o.sourceLabel.trim()
      : resolveDisplayTradeSourceLabel(row);

  return {
    exitType: exitReason, // UI에서 exitType 자리에 reason을 표시하는 경우가 많음
    exitReason,
    status,
    closeSource,
    closePriceLabel,
    pnlPctLabel,
    sourceLabel
  };
}


/**
 * PHASE 13A: Canonical Closed Trade Dedup Key Resolver
 *
 * CLOSED TRADE 규칙:
 * 1. exchange position/order/lifecycle identity
 * 2. canonical flowId / positionId / lifecycleId / positionCycleId
 * 3. exchange entry/exit order ids
 * 4. identity가 없을 때만 composite fallback (symbol + side + openedAt + closedAt + entry/exit px + size)
 *
 * ※ symbol:side 만으로 청산 거래를 dedup하는 것은 절대 금지.
 * 서로 다른 시각(openedAt/closedAt)에 발생한 동일 종목/방향 거래는 반드시 별도 거래로 보존.
 */
export function canonicalClosedTradeDedupKey(row: unknown): string {
  if (!row || typeof row !== "object") return "";
  const o = row as Record<string, unknown>;

  // 1. exchange position/order/lifecycle identity
  const exPosId = typeof o.exchangePosId === "string" && o.exchangePosId.trim().length > 0 ? o.exchangePosId.trim() : null;
  const exOrdId =
    typeof o.exchangeOrdId === "string" && o.exchangeOrdId.trim().length > 0
      ? o.exchangeOrdId.trim()
      : Array.isArray(o.exchangeEntryOrdIds) && o.exchangeEntryOrdIds.length > 0
        ? String(o.exchangeEntryOrdIds[0]).trim()
        : null;
  const exitOrdId =
    typeof o.exitOrdId === "string" && o.exitOrdId.trim().length > 0
      ? o.exitOrdId.trim()
      : Array.isArray(o.exchangeExitOrdIds) && o.exchangeExitOrdIds.length > 0
        ? String(o.exchangeExitOrdIds[0]).trim()
        : null;
  const exClOrdId = typeof o.exchangeClOrdId === "string" && o.exchangeClOrdId.trim().length > 0 ? o.exchangeClOrdId.trim() : null;

  // 2. canonical flowId / positionId / lifecycleId / positionCycleId
  const posCycleId = typeof o.positionCycleId === "string" && o.positionCycleId.trim().length > 0 ? o.positionCycleId.trim() : null;
  const positionId = typeof o.positionId === "string" && o.positionId.trim().length > 0 ? o.positionId.trim() : null;
  const lifecycleId = typeof o.lifecycleId === "string" && o.lifecycleId.trim().length > 0 ? o.lifecycleId.trim() : null;
  const flowId = typeof o.flowId === "string" && o.flowId.trim().length > 0 ? o.flowId.trim() : null;

  if (posCycleId) return `cycle:${posCycleId}`;
  if (positionId) return `pos:${positionId}`;
  if (lifecycleId) return `life:${lifecycleId}`;
  if (flowId) return `flow:${flowId}`;

  const sym = String(o.symbol ?? "").trim().toUpperCase();
  const side = String(o.side ?? "").trim().toLowerCase();

  // 3. exchange order ids if present together with symbol:side
  if (exPosId) return `ex_pos:${sym}:${side}:${exPosId}`;
  if (exOrdId && exitOrdId) return `ex_ords:${sym}:${side}:${exOrdId}:${exitOrdId}`;
  if (exClOrdId && exitOrdId) return `ex_clords:${sym}:${side}:${exClOrdId}:${exitOrdId}`;

  // 4. composite fallback: symbol + side + openedAt + closedAt (+ entryPx / exitPx / size)
  const openedAt = typeof o.openedAt === "number" && Number.isFinite(o.openedAt) && o.openedAt > 0 ? Math.round(o.openedAt / 1000) : "na";
  const closedAt = typeof o.closedAt === "number" && Number.isFinite(o.closedAt) && o.closedAt > 0 ? Math.round(o.closedAt / 1000) : "na";
  const entryPx = typeof o.entryPrice === "number" && Number.isFinite(o.entryPrice) && o.entryPrice > 0 ? Number(o.entryPrice).toFixed(2) : "na";
  const exitPx =
    typeof o.closePrice === "number" && Number.isFinite(o.closePrice) && o.closePrice > 0
      ? Number(o.closePrice).toFixed(2)
      : typeof o.exitPrice === "number" && Number.isFinite(o.exitPrice) && o.exitPrice > 0
        ? Number(o.exitPrice).toFixed(2)
        : "na";
  const size = typeof o.sizeUsd === "number" && Number.isFinite(o.sizeUsd) && o.sizeUsd > 0 ? Math.round(o.sizeUsd) : "na";

  return `composite:${sym}:${side}:${openedAt}:${closedAt}:${entryPx}:${exitPx}:${size}`;
}

export function deduplicateClosedHistoryRows(rows: NormalizedPaperClosedRow[]): NormalizedPaperClosedRow[] {
  if (!Array.isArray(rows) || rows.length <= 1) return rows;

  const dedupMap = new Map<string, NormalizedPaperClosedRow>();
  const results: NormalizedPaperClosedRow[] = [];

  for (const r of rows) {
    const key = canonicalClosedTradeDedupKey(r);
    // If no meaningful key could be derived, preserve as-is
    if (!key || key.startsWith("composite::::na:na:na:na:na")) {
      results.push(r);
      continue;
    }

    const existing = dedupMap.get(key);
    if (!existing) {
      dedupMap.set(key, r);
      results.push(r);
    } else {
      // Merge multiple representations of the exact same trade:
      // Preserve richer strategy metadata from bot record and actual execution truth from exchange record
      const isRExchangeTruth = (r as any).accountTruth === true;
      const isExistingExchangeTruth = (existing as any).accountTruth === true;

      const base = isRExchangeTruth ? { ...existing, ...r } : { ...r, ...existing };

      // Strategy metadata from bot record (if present)
      const botObj = isRExchangeTruth ? existing : r;
      if (botObj.strategyVersion) base.strategyVersion = botObj.strategyVersion;
      if (botObj.strategy) base.strategy = botObj.strategy;
      if (botObj.sourceSignal) base.sourceSignal = botObj.sourceSignal;
      if (botObj.regime) base.regime = botObj.regime;
      if (botObj.regimeAtEntry) base.regimeAtEntry = botObj.regimeAtEntry;
      if (botObj.flowId) base.flowId = botObj.flowId;
      if (botObj.positionCycleId) base.positionCycleId = botObj.positionCycleId;
      if (botObj.exitReason && botObj.exitReason !== "거래소 청산") base.exitReason = botObj.exitReason;
      if (botObj.sourceLabel && botObj.sourceLabel !== "거래소 체결") base.sourceLabel = botObj.sourceLabel;
      if (botObj.tradeSource && botObj.tradeSource === "BOT_V2") base.tradeSource = botObj.tradeSource;

      // Exchange execution numbers (if present)
      const exObj = isRExchangeTruth ? r : isExistingExchangeTruth ? existing : null;
      if (exObj) {
        if (typeof exObj.feeUsd === "number") base.feeUsd = exObj.feeUsd;
        if (typeof exObj.realizedPnlUsd === "number") base.realizedPnlUsd = exObj.realizedPnlUsd;
        if (typeof exObj.realizedPnlPct === "number") base.realizedPnlPct = exObj.realizedPnlPct;
      }

      dedupMap.set(key, base as NormalizedPaperClosedRow);
      const idx = results.indexOf(existing);
      if (idx >= 0) results[idx] = base as NormalizedPaperClosedRow;
    }
  }

  return results;
}

export function normalizePositionsHistoryArray(rows: unknown[]): NormalizedPaperClosedRow[] {
  if (!Array.isArray(rows)) return [];
  const normalized = rows.map((r) => normalizeClosedHistoryRow(r));
  return deduplicateClosedHistoryRows(normalized);
}
