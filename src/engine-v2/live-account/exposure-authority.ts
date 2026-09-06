import { resolveOpenNotionalUsd, resolveOpenNotionalAuthority, isV2AuthorityRow } from "./position-size-authority";
import { evaluateOrderOwnership } from "../position/manual-takeover-authority";
import { classifyOkxOpenOrderPurpose, resolveInstrumentCtVal } from "../../engine/position-ops-monitor";
import type { PaperOpenPositionRecord } from "../../models/types";

export type LiveExposureAuthorityInput = Readonly<{
  symbol: string;
  okxPositions: ReadonlyArray<{ symbol: string; sizeUsd: number; side: string }>;
  paperPositions: ReadonlyArray<{ 
    symbol: string; 
    sizeUsd?: number; 
    side?: string;
    leverage?: number;
    isV2Authority?: boolean;
    authoritySourceAtEntry?: string;
    authority?: string;
    exchangeClOrdId?: string;
    manualTakeoverActive?: boolean;
    manualOwnershipLatch?: boolean;
    lifecycleState?: string;
  }>;
  /** BLOCKER 4-6: OKX actual positions for unknown-unit paper position authority resolution. */
  okxActualPositions?: ReadonlyArray<{ symbol: string; sizeUsd?: number; notionalUsd?: number; side: string }> | null;
  pendingSymbolNotionalUsdt: number;
  pendingOrdersNotionalUsdt: number;
  isLiveAuthority: boolean;
  botPendingSymbolNotionalUsdt?: number;
  botPendingOrdersNotionalUsdt?: number;
  operatorPendingSymbolNotionalUsdt?: number;
  operatorPendingOrdersNotionalUsdt?: number;
  pendingOrdersList?: ReadonlyArray<Record<string, unknown>> | null;
  algoOrdersList?: ReadonlyArray<Record<string, unknown>> | null;
  /** True when per-order pending/algo payloads were fetched successfully (empty arrays allowed). */
  pendingOrdersListAvailable?: boolean;
  snapshotPrices?: Record<string, number>;
}>;

function orderReduceOnlyFlag(o: Record<string, unknown>): boolean {
  return (
    o.reduceOnly === true ||
    String(o.reduceOnly).toLowerCase() === "true" ||
    o.closeFraction === "1" ||
    String(o.closeFraction) === "1"
  );
}

function resolvePositionSideFromOrder(o: Record<string, unknown>): "long" | "short" | null {
  const ps = String(o.posSide ?? "").trim().toLowerCase();
  if (ps === "long" || ps === "short") return ps;
  const side = String(o.side ?? "").trim().toLowerCase();
  if (side === "buy") return "long";
  if (side === "sell") return "short";
  return null;
}

function findLedgerForOrder(
  opens: readonly PaperOpenPositionRecord[],
  instId: string,
  positionSide: "long" | "short"
): PaperOpenPositionRecord | null {
  for (const p of opens) {
    const ps = String(p.side).toLowerCase() === "short" ? "short" : "long";
    if (ps !== positionSide) continue;
    const ledgerInst = String(p.instId ?? "").trim();
    if (ledgerInst.length > 0 && ledgerInst !== instId) continue;
    if ((p.status ?? "open") === "open") return p;
  }
  return null;
}

function resolveLedgerForOrder(
  ord: Record<string, unknown>,
  opens: readonly PaperOpenPositionRecord[]
): PaperOpenPositionRecord | null {
  const instId = String(ord.instId ?? "");
  const positionSide = resolvePositionSideFromOrder(ord);
  if (positionSide == null || instId.length === 0) return null;
  return findLedgerForOrder(opens, instId, positionSide);
}

function resolvePendingOrderExposureNotionalUsdt(
  ord: Record<string, unknown>,
  snapshotPrices: Record<string, number> = {}
): number {
  const precomputed = Number(ord.notionalUsd);
  if (Number.isFinite(precomputed) && precomputed > 0) return precomputed;

  const instId = String(ord.instId ?? "");
  const rawSym = instId.includes("-USDT-SWAP")
    ? instId.replace("-USDT-SWAP", "USDT").replace("-", "")
    : instId.replace("-SWAP", "").replace("-", "");
  const symbol = rawSym.length > 0 ? rawSym : "UNKNOWN";

  const sz = Number(ord.sz ?? 0);
  if (!Number.isFinite(sz) || sz <= 0) return 0;

  const ctVal = resolveInstrumentCtVal(symbol);
  let pxVal: number | null = null;
  const rawPx = Number(ord.px);
  if (Number.isFinite(rawPx) && rawPx > 0) {
    pxVal = rawPx;
  } else {
    const rawTriggerPx = Number(ord.tpTriggerPx ?? ord.slTriggerPx ?? ord.triggerPx ?? ord.stopPx);
    if (Number.isFinite(rawTriggerPx) && rawTriggerPx > 0) pxVal = rawTriggerPx;
    else if (snapshotPrices[symbol] != null && snapshotPrices[symbol]! > 0) pxVal = snapshotPrices[symbol]!;
  }
  if (pxVal == null || pxVal <= 0) return 0;
  return sz * ctVal * pxVal;
}

