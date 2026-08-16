import { resolveOpenNotionalUsd, resolveOpenNotionalAuthority, isV2AuthorityRow } from "./position-size-authority";

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
  }>;
  /** BLOCKER 4-6: OKX actual positions for unknown-unit paper position authority resolution. */
  okxActualPositions?: ReadonlyArray<{ symbol: string; sizeUsd?: number; notionalUsd?: number; side: string }> | null;
  pendingSymbolNotionalUsdt: number;
  pendingOrdersNotionalUsdt: number;
  isLiveAuthority: boolean;
}>;

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
  manual_external_notional_usdt: number;
  bot_v2_notional_usdt: number;
  excluded_manual_position_count: number;
}>;

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
    
    if (isV2AuthorityRow(p as any)) {
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
  
  const paper_symbol_notional_usdt = symbolAnalysis.total ?? NaN;
  const paper_account_notional_usdt = accountAnalysis.total ?? NaN;
  
  const strategy_symbol_notional_usdt = symbolAnalysis.strategyOnly ?? NaN;
  const strategy_account_notional_usdt = accountAnalysis.strategyOnly ?? NaN;

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
    manual_external_notional_usdt: accountAnalysis.manualExternal,
    bot_v2_notional_usdt: accountAnalysis.botV2,
    excluded_manual_position_count: accountAnalysis.excludedManualCount
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
