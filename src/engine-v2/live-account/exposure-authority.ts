export type LiveExposureAuthorityInput = Readonly<{
  symbol: string;
  okxPositions: ReadonlyArray<{ symbol: string; sizeUsd: number; side: string }>;
  paperPositions: ReadonlyArray<{ symbol: string; sizeUsd?: number; side?: string }>;
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

export function sumPaperExposureNotional(
  positions: ReadonlyArray<{ symbol: string; sizeUsd?: number }>,
  symbolFilter?: string
): number {
  let total = 0;
  for (const p of positions) {
    if (!p || typeof p.symbol !== "string") continue;
    if (symbolFilter != null && p.symbol !== symbolFilter) continue;
    const n = typeof p.sizeUsd === "number" && Number.isFinite(p.sizeUsd) ? p.sizeUsd : 0;
    total += Math.abs(n);
  }
  return total;
}

export function resolveLiveExposureAuthority(input: LiveExposureAuthorityInput): LiveExposureAuthorityResult {
  const okx_symbol_notional_usdt =
    sumOkxExposureNotional(input.okxPositions, input.symbol) + Math.max(0, input.pendingSymbolNotionalUsdt);
  const okx_account_notional_usdt =
    sumOkxExposureNotional(input.okxPositions) + Math.max(0, input.pendingOrdersNotionalUsdt);
  const paper_symbol_notional_usdt = sumPaperExposureNotional(input.paperPositions, input.symbol);
  const paper_account_notional_usdt = sumPaperExposureNotional(input.paperPositions);

  const useOkx = input.isLiveAuthority;
  return {
    okx_symbol_notional_usdt,
    okx_account_notional_usdt,
    paper_symbol_notional_usdt,
    paper_account_notional_usdt,
    final_symbol_notional_usdt: useOkx ? okx_symbol_notional_usdt : paper_symbol_notional_usdt,
    final_account_notional_usdt: useOkx ? okx_account_notional_usdt : paper_account_notional_usdt,
    authority_source: useOkx ? "okx_actual" : "paper_ledger"
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