function pendingOrderMatchesSymbol(ord: Record<string, unknown>, symbol: string): boolean {
  const instId = String(ord.instId ?? ord.symbol ?? "");
  const normalized = instId.replace(/-/g, "").toUpperCase();
  const sym = symbol.replace(/-/g, "").toUpperCase();
  return normalized.includes(sym) || sym.includes(normalized.replace("SWAP", ""));
}

export function isEngineOwnedExposureIncreasingPending(
  ord: Record<string, unknown>,
  isAlgo: boolean,
  opens: readonly PaperOpenPositionRecord[]
): boolean {
  if (orderReduceOnlyFlag(ord)) return false;
  const ledger = resolveLedgerForOrder(ord, opens);
  const classification = classifyOkxOpenOrderPurpose(ord, ledger);
  if (classification.isBotManagedProtection) return false;
  if (classification.purpose === "manual-entry-purpose") return false;
  if (classification.purpose === "manual-reduce-purpose") return false;
  const ev = evaluateOrderOwnership(ord, isAlgo, opens);
  return ev.ownership === "ENGINE_OWNED";
}

function sumEngineOwnedPendingNotional(input: Readonly<{
  pendingOrdersList?: ReadonlyArray<Record<string, unknown>> | null;
  algoOrdersList?: ReadonlyArray<Record<string, unknown>> | null;
  paperPositions: LiveExposureAuthorityInput["paperPositions"];
  symbol: string;
  snapshotPrices?: Record<string, number>;
}>): { accountUsdt: number; symbolUsdt: number } {
  const opens = input.paperPositions as PaperOpenPositionRecord[];
  const snapshotPrices = input.snapshotPrices ?? {};
  let accountUsdt = 0;
  let symbolUsdt = 0;

  const ingest = (ord: Record<string, unknown>, isAlgo: boolean) => {
    if (!isEngineOwnedExposureIncreasingPending(ord, isAlgo, opens)) return;
    const notional = resolvePendingOrderExposureNotionalUsdt(ord, snapshotPrices);
    if (!(notional > 0)) return;
    accountUsdt += notional;
    if (pendingOrderMatchesSymbol(ord, input.symbol)) symbolUsdt += notional;
  };

  for (const ord of input.pendingOrdersList ?? []) ingest(ord, false);
  for (const algo of input.algoOrdersList ?? []) ingest(algo, true);
  return { accountUsdt, symbolUsdt };
}

export type LiveExposureAuthorityResult = Readonly<{
  okx_symbol_notional_usdt: number;
  okx_account_notional_usdt: number;
  paper_symbol_notional_usdt: number;
  paper_account_notional_usdt: number;
  final_symbol_notional_usdt: number;
  final_account_notional_usdt: number;
  authority_source: "okx_actual" | "paper_ledger";

  strategy_symbol_notional_usdt: number;
  strategy_account_notional_usdt: number;
  bot_strategy_symbol_notional_usdt: number;
  bot_strategy_account_notional_usdt: number;
  manual_external_notional_usdt: number;
  manual_position_notional_usdt: number;
  bot_v2_notional_usdt: number;
  operator_pending_notional_usdt: number;
  engine_owned_pending_notional_usdt: number;
  excluded_manual_position_count: number;
  pending_order_ownership_unavailable: boolean;
}>;

export function isPendingOrdersListAvailable(
  input: Pick<LiveExposureAuthorityInput, "pendingOrdersListAvailable" | "pendingOrdersList" | "algoOrdersList">
): boolean {
  if (input.pendingOrdersListAvailable === true) return true;
  if (input.pendingOrdersListAvailable === false) return false;
  return Array.isArray(input.pendingOrdersList) && Array.isArray(input.algoOrdersList);
}

export function sumOkxExposureNotional(
  positions: ReadonlyArray<{ symbol: string; sizeUsd: number }>,
  symbolFilter?: string
): number {
  let total = 0;
  for (const p of positions) {
    if (!p || typeof p.sizeUsd !== "number" || !Number.isFinite(p.sizeUsd)) continue;
    if (symbolFilter != null && p.symbol !== symbolFilter) continue;
    total += Math.abs(p.sizeUsd);
  }
  return total;
}

