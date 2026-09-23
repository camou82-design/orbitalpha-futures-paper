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
const VALID_CANONICAL_SOURCE_LABELS = new Set([
  "자동",
  "수동",
  "자동→수동",
  "수동→자동"
]);

export function resolveDisplayTradeSourceLabel(row: unknown): string {
  if (!row || typeof row !== "object") return "수동";
  const o = row as Record<string, unknown>;

  const rawSourceLabel =
    typeof o.sourceLabel === "string" ? o.sourceLabel.trim() : "";
  if (VALID_CANONICAL_SOURCE_LABELS.has(rawSourceLabel)) {
    return rawSourceLabel;
  }
  if (rawSourceLabel === "외부포지션 인계") {
    return "수동→자동";
  }
  if (rawSourceLabel === "수동관리") {
    return "수동";
  }

  const str = (v: unknown): string =>
    typeof v === "string" ? v.trim().toUpperCase() : "";

  const authority = str(o.authority ?? o.authoritySourceAtEntry);
  const source = str(o.source ?? o.tradeSource);
  const strategy = str(o.strategy ?? o.executorAtEntry);
  const closeSource = str(o.closeSource);
  const closeReason = str(o.closeReason ?? o.exitReason);
  const entrySource = str(o.entrySource);
  const exitSource = str(o.exitSource);
  const exitType = str(o.exitType);

  // 1. ADOPTED_EXTERNAL (manual entry adopted by bot, or vice-versa)
  const isAdopted =
    o.isAdoptedExternal === true ||
    o.isAdopted === true ||
    authority.includes("ADOPTED") ||
    source.includes("ADOPTED") ||
    strategy.includes("ADOPTED") ||
    Boolean(o.adoptedFrom);

  // 2. OPERATOR_MANAGED
  const isOperatorManaged =
    o.isOperatorManaged === true ||
    authority.includes("OPERATOR") ||
    source.includes("OPERATOR") ||
    strategy.includes("OPERATOR");

  // 진입 주체 판별 (Entry: Bot vs Manual/Exchange)
  const isManualEntry =
    o.isManualEntry === true ||
    entrySource === "MANUAL" ||
    source === "MANUAL" ||
    source === "MANUAL_EXTERNAL" ||
    o.isManual === true ||
    strategy.includes("MANUAL") ||
    strategy.includes("EXTERNAL_DISCRETIONARY") ||
    authority === "MANUAL" ||
    authority === "OPERATOR";

  const isBotEntry =
    o.isBotEntry === true ||
    entrySource === "BOT" ||
    source === "V2" ||
    source === "BOT" ||
    source === "BOT_V2" ||
    strategy.includes("V2") ||
    strategy.includes("BOT") ||
    strategy.includes("HIGHWAY") ||
    Boolean(o.flowId);

  // 청산 주체 판별 (Exit: Bot vs Manual/Exchange)
  const isManualExit =
    o.isManualExit === true ||
    exitSource === "MANUAL" ||
    exitSource === "OPERATOR" ||
    exitType === "EXIT_MANUAL" ||
    closeSource.includes("MANUAL") ||
    closeSource.includes("OPERATOR") ||
    closeReason.includes("MANUAL") ||
    closeReason.includes("USER") ||
    closeReason.includes("OPERATOR") ||
    closeReason === "수동 청산";

  const isBotExit =
    o.isBotExit === true ||
    exitSource === "BOT" ||
    exitSource === "ENGINE" ||
    exitSource === "EXCHANGE_ALGO" ||
    exitType === "EXIT_V2_AUTHORITY" ||
    exitType === "EXIT_EXCHANGE_ALGO" ||
    exitType.includes("TP") ||
    exitType.includes("SL") ||
    exitType.includes("TRAILING") ||
    exitType.includes("REGIME") ||
    closeSource.includes("BOT") ||
    closeSource.includes("ENGINE") ||
    closeSource.includes("INTERNAL") ||
    closeReason.includes("TP") ||
    closeReason.includes("SL") ||
    closeReason.includes("TRAILING") ||
    closeReason.includes("REGIME") ||
    closeReason.includes("DYNAMIC") ||
    closeReason.includes("take_profit") ||
    closeReason.includes("stop_loss") ||
    closeReason.includes("candidate_lost") ||
    closeReason.includes("time_based");

  // 1. HYBRID cases (Highest Priority)
  if (isBotEntry && isManualExit) {
    return "자동→수동";
  }
  if (isManualEntry && isBotExit) {
    return "수동→자동";
  }

  // 2. Special adoption / operator cases
  if (isAdopted) {
    return isManualExit ? "자동→수동" : "수동→자동";
  }
  if (isOperatorManaged) {
    return isBotEntry ? "자동→수동" : "수동";
  }

  // 3. Pure cases
  if (isBotEntry && !isManualEntry && !isManualExit) {
    return "자동";
  }
  if (isManualEntry && !isBotEntry && !isBotExit) {
    return "수동";
  }

  // 4. Fallbacks
  if (isBotExit && !isManualEntry) {
    return "자동";
  }
  if (isManualExit && isBotEntry) {
    return "자동→수동";
  }
  if (isManualExit) {
    return "수동";
  }
  if (isBotEntry) {
    return "자동";
  }

  return "수동";
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

  const feeUsd = parseFinite(o.feeUsd) ?? parseFinite(o.fee) ?? 0;

  // Explicit PnL fields detection
  const explicitPnlNet =
    parseFinite(o.pnlUsdNet) ??
    parseFinite(o.pnlUsd) ??
    parseFinite(o.realizedPnlUsd) ??
    parseFinite(o.pnlNet) ??
    parseFinite(o.realizedPnl);

  const hasExplicitPnl = explicitPnlNet !== null;
  const pnlNet = explicitPnlNet ?? 0;

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

  const explicitPnlPct = parseFinite(o.realizedPnlPct);

  const realizedPnlPct =
    explicitPnlPct ??
    (hasExplicitPnl && sizeUsd > 0
      ? finiteUsd(pnlNet / sizeUsd)
      : (computedPnlPct ?? 0));

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
    finiteUsd(pnlNet + feeUsd + (parseFinite(o.fundingUsd) ?? 0));

  const sourceLabel = resolveDisplayTradeSourceLabel(raw);

  const base = raw && typeof raw === "object" ? { ...(raw as object) } : {};

  const record: NormalizedPaperClosedRow = Object.assign(base, {
    closedAt,
    entryPrice: entryPrice ?? (base as any).entryPrice ?? 0,
    closePrice,
    pnlUsd: finiteUsd(pnlNet),
    pnlUsdNet: finiteUsd(pnlNet),
    pnlUsdGross: pnlGross,
    feeUsd: finiteUsd(feeUsd),
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

  // 1. positionCycleId / flowId / lifecycleId / positionId
  const posCycleId = typeof o.positionCycleId === "string" && o.positionCycleId.trim().length > 0 ? o.positionCycleId.trim() : null;
  const flowId = typeof o.flowId === "string" && o.flowId.trim().length > 0 ? o.flowId.trim() : null;
  const lifecycleId = typeof o.lifecycleId === "string" && o.lifecycleId.trim().length > 0 ? o.lifecycleId.trim() : null;
  const positionId = typeof o.positionId === "string" && o.positionId.trim().length > 0 ? o.positionId.trim() : null;

  if (posCycleId) return `cycle:${posCycleId}`;
  if (flowId) return `flow:${flowId}`;
  if (lifecycleId) return `life:${lifecycleId}`;
  if (positionId) return `pos:${positionId}`;

  const sym = String(o.symbol ?? "").trim().toUpperCase();
  const side = String(o.side ?? "").trim().toLowerCase();

  // 4. exchange order ids if present together with symbol:side
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

  if (exPosId) return `ex_pos:${sym}:${side}:${exPosId}`;
  if (exOrdId && exitOrdId) return `ex_ords:${sym}:${side}:${exOrdId}:${exitOrdId}`;
  if (exClOrdId && exitOrdId) return `ex_clords:${sym}:${side}:${exClOrdId}:${exitOrdId}`;

  // 5. composite fallback: symbol + side + openedAt + closedAt (+ entryPx / exitPx / size)
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

  const results: NormalizedPaperClosedRow[] = [];

  for (const r of rows) {
    const key = canonicalClosedTradeDedupKey(r);
    const sym = String(r.symbol ?? "").trim().toUpperCase();
    const side = String(r.side ?? "").trim().toLowerCase();
    const openedAt = typeof r.openedAt === "number" && Number.isFinite(r.openedAt) ? r.openedAt : 0;
    const closedAt = typeof r.closedAt === "number" && Number.isFinite(r.closedAt) ? r.closedAt : 0;

    let matchIdx = -1;

    for (let i = 0; i < results.length; i++) {
      const existing = results[i];
      const existingKey = canonicalClosedTradeDedupKey(existing);

      // 1. Exact key match (if non-empty and non-trivial fallback)
      if (key && existingKey && key === existingKey && !key.startsWith("composite::::na:na:na:na:na")) {
        matchIdx = i;
        break;
      }

      // 2. Shared flowId match
      if (r.flowId && existing.flowId && r.flowId === existing.flowId) {
        matchIdx = i;
        break;
      }

      // 3. Shared positionCycleId match
      if (r.positionCycleId && existing.positionCycleId && r.positionCycleId === existing.positionCycleId) {
        matchIdx = i;
        break;
      }

      // 4. Shared exchange order IDs
      const rEntryOrds = Array.isArray(r.exchangeEntryOrdIds) ? r.exchangeEntryOrdIds : [];
      const exEntryOrds = Array.isArray(existing.exchangeEntryOrdIds) ? existing.exchangeEntryOrdIds : [];
      if (rEntryOrds.length > 0 && exEntryOrds.length > 0 && rEntryOrds.some((id) => exEntryOrds.includes(id))) {
        matchIdx = i;
        break;
      }

      // 4A. Shared exchange fill IDs (tradeId)
      const rFills = Array.isArray(r.exchangeFillIds) ? r.exchangeFillIds : [];
      const exFills = Array.isArray(existing.exchangeFillIds) ? existing.exchangeFillIds : [];
      if (rFills.length > 0 && exFills.length > 0 && rFills.some((id) => exFills.includes(id))) {
        matchIdx = i;
        break;
      }

      // 4B. Shared exchange exit order IDs
      const rExitOrds = Array.isArray(r.exchangeExitOrdIds) ? r.exchangeExitOrdIds : [];
      const exExitOrds = Array.isArray(existing.exchangeExitOrdIds) ? existing.exchangeExitOrdIds : [];
      if (rExitOrds.length > 0 && exExitOrds.length > 0 && rExitOrds.some((id) => exExitOrds.includes(id))) {
        matchIdx = i;
        break;
      }

      // 5. Tolerance match: same symbol, same side, within 2s of openedAt and closedAt,
      // provided they don't have conflicting explicit identities
      const rExOrd =
        typeof r.exchangeOrdId === "string" && r.exchangeOrdId.trim().length > 0
          ? r.exchangeOrdId.trim()
          : Array.isArray(r.exchangeEntryOrdIds) && r.exchangeEntryOrdIds.length > 0
            ? String(r.exchangeEntryOrdIds[0]).trim()
            : null;
      const exExOrd =
        typeof existing.exchangeOrdId === "string" && existing.exchangeOrdId.trim().length > 0
          ? existing.exchangeOrdId.trim()
          : Array.isArray(existing.exchangeEntryOrdIds) && existing.exchangeEntryOrdIds.length > 0
            ? String(existing.exchangeEntryOrdIds[0]).trim()
            : null;

      const rExitOrd =
        typeof r.exitOrdId === "string" && r.exitOrdId.trim().length > 0
          ? r.exitOrdId.trim()
          : Array.isArray(r.exchangeExitOrdIds) && r.exchangeExitOrdIds.length > 0
            ? String(r.exchangeExitOrdIds[0]).trim()
            : null;
      const exExitOrd =
        typeof existing.exitOrdId === "string" && existing.exitOrdId.trim().length > 0
          ? existing.exitOrdId.trim()
          : Array.isArray(existing.exchangeExitOrdIds) && existing.exchangeExitOrdIds.length > 0
            ? String(existing.exchangeExitOrdIds[0]).trim()
            : null;

      const hasConflictingIdentities =
        (rExOrd && exExOrd && rExOrd !== exExOrd) ||
        (rExitOrd && exExitOrd && rExitOrd !== exExitOrd) ||
        (r.flowId && existing.flowId && r.flowId !== existing.flowId) ||
        (r.positionCycleId && existing.positionCycleId && r.positionCycleId !== existing.positionCycleId);

      const exSym = String(existing.symbol ?? "").trim().toUpperCase();
      const exSide = String(existing.side ?? "").trim().toLowerCase();
      const exOpenedAt = typeof existing.openedAt === "number" && Number.isFinite(existing.openedAt) ? existing.openedAt : 0;
      const exClosedAt = typeof existing.closedAt === "number" && Number.isFinite(existing.closedAt) ? existing.closedAt : 0;

      if (
        !hasConflictingIdentities &&
        sym &&
        sym === exSym &&
        side &&
        side === exSide &&
        openedAt > 0 &&
        exOpenedAt > 0 &&
        closedAt > 0 &&
        exClosedAt > 0 &&
        Math.abs(openedAt - exOpenedAt) <= 2000 &&
        Math.abs(closedAt - exClosedAt) <= 2000
      ) {
        matchIdx = i;
        break;
      }
    }

    if (matchIdx >= 0) {
      const existing = results[matchIdx];
      const isRExchangeTruth = (r as any).accountTruth === true;
      const isExistingExchangeTruth = (existing as any).accountTruth === true;

      const base = isRExchangeTruth ? { ...existing, ...r } : { ...r, ...existing };

      // Strategy metadata from bot record (if present)
      const botObj = isRExchangeTruth ? existing : r;
      if (botObj.strategyVersion) (base as any).strategyVersion = botObj.strategyVersion;
      if (botObj.strategy) (base as any).strategy = botObj.strategy;
      if (botObj.sourceSignal) (base as any).sourceSignal = botObj.sourceSignal;
      if (botObj.regime) (base as any).regime = botObj.regime;
      if (botObj.regimeAtEntry) (base as any).regimeAtEntry = botObj.regimeAtEntry;
      if (botObj.flowId) (base as any).flowId = botObj.flowId;
      if (botObj.positionCycleId) (base as any).positionCycleId = botObj.positionCycleId;
      if (botObj.exitReason && botObj.exitReason !== "거래소 청산" && botObj.exitReason !== "수동 청산") {
        (base as any).exitReason = botObj.exitReason;
      }
      if (botObj.closeReason && botObj.closeReason !== "regime_exit") (base as any).closeReason = botObj.closeReason;
      if (botObj.exitType && botObj.exitType !== "EXIT_UNKNOWN") (base as any).exitType = botObj.exitType;
      if (botObj.tradeSource && botObj.tradeSource === "BOT_V2") (base as any).tradeSource = botObj.tradeSource;

      // Exchange execution numbers (if present)
      const exObj = isRExchangeTruth ? r : isExistingExchangeTruth ? existing : null;
      if (exObj) {
        const exFee = parseFinite(exObj.feeUsd) ?? parseFinite((exObj as any).fee);
        if (exFee !== null) (base as any).feeUsd = exFee;
        const exPnl =
          parseFinite(exObj.realizedPnlUsd) ??
          parseFinite(exObj.pnlUsdNet) ??
          parseFinite((exObj as any).pnlNet) ??
          parseFinite((exObj as any).realizedPnl);
        if (exPnl !== null) {
          (base as any).realizedPnlUsd = exPnl;
          (base as any).pnlUsdNet = exPnl;
          (base as any).pnlUsd = exPnl;
        }
        const exPnlGross = parseFinite(exObj.pnlUsdGross) ?? parseFinite((exObj as any).realizedPnl);
        if (exPnlGross !== null) (base as any).pnlUsdGross = exPnlGross;
        const exPnlPct = parseFinite(exObj.realizedPnlPct);
        if (exPnlPct !== null) (base as any).realizedPnlPct = exPnlPct;
        if (exObj.entryPrice && exObj.entryPrice > 0) (base as any).entryPrice = exObj.entryPrice;
        if (exObj.closePrice && exObj.closePrice > 0) (base as any).closePrice = exObj.closePrice;
        if (exObj.sizeUsd && exObj.sizeUsd > 0) (base as any).sizeUsd = exObj.sizeUsd;
        if (exObj.openedAt && exObj.openedAt > 0) (base as any).openedAt = exObj.openedAt;
        if (exObj.closedAt && exObj.closedAt > 0) (base as any).closedAt = exObj.closedAt;
      }

      // Partial exit / child execution consolidation
      if ((existing as any).isChildExecution === true || (r as any).isChildExecution === true) {
        (base as any).isChildExecution = false;
        (base as any).isPositionCycleFinal = true;
      }

      // Canonical sourceLabel
      (base as any).sourceLabel = resolveDisplayTradeSourceLabel(base);

      results[matchIdx] = base as NormalizedPaperClosedRow;
    } else {
      results.push(r);
    }
  }

  // Always sort descending by closedAt
  return results.sort((a, b) => (Number(b.closedAt) || 0) - (Number(a.closedAt) || 0));
}

export function normalizePositionsHistoryArray(rows: unknown[]): NormalizedPaperClosedRow[] {
  if (!Array.isArray(rows)) return [];
  const normalized = rows.map((r) => normalizeClosedHistoryRow(r));
  return deduplicateClosedHistoryRows(normalized);
}

export interface NormalizedOkxRawFill {
  tradeId: string;
  ordId: string;
  clOrdId?: string;
  instId: string;
  symbol: string;
  side: "buy" | "sell" | string;
  posSide?: string;
  fillSz: number;
  fillPx: number;
  fillTime: number;
  fillTimeKst: string;
  fillPnl?: number;
  fee?: number;
  feeCcy?: string;
  execType?: string;
  sourceLabel: "자동" | "수동";
  fillTypeLabel: "진입" | "추가진입" | "부분청산" | "청산완료";
  fillRole: "ENTRY" | "ADDON" | "PARTIAL_EXIT" | "FULL_EXIT";
}

function formatKstTime(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return "";
  const d = new Date(ts + 9 * 3600 * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} KST`;
}

export function normalizeOkxRawFills(fills: readonly any[]): NormalizedOkxRawFill[] {
  if (!Array.isArray(fills) || fills.length === 0) return [];

  // Deduplicate by tradeId or composite fill key
  const dedupMap = new Map<string, any>();
  for (const f of fills) {
    if (!f) continue;
    const tradeId = String(f.tradeId ?? "").trim();
    const key = tradeId.length > 0
      ? `tid:${tradeId}`
      : `cmp:${f.instId}:${f.ordId}:${f.fillTime}:${f.side}:${f.fillSz}:${f.fillPx}`;
    if (!dedupMap.has(key)) {
      dedupMap.set(key, f);
    }
  }

  // Group by symbol to track currentQty sequence for role classification
  const bySymbol = new Map<string, any[]>();
  for (const f of dedupMap.values()) {
    const instId = String(f.instId ?? "").trim().toUpperCase();
    const sym = instId.endsWith("-SWAP") ? instId.slice(0, -5).replace("-", "") : instId.replace("-", "");
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    bySymbol.get(sym)!.push(f);
  }

  const output: NormalizedOkxRawFill[] = [];
  const QTY_EPS = 1e-9;

  for (const [symbol, symFills] of bySymbol.entries()) {
    // Sort chronologically ascending
    const sorted = [...symFills].sort((a, b) => {
      const ta = Number(a.fillTime) || 0;
      const tb = Number(b.fillTime) || 0;
      if (ta !== tb) return ta - tb;
      return String(a.tradeId || a.ordId || "").localeCompare(String(b.tradeId || b.ordId || ""));
    });

    let currentQty = 0;

    for (const fill of sorted) {
      const fillSz = Number(fill.fillSz) || 0;
      const fillPx = Number(fill.fillPx) || 0;
      const fillTime = Number(fill.fillTime) || 0;
      const side = String(fill.side ?? "").trim().toLowerCase();
      const clOrdId = typeof fill.clOrdId === "string" ? fill.clOrdId.trim() : undefined;
      const ordId = String(fill.ordId ?? "").trim();
      const tradeId = String(fill.tradeId ?? "").trim();
      const instId = String(fill.instId ?? `${symbol}-USDT-SWAP`);
      const posSide = typeof fill.posSide === "string" ? fill.posSide.trim() : undefined;
      const fee = fill.fee !== undefined ? Number(fill.fee) : undefined;
      const feeCcy = typeof fill.feeCcy === "string" ? fill.feeCcy : undefined;
      const fillPnl = fill.fillPnl !== undefined && String(fill.fillPnl).trim() !== "" ? Number(fill.fillPnl) : undefined;
      const execType = typeof fill.execType === "string" ? fill.execType : undefined;

      // Detect auto (BOT_V2 / algo) vs manual
      const isBot =
        Boolean(clOrdId) &&
        (/^p[A-Z0-9_-]+/i.test(clOrdId!) ||
          /^slpos[A-Z0-9_-]+/i.test(clOrdId!) ||
          /^tppos[A-Z0-9_-]+/i.test(clOrdId!) ||
          /^v2[A-Z0-9_-]+/i.test(clOrdId!) ||
          /^O\d{10,}/.test(clOrdId!));
      const sourceLabel: "자동" | "수동" = isBot ? "자동" : "수동";

      let fillTypeLabel: "진입" | "추가진입" | "부분청산" | "청산완료" = "진입";
      let fillRole: "ENTRY" | "ADDON" | "PARTIAL_EXIT" | "FULL_EXIT" = "ENTRY";

      const fillSigned = side === "buy" ? fillSz : -fillSz;

      if (Math.abs(currentQty) <= QTY_EPS) {
        // Position was flat -> this is new entry
        fillTypeLabel = "진입";
        fillRole = "ENTRY";
        currentQty = fillSigned;
      } else if (Math.sign(currentQty) === Math.sign(fillSigned)) {
        // Adding in same direction -> addon
        fillTypeLabel = "추가진입";
        fillRole = "ADDON";
        currentQty += fillSigned;
      } else {
        // Opposite direction -> reducing
        const currentAbs = Math.abs(currentQty);
        if (currentAbs > fillSz + QTY_EPS) {
          // Partial reduction (e.g. TP1)
          fillTypeLabel = "부분청산";
          fillRole = "PARTIAL_EXIT";
          currentQty += fillSigned;
        } else if (Math.abs(currentAbs - fillSz) <= QTY_EPS) {
          // Full close
          fillTypeLabel = "청산완료";
          fillRole = "FULL_EXIT";
          currentQty = 0;
        } else {
          // Flip / Reversal
          fillTypeLabel = "청산완료";
          fillRole = "FULL_EXIT";
          currentQty = side === "buy" ? fillSz - currentAbs : -(fillSz - currentAbs);
        }
      }

      output.push({
        tradeId,
        ordId,
        clOrdId,
        instId,
        symbol,
        side,
        posSide,
        fillSz,
        fillPx,
        fillTime,
        fillTimeKst: formatKstTime(fillTime),
        fillPnl,
        fee,
        feeCcy,
        execType,
        sourceLabel,
        fillTypeLabel,
        fillRole
      });
    }
  }

  // Sort descending by fillTime for UI display
  return output.sort((a, b) => b.fillTime - a.fillTime);
}

export function filterTodayKstRawFills(
  fills: readonly NormalizedOkxRawFill[],
  referenceNowMs: number = Date.now()
): NormalizedOkxRawFill[] {
  // Start of KST Day: referenceNowMs + 9h, truncate to UTC midnight, then subtract 9h
  const kstOffset = 9 * 3600 * 1000;
  const kstDate = new Date(referenceNowMs + kstOffset);
  const kstMidnightUtc = Date.UTC(kstDate.getUTCFullYear(), kstDate.getUTCMonth(), kstDate.getUTCDate(), 0, 0, 0, 0);
  const kstStartMs = kstMidnightUtc - kstOffset;
  const kstEndMs = kstStartMs + 24 * 3600 * 1000;

  return fills.filter((f) => f.fillTime >= kstStartMs && f.fillTime < kstEndMs);
}

