import type { MarketRegime } from "../strategy/market-regime-detector";
import { stopLossPctForRegime, takeProfitPctForRegime } from "../strategy/regime-exit";
import type { PaperOpenPositionRecord } from "../models/types";
import {
  buildLedgerOkxPositionSyncSnapshot,
  okxSwapRowToLedgerKey,
  type InstrumentSizing,
  type LedgerOkxPositionSyncSnapshot
} from "../exchange/okx-position-sync";

export type PositionOpsBanner =
  | "NO_POSITION"
  | "REMOTE_UNAVAILABLE"
  | "RECONCILE_MISMATCH"
  | "MONITORING_NO_PROTECT_WARNING"
  | "MONITORING_RISK_PLAN_MISSING_WARNING"
  | "MONITORING_PROTECT_DETECTED"
  | "MONITORING_SCAN_PENDING";

export type PositionOpsRow = Readonly<{
  symbol: string;
  side: "long" | "short";
  inst_id: string;
  okx_avg_px: number | null;
  reference_entry_px: number | null;
  reference_source: "paper_ledger" | "okx_avgPx" | "none";
  regime_for_sl: MarketRegime;
  policy_sl_net_frac: number;
  initial_stop_px_engine_mirror: number | null;
  initial_tp_px_engine_mirror: number | null;
  ledger_stop_px: number | null;
  exchange_stop_px: number | null;
  stop_px_source: "engine_calculated" | "ledger_stored" | "exchange_order" | "none";
  ledger_tp_px: number | null;
  exchange_tp_px: number | null;
  tp_px_source: "engine_calculated" | "ledger_stored" | "exchange_order" | "none";
  /** OKX SWAP `pos` (signed contracts) for this row; nonzero means live exposure. */
  okx_pos_signed: number;
  /** Reduce-only protective algo/pending rows for this instId + posSide (diagnostics). */
  matching_protective_pending_count: number;
  /** Engine expects a TP leg on the exchange (ledger or mirrored policy TP). */
  tp_required_for_exchange_protection: boolean;
  reduce_only_protective_found: boolean;
  protective_match_hints: string[];
  reconcile_state: string;
  sync_status: LedgerOkxPositionSyncSnapshot["sync_status"] | "OKX_GHOST";
  can_adopt: boolean;
}>;

export type PositionOpsSurface = Readonly<{
  generated_at: number;
  orders_scan_performed: boolean;
  orders_scan_errors: string[];
  reconcile_sync_status: LedgerOkxPositionSyncSnapshot["sync_status"];
  surface_banner: PositionOpsBanner;
  surface_banner_ko: string;
  rows: PositionOpsRow[];
}>;