export function analyzePaperExposure(
  positions: LiveExposureAuthorityInput["paperPositions"],
  symbolFilter?: string,
  okxActualPositions?: ReadonlyArray<{ symbol: string; sizeUsd?: number; notionalUsd?: number; side: string }> | null
): { total: number | null; strategyOnly: number | null; manualExternal: number; botV2: number; excludedManualCount: number } {
  function findOkxNotional(pSymbol: string, pSide: string): number | undefined {
    if (!Array.isArray(okxActualPositions)) return undefined;
    const sideLower = String(pSide).toLowerCase();
    for (const okxP of okxActualPositions) {
      if (!okxP || okxP.symbol !== pSymbol) continue;
      if (String(okxP.side).toLowerCase() !== sideLower) continue;
      const n = typeof okxP.notionalUsd === "number" && Number.isFinite(okxP.notionalUsd) && okxP.notionalUsd > 0
        ? okxP.notionalUsd
        : typeof okxP.sizeUsd === "number" && Number.isFinite(okxP.sizeUsd) && okxP.sizeUsd > 0
          ? okxP.sizeUsd
          : undefined;
      if (n !== undefined) return n;
    }
    return undefined;
  }

  let total = 0;
  let strategyOnly = 0;
  let manualExternal = 0;
  let botV2 = 0;
  let excludedManualCount = 0;
  let hasUnknown = false;

  for (const p of positions) {
    if (!p || typeof p.symbol !== "string") continue;
    if (symbolFilter != null && p.symbol !== symbolFilter) continue;
    const okxNotional = findOkxNotional(p.symbol, String(p.side ?? ""));
    const auth = resolveOpenNotionalAuthority(p as any, okxNotional);
    
    if (!auth.authoritative || auth.valueUsd == null) {
      hasUnknown = true; // Fail closed: exposure unknown
      continue;
    }
    
    const val = Math.abs(auth.valueUsd);
    total += val;
    
    const isManual =
      p.manualTakeoverActive === true ||
      p.manualOwnershipLatch === true ||
      p.lifecycleState === "OPERATOR_MANAGED" ||
      p.lifecycleState === "EXTERNAL_MANUAL_MANAGED" ||
      p.lifecycleState === "EXTERNAL_MANUAL_POSITION" ||
      !isV2AuthorityRow(p as any);

    if (!isManual && isV2AuthorityRow(p as any)) {
      strategyOnly += val;
      botV2 += val;
    } else {
      manualExternal += val;
      excludedManualCount++;
    }
  }
  
  if (hasUnknown) {
    return { total: null, strategyOnly: null, manualExternal, botV2, excludedManualCount };
  }
  return { total, strategyOnly, manualExternal, botV2, excludedManualCount };
}

export function sumPaperExposureNotional(
  positions: LiveExposureAuthorityInput["paperPositions"],
  symbolFilter?: string,
  okxActualPositions?: ReadonlyArray<{ symbol: string; sizeUsd?: number; notionalUsd?: number; side: string }> | null
): number | null {
  return analyzePaperExposure(positions, symbolFilter, okxActualPositions).total;
}

export function resolveLiveExposureAuthority(input: LiveExposureAuthorityInput): LiveExposureAuthorityResult {
  const okx_symbol_notional_usdt =
    sumOkxExposureNotional(input.okxPositions, input.symbol) + Math.max(0, input.pendingSymbolNotionalUsdt);
  const okx_account_notional_usdt =
    sumOkxExposureNotional(input.okxPositions) + Math.max(0, input.pendingOrdersNotionalUsdt);
    
  const symbolAnalysis = analyzePaperExposure(input.paperPositions, input.symbol, input.okxActualPositions);
  const accountAnalysis = analyzePaperExposure(input.paperPositions, undefined, input.okxActualPositions);

  // Compute pending order split between bot-owned and operator-owned
  let botPendingOrdersNotional = typeof input.botPendingOrdersNotionalUsdt === "number" && Number.isFinite(input.botPendingOrdersNotionalUsdt)
    ? Math.max(0, input.botPendingOrdersNotionalUsdt)
    : null;
  let botPendingSymbolNotional = typeof input.botPendingSymbolNotionalUsdt === "number" && Number.isFinite(input.botPendingSymbolNotionalUsdt)
    ? Math.max(0, input.botPendingSymbolNotionalUsdt)
    : null;

  let pendingOrderOwnershipUnavailable = false;

  if (botPendingOrdersNotional == null) {
    if (isPendingOrdersListAvailable(input)) {
      const split = sumEngineOwnedPendingNotional({
        pendingOrdersList: input.pendingOrdersList ?? [],
        algoOrdersList: input.algoOrdersList ?? [],
        paperPositions: input.paperPositions,
        symbol: input.symbol,
        snapshotPrices: input.snapshotPrices
      });
      botPendingOrdersNotional = split.accountUsdt;
      botPendingSymbolNotional = split.symbolUsdt;
    } else if (Math.max(0, input.pendingOrdersNotionalUsdt) > 0) {
      pendingOrderOwnershipUnavailable = true;
      botPendingOrdersNotional = null;
      botPendingSymbolNotional = null;
    } else {
      botPendingOrdersNotional = 0;
      botPendingSymbolNotional = 0;
    }
  }

  const engine_owned_pending_notional_usdt = pendingOrderOwnershipUnavailable
    ? NaN
    : (botPendingOrdersNotional ?? 0);
  const engine_owned_symbol_pending_notional = pendingOrderOwnershipUnavailable
    ? NaN
    : (botPendingSymbolNotional ?? (botPendingOrdersNotional != null ? Math.min(botPendingOrdersNotional, Math.max(0, input.pendingSymbolNotionalUsdt)) : 0));
  const operator_pending_notional_usdt = pendingOrderOwnershipUnavailable
    ? NaN
    : Math.max(0, input.pendingOrdersNotionalUsdt - engine_owned_pending_notional_usdt);

  const paper_symbol_notional_usdt =
    symbolAnalysis.total != null ? symbolAnalysis.total + Math.max(0, input.pendingSymbolNotionalUsdt) : NaN;
  const paper_account_notional_usdt =
    accountAnalysis.total != null ? accountAnalysis.total + Math.max(0, input.pendingOrdersNotionalUsdt) : NaN;
  
  const strategy_symbol_notional_usdt = pendingOrderOwnershipUnavailable
    ? NaN
    : symbolAnalysis.strategyOnly != null
      ? symbolAnalysis.strategyOnly + engine_owned_symbol_pending_notional
      : NaN;
  const strategy_account_notional_usdt = pendingOrderOwnershipUnavailable
    ? NaN
    : accountAnalysis.strategyOnly != null
      ? accountAnalysis.strategyOnly + engine_owned_pending_notional_usdt
      : NaN;

  const useOkx = input.isLiveAuthority;
  return {
    okx_symbol_notional_usdt,
    okx_account_notional_usdt,
    paper_symbol_notional_usdt,
    paper_account_notional_usdt,
    final_symbol_notional_usdt: useOkx ? okx_symbol_notional_usdt : paper_symbol_notional_usdt,
    final_account_notional_usdt: useOkx ? okx_account_notional_usdt : paper_account_notional_usdt,
    authority_source: useOkx ? "okx_actual" : "paper_ledger",
    
    strategy_symbol_notional_usdt,
    strategy_account_notional_usdt,
    bot_strategy_symbol_notional_usdt: strategy_symbol_notional_usdt,
    bot_strategy_account_notional_usdt: strategy_account_notional_usdt,
    manual_external_notional_usdt: accountAnalysis.manualExternal,
    manual_position_notional_usdt: accountAnalysis.manualExternal,
    bot_v2_notional_usdt: accountAnalysis.botV2,
    operator_pending_notional_usdt,
    engine_owned_pending_notional_usdt,
    excluded_manual_position_count: accountAnalysis.excludedManualCount,
    pending_order_ownership_unavailable: pendingOrderOwnershipUnavailable
  };
}

export function emitLiveExposureAuthorityProof(
  emit: (payload: Record<string, unknown>) => void,
  input: Readonly<{
    symbol: string;
    exposure: LiveExposureAuthorityResult;
    is_addon: boolean;
    requested_order_notional_usdt: number;
    projected_symbol_notional_usdt: number;
    projected_account_notional_usdt: number;
    max_symbol_notional_usdt: number | null;
    max_account_notional_usdt: number | null;
    cap_passed: boolean;
  }>
): void {
  emit({
    event: "V2_LIVE_EXPOSURE_AUTHORITY_PROOF",
    symbol: input.symbol,
    okx_symbol_notional_usdt: input.exposure.okx_symbol_notional_usdt,
    okx_account_notional_usdt: input.exposure.okx_account_notional_usdt,
    paper_symbol_notional_usdt: input.exposure.paper_symbol_notional_usdt,
    paper_account_notional_usdt: input.exposure.paper_account_notional_usdt,
    final_symbol_notional_usdt: input.exposure.final_symbol_notional_usdt,
    final_account_notional_usdt: input.exposure.final_account_notional_usdt,
    authority_source: input.exposure.authority_source,
    is_addon: input.is_addon,
    requested_order_notional_usdt: input.requested_order_notional_usdt,
    projected_symbol_notional_usdt: input.projected_symbol_notional_usdt,
    projected_account_notional_usdt: input.projected_account_notional_usdt,
    max_symbol_notional_usdt: input.max_symbol_notional_usdt,
    max_account_notional_usdt: input.max_account_notional_usdt,
    cap_passed: input.cap_passed
  });
}