function toFinite(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function regimeForSl(raw: unknown): MarketRegime {
  return raw === "RANGE" || raw === "TREND" || raw === "NO_TRADE" ? raw : "NO_TRADE";
}

export function engineMirrorStopPrice(entryPx: number, side: "long" | "short", regime: MarketRegime): number | null {
  if (!(entryPx > 0)) return null;
  const slPct = stopLossPctForRegime(regime);
  return side === "long" ? entryPx * (1 + slPct) : entryPx * (1 - slPct);
}

export function engineMirrorTpPrice(entryPx: number, side: "long" | "short", regime: MarketRegime): number | null {
  if (!(entryPx > 0)) return null;
  const tpPct = takeProfitPctForRegime(regime);
  return side === "long" ? entryPx * (1 + tpPct) : entryPx * (1 - tpPct);
}

function instIdMatchesRow(instId: string, rowInst: string): boolean {
  return String(rowInst) === instId;
}

function stringifyHints(o: Record<string, unknown>): string {
  const id = o.algoId ?? o.ordId ?? "?";
  const typ = o.ordType ?? o.orderType ?? "?";
  const ro = o.reduceOnly;
  const trig = o.slTriggerPx ?? o.tpTriggerPx ?? o.triggerPx ?? o.stopPx ?? o.trigPx ?? "";
  return `${String(id)}|${String(typ)}|ro=${String(ro)}|tr=${String(trig)}`;
}

export function orderLooksReduceOnlyProtective(o: Record<string, unknown>): boolean {
  const ro = o.reduceOnly;
  const roOk = ro === true || String(ro).toLowerCase() === "true";
  if (!roOk) return false;
  const typ = String(o.ordType ?? o.orderType ?? "").toLowerCase();
  if (
    typ.includes("conditional") ||
    typ === "trigger" ||
    typ === "stop" ||
    typ.includes("oco") ||
    typ.includes("move_order_stop")
  ) {
    return true;
  }
  if (
    o.slTriggerPx != null ||
    o.tpTriggerPx != null ||
    o.triggerPx != null ||
    o.stopPx != null ||
    o.trigPx != null
  ) {
    return true;
  }
  return false;
}

export type OkxOpenOrderPurpose =
  | "protective-stop"
  | "protective-take-profit"
  | "bot-managed-protection"
  | "protective-purpose"
  | "manual-reduce-purpose"
  | "entry-purpose"
  | "manual-entry-purpose"
  | "unknown";

export type OkxOpenOrderPurposeClassifyResult = Readonly<{
  purpose: OkxOpenOrderPurpose;
  matchedProtectiveAlgo:
    | "sl"
    | "tp"
    | "stop"
    | "breakeven"
    | "algo_clord"
    | "reduce_only_protective_shape"
    | null;
  manualReduceDetected: boolean;
  isBotManagedProtection: boolean;
}>;

const TERMINAL_OKX_ORDER_STATES = new Set(["filled", "canceled", "cancelled", "rejected", "expired"]);

function orderReduceOnly(o: Record<string, unknown>): boolean {
  return o.reduceOnly === true || String(o.reduceOnly).toLowerCase() === "true";
}

function orderAlgoId(o: Record<string, unknown>): string {
  const id = o.algoId ?? o.ordId ?? "";
  return id != null && String(id).length > 0 ? String(id) : "";
}

function ledgerMatchesOrderSide(
  ledger: PaperOpenPositionRecord,
  positionSide: "long" | "short",
  instId: string
): boolean {
  const ps = String(ledger.side).toLowerCase() === "short" ? "short" : "long";
  if (ps !== positionSide) return false;
  const ledgerInst = String(ledger.instId ?? "").trim();
  if (ledgerInst.length > 0 && ledgerInst !== instId) return false;
  return (ledger.status ?? "open") === "open";
}

function findLedgerForOrder(
  opens: readonly PaperOpenPositionRecord[],
  instId: string,
  positionSide: "long" | "short"
): PaperOpenPositionRecord | null {
  for (const p of opens) {
    if (ledgerMatchesOrderSide(p, positionSide, instId)) return p;
  }
  return null;
}

function resolvePositionSideFromOrder(o: Record<string, unknown>): "long" | "short" | null {
  const ps = String(o.posSide ?? "").trim().toLowerCase();
  if (ps === "long" || ps === "short") return ps;
  return null;
}

export function isBotManagedProtectivePurpose(purpose: OkxOpenOrderPurpose): boolean {
  return (
    purpose === "protective-stop" ||
    purpose === "protective-take-profit" ||
    purpose === "bot-managed-protection" ||
    purpose === "protective-purpose"
  );
}

export function classifyOkxOpenOrderPurpose(
  ord: Record<string, unknown>,
  ledgerPos?: PaperOpenPositionRecord | null
): OkxOpenOrderPurposeClassifyResult {
  const isReduceOnly = orderReduceOnly(ord);
  const clOrdId = ord.clOrdId != null ? String(ord.clOrdId) : "";
  const algoClOrdId = ord.algoClOrdId != null ? String(ord.algoClOrdId) : "";
  const hasEngineClOrdId = clOrdId.length > 0;
  const hasEngineAlgoClOrdId = algoClOrdId.startsWith("oap");
  const algoId = orderAlgoId(ord);

  const botManagedBase = (
    purpose: OkxOpenOrderPurpose,
    matchedProtectiveAlgo: OkxOpenOrderPurposeClassifyResult["matchedProtectiveAlgo"]
  ): OkxOpenOrderPurposeClassifyResult => ({
    purpose,
    matchedProtectiveAlgo,
    manualReduceDetected: false,
    isBotManagedProtection: true
  });

  if (isReduceOnly && ledgerPos && algoId.length > 0) {
    if (ledgerPos.protectiveSlAlgoId && algoId === String(ledgerPos.protectiveSlAlgoId)) {
      return botManagedBase("protective-stop", "sl");
    }
    if (ledgerPos.protectiveTpAlgoId && algoId === String(ledgerPos.protectiveTpAlgoId)) {
      return botManagedBase("protective-take-profit", "tp");
    }
    if (ledgerPos.protectiveStopAlgoId && algoId === String(ledgerPos.protectiveStopAlgoId)) {
      return botManagedBase("protective-stop", "stop");
    }
    if (ledgerPos.breakevenStopAlgoId && algoId === String(ledgerPos.breakevenStopAlgoId)) {
      return botManagedBase("protective-stop", "breakeven");
    }
  }

  if (isReduceOnly && orderLooksReduceOnlyProtective(ord)) {
    const tpPx = ord.tpTriggerPx;
    const hasTp = tpPx != null && String(tpPx).length > 0 && Number(tpPx) > 0;
    const slPx = ord.slTriggerPx ?? ord.triggerPx ?? ord.stopPx ?? ord.trigPx;
    const hasSl = slPx != null && String(slPx).length > 0 && Number(slPx) > 0;
    if (hasTp && !hasSl) {
      return botManagedBase("protective-take-profit", "reduce_only_protective_shape");
    }
    return botManagedBase("protective-stop", "reduce_only_protective_shape");
  }

  if (isReduceOnly && hasEngineAlgoClOrdId) {
    return botManagedBase("bot-managed-protection", "algo_clord");
  }

  if (!isReduceOnly && hasEngineClOrdId) {
    return {
      purpose: "entry-purpose",
      matchedProtectiveAlgo: null,
      manualReduceDetected: false,
      isBotManagedProtection: false
    };
  }

  if (isReduceOnly && hasEngineClOrdId) {
    return botManagedBase("protective-purpose", null);
  }

  if (isReduceOnly) {
    return {
      purpose: "manual-reduce-purpose",
      matchedProtectiveAlgo: null,
      manualReduceDetected: true,
      isBotManagedProtection: false
    };
  }

  if (!isReduceOnly && !hasEngineClOrdId) {
    return {
      purpose: "manual-entry-purpose",
      matchedProtectiveAlgo: null,
      manualReduceDetected: false,
      isBotManagedProtection: false
    };
  }

  return {
    purpose: "unknown",
    matchedProtectiveAlgo: null,
    manualReduceDetected: false,
    isBotManagedProtection: false
  };
}

export function countBlockingOkxOpenOrders(
  pending: readonly Record<string, unknown>[],
  algos: readonly Record<string, unknown>[],
  opens: readonly PaperOpenPositionRecord[]
): Readonly<{
  blockingPendingCount: number;
  blockingAlgosCount: number;
  botManagedProtectiveCount: number;
}> {
  let blockingPendingCount = 0;
  let blockingAlgosCount = 0;
  let botManagedProtectiveCount = 0;

  const classifyWithLedger = (ord: Record<string, unknown>): OkxOpenOrderPurposeClassifyResult => {
    const instId = String(ord.instId ?? "");
    const positionSide = resolvePositionSideFromOrder(ord);
    const ledger =
      positionSide != null && instId.length > 0
        ? findLedgerForOrder(opens, instId, positionSide)
        : null;
    return classifyOkxOpenOrderPurpose(ord, ledger);
  };

  for (const ord of pending) {
    const result = classifyWithLedger(ord);
    if (result.isBotManagedProtection) {
      botManagedProtectiveCount += 1;
      continue;
    }
    blockingPendingCount += 1;
  }

  for (const ord of algos) {
    const result = classifyWithLedger(ord);
    if (result.isBotManagedProtection) {
      botManagedProtectiveCount += 1;
      continue;
    }
    blockingAlgosCount += 1;
  }

  return { blockingPendingCount, blockingAlgosCount, botManagedProtectiveCount };
}

export function evaluateV2ReducePendingGuard(input: Readonly<{
  open: PaperOpenPositionRecord;
  flowId: string;
  instId: string;
  pendingSwapOrders: readonly Record<string, unknown>[];
}>): Readonly<{
  pending: boolean;
  submitAllowed: boolean;
  terminalState: string | null;
}> {
  const { open, instId, pendingSwapOrders } = input;

  const ledgerPartialPending =
    open.lifecycleState === "PARTIAL_PENDING" ||
    (typeof open.partialPendingOrdId === "string" && open.partialPendingOrdId.length > 0) ||
    (typeof open.partialPendingClOrdId === "string" && open.partialPendingClOrdId.length > 0) ||
    (typeof open.partialPendingContracts === "number" &&
      Number.isFinite(open.partialPendingContracts) &&
      open.partialPendingContracts > 0);

  let okxReducePending = false;
  let terminalState: string | null = null;

  for (const ord of pendingSwapOrders) {
    if (String(ord.instId ?? "") !== instId) continue;
    if (!orderMatchesPositionSide(ord, open.side)) continue;
    if (!orderReduceOnly(ord)) continue;

    const ordState = String(ord.state ?? ord.status ?? "").toLowerCase();
    if (ordState.length > 0 && TERMINAL_OKX_ORDER_STATES.has(ordState)) {
      if (
        (open.partialPendingOrdId && String(ord.ordId ?? "") === open.partialPendingOrdId) ||
        (open.partialPendingClOrdId && String(ord.clOrdId ?? "") === open.partialPendingClOrdId)
      ) {
        terminalState = ordState;
      }
      continue;
    }

    const clOrdId = String(ord.clOrdId ?? "");
    const ordId = String(ord.ordId ?? "");
    const matchesPendingIds =
      (open.partialPendingOrdId && ordId === open.partialPendingOrdId) ||
      (open.partialPendingClOrdId && clOrdId === open.partialPendingClOrdId);
    const engineOwnedReduce = clOrdId.startsWith("oap");
    const classify = classifyOkxOpenOrderPurpose(ord, open);

    if (matchesPendingIds || (engineOwnedReduce && !classify.isBotManagedProtection)) {
      okxReducePending = true;
      break;
    }
  }

  const pending = ledgerPartialPending || okxReducePending;
  const submitAllowed = !pending;

  if (pending) {
    terminalState = null;
  } else if (terminalState == null && open.lifecycleState === "OPEN") {
    terminalState = "cleared";
  }

  return { pending, submitAllowed, terminalState };
}

function orderMatchesPositionSide(o: Record<string, unknown>, positionSide: "long" | "short"): boolean {
  const ps = String(o.posSide ?? "").trim().toLowerCase();
  if (!ps || ps === "net") return true;
  return ps === positionSide;
}

export function findProtectiveHintsForInst(
  instId: string,
  positionSide: "long" | "short",
  pending: readonly Record<string, unknown>[],
  algos: readonly Record<string, unknown>[],
  tpRequired: boolean
): {
  protectionSatisfied: boolean;
  hints: string[];
  slPrice: number | null;
  tpPrice: number | null;
  matchingProtectiveOrderCount: number;
} {
  const hints: string[] = [];
  let foundSlPrice: number | null = null;
  let foundTpPrice: number | null = null;
  let matchingProtectiveOrderCount = 0;
  let protectionSatisfied = false;

  const extractSlPx = (o: Record<string, unknown>): number | null => {
    const val = o.slTriggerPx ?? o.triggerPx ?? o.stopPx ?? o.trigPx;
    const n = typeof val === "number" ? val : typeof val === "string" ? Number(val) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const extractTpPx = (o: Record<string, unknown>): number | null => {
    const val = o.tpTriggerPx;
    const n = typeof val === "number" ? val : typeof val === "string" ? Number(val) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const consider = (o: Record<string, unknown>, prefix: "algo" | "pend") => {
    if (!instIdMatchesRow(instId, String(o.instId ?? ""))) return;
    if (!orderMatchesPositionSide(o, positionSide)) return;
    if (!orderLooksReduceOnlyProtective(o)) return;
    hints.push(`${prefix}:${stringifyHints(o)}`);
    matchingProtectiveOrderCount += 1;
    const slPx = extractSlPx(o);
    const tpPx = extractTpPx(o);
    if (foundSlPrice == null && slPx != null) foundSlPrice = slPx;
    if (foundTpPrice == null && tpPx != null) foundTpPrice = tpPx;
  };

  for (const o of algos) consider(o, "algo");
  for (const o of pending) consider(o, "pend");

  const foundSl = foundSlPrice != null;
  const foundTp = foundTpPrice != null;
  protectionSatisfied = foundSl && (!tpRequired || foundTp);

  return {
    protectionSatisfied,
    hints,
    slPrice: foundSlPrice,
    tpPrice: foundTpPrice,
    matchingProtectiveOrderCount
  };
}

function matchLedgerRow(
  opens: ReadonlyArray<PaperOpenPositionRecord>,
  symbol: string,
  side: "long" | "short"
): PaperOpenPositionRecord | null {
  for (const p of opens) {
    if ((p.status ?? "open") !== "open") continue;
    if (p.lifecycleState === "FAILED") continue;
    if (String(p.symbol) !== symbol) continue;
    const ps = String(p.side).toLowerCase() === "short" ? "short" : "long";
    if (ps !== side) continue;
    return p;
  }
  return null;
}

function bannerKo(b: PositionOpsBanner): string {
  switch (b) {
    case "NO_POSITION":
      return "열린 스왑 포지션 없음";
    case "REMOTE_UNAVAILABLE":
      return "OKX 포지션 스냅샷 없음 · 감시 제한";
    case "RECONCILE_MISMATCH":
      return "실거래소 포지션 / 장부 불일치 / 자동관리 제한";
    case "MONITORING_NO_PROTECT_WARNING":
      return "감시 중 · 보호(reduce-only) 주문 없음";
    case "MONITORING_RISK_PLAN_MISSING_WARNING":
      return "보호값 없음 / 조치 필요";
    case "MONITORING_PROTECT_DETECTED":
      return "감시 중 · 보호 주문 확인됨";
    case "MONITORING_SCAN_PENDING":
      return "감시 중 · 보호 주문 스캔 대기";
    default:
      return b;
  }
}

export function buildPositionOpsSurface(input: Readonly<{
  now: number;
  paperOpens: ReadonlyArray<PaperOpenPositionRecord>;
  okxPayload: ReadonlyArray<Record<string, unknown>> | null | undefined;
  pendingOrders: ReadonlyArray<Record<string, unknown>> | null;
  algoOrders: ReadonlyArray<Record<string, unknown>> | null;
  ordersScanPerformed: boolean;
  ordersScanErrors: string[];
  /** When set, ledger↔OKX sync uses ctVal to separate contracts from base qty. */
  instrumentByInstId?: ReadonlyMap<string, InstrumentSizing> | null;
}>): PositionOpsSurface {
  const instMap =
    input.instrumentByInstId && input.instrumentByInstId.size > 0
      ? new Map(input.instrumentByInstId)
      : undefined;
  const sync = buildLedgerOkxPositionSyncSnapshot(input.paperOpens, input.okxPayload, instMap);
  const pending = input.pendingOrders ?? [];
  const algos = input.algoOrders ?? [];

  const rows: PositionOpsRow[] = [];
  const payload = input.okxPayload;
  if (payload && Array.isArray(payload)) {
    for (const raw of payload) {
      const hit = okxSwapRowToLedgerKey(raw as Record<string, unknown>);
      if (!hit) continue;
      const avgPx = toFinite((raw as Record<string, unknown>).avgPx);
      const ledger = matchLedgerRow(input.paperOpens, hit.symbol, hit.side);
      const refPx = ledger?.entryPrice && ledger.entryPrice > 0 ? ledger.entryPrice : avgPx;
      const refSrc: PositionOpsRow["reference_source"] = ledger ? "paper_ledger" : avgPx != null ? "okx_avgPx" : "none";
      const regime = regimeForSl(ledger?.regimeAtEntry);
      const slNet = stopLossPctForRegime(regime);
      const stopPx = refPx != null && refPx > 0 ? engineMirrorStopPrice(refPx, hit.side, regime) : null;
      const tpPx = refPx != null && refPx > 0 ? engineMirrorTpPrice(refPx, hit.side, regime) : null;
      const ledgerStop = typeof ledger?.stopPrice === "number" && Number.isFinite(ledger.stopPrice) ? ledger.stopPrice : null;
      const ledgerTp = typeof ledger?.targetPrice1 === "number" && Number.isFinite(ledger.targetPrice1) ? ledger.targetPrice1 : null;
      const tpRequired =
        (ledgerTp != null && ledgerTp > 0) || (tpPx != null && tpPx > 0 && Number.isFinite(tpPx));

      const {
        protectionSatisfied,
        hints,
        slPrice: exchStopPx,
        tpPrice: exchTpPx,
        matchingProtectiveOrderCount
      } = findProtectiveHintsForInst(hit.instId, hit.side, pending, algos, tpRequired);

      let pxSource: PositionOpsRow["stop_px_source"] = "none";
      if (exchStopPx != null) pxSource = "exchange_order";
      else if (ledgerStop != null) pxSource = "ledger_stored";
      else if (stopPx != null) pxSource = "engine_calculated";

      let tpSource: PositionOpsRow["tp_px_source"] = "none";
      if (exchTpPx != null) tpSource = "exchange_order";
      else if (ledgerTp != null) tpSource = "ledger_stored";
      else if (tpPx != null) tpSource = "engine_calculated";

      rows.push({
        symbol: hit.symbol,
        side: hit.side,
        inst_id: hit.instId,
        okx_avg_px: avgPx,
        reference_entry_px: refPx,
        reference_source: refSrc,
        regime_for_sl: regime,
        policy_sl_net_frac: slNet,
        initial_stop_px_engine_mirror: stopPx,
        initial_tp_px_engine_mirror: tpPx,
        ledger_stop_px: ledgerStop,
        exchange_stop_px: exchStopPx,
        stop_px_source: pxSource,
        ledger_tp_px: ledgerTp,
        exchange_tp_px: exchTpPx,
        tp_px_source: tpSource,
        okx_pos_signed: hit.posSigned,
        matching_protective_pending_count: matchingProtectiveOrderCount,
        tp_required_for_exchange_protection: tpRequired,
        reduce_only_protective_found: protectionSatisfied,
        protective_match_hints: hints,
        reconcile_state: ledger?.reconcileState ?? "NONE",
        sync_status: ledger ? (sync.sync_status === "ALIGNED" ? "ALIGNED" : sync.sync_status) : "OKX_GHOST",
        can_adopt: ledger?.reconcileState === "RECONCILE_MISMATCH"
      });
    }
  }

  let surface_banner: PositionOpsBanner;
  if (sync.sync_status === "REMOTE_UNAVAILABLE") {
    if (sync.paper_open_position_count === 0 && sync.okx_nonzero_position_count === 0) {
      surface_banner = "NO_POSITION";
    } else {
      surface_banner = "REMOTE_UNAVAILABLE";
    }
  } else if (sync.sync_status !== "ALIGNED") {
    surface_banner = "RECONCILE_MISMATCH";
  } else if (rows.length === 0) {
    surface_banner = "NO_POSITION";
  } else if (!input.ordersScanPerformed) {
    surface_banner = "MONITORING_SCAN_PENDING";
  } else {
    const anyRiskMissing = rows.some(r => r.ledger_stop_px == null || !Number.isFinite(r.ledger_stop_px));
    if (anyRiskMissing) {
      surface_banner = "MONITORING_RISK_PLAN_MISSING_WARNING";
    } else {
      const anyMissingProtect = rows.some((r) => !r.reduce_only_protective_found);
      surface_banner = anyMissingProtect ? "MONITORING_NO_PROTECT_WARNING" : "MONITORING_PROTECT_DETECTED";
    }
  }

  return {
    generated_at: input.now,
    orders_scan_performed: input.ordersScanPerformed,
    orders_scan_errors: [...input.ordersScanErrors],
    reconcile_sync_status: sync.sync_status,
    surface_banner,
    surface_banner_ko: bannerKo(surface_banner),
    rows
  };
}

