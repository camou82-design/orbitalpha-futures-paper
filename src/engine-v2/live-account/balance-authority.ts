export type LiveBalanceAuthorityInput = Readonly<{
  okxAuthMode: "disabled" | "demo" | "live";
  balancePayload: Record<string, unknown> | null;
  balanceFetchError: string | null;
  positions: ReadonlyArray<{
    symbol: string;
    side: string;
    sizeUsd: number;
    leverage: number;
  }>;
}>;

export type LiveBalanceAuthorityResult = Readonly<{
  balance_source: "okx_live_wallet" | "paper_config" | "unavailable";
  live_balance_ready: boolean;
  live_balance_block_reason: string | null;
  okx_wallet_balance_usdt: number | null;
  okx_available_balance_usdt: number | null;
  okx_used_margin_usdt: number;
  okx_total_position_notional_usdt: number;
  okx_effective_leverage_used: number | null;
  account_equity_display_source: "okx_live_wallet" | "paper_config" | "unavailable";
  account_equity_krw_display: number | null;
  account_equity_krw_effective: number | null;
  max_usable_margin_krw_effective: number | null;
  position_margin_lines: Array<{
    symbol: string;
    side: string;
    notional_usdt: number;
    applied_leverage: number;
    estimated_margin_usdt: number;
  }>;
}>;

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function selectUsdtDetail(details: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> | null {
  for (const d of details) {
    const ccy = String(d.ccy ?? "").toUpperCase();
    if (ccy === "USDT") return d;
  }
  return details.length > 0 ? details[0] : null;
}

function parseWalletFromPayload(payload: Record<string, unknown> | null): {
  walletBalanceUsdt: number | null;
  availableBalanceUsdt: number | null;
} {
  if (!payload) return { walletBalanceUsdt: null, availableBalanceUsdt: null };
  const details = Array.isArray(payload.details) ? (payload.details as Record<string, unknown>[]) : [];
  const selected = selectUsdtDetail(details);
  const walletBalanceUsdt = toFiniteNumber(payload.totalEq) ?? (selected ? toFiniteNumber(selected.eq) : null);
  const availableBalanceUsdt =
    (selected ? toFiniteNumber(selected.availEq) : null) ??
    (selected ? toFiniteNumber(selected.availBal) : null) ??
    (selected ? toFiniteNumber(selected.eq) : null);
  return { walletBalanceUsdt, availableBalanceUsdt };
}

function computeUsage(
  positions: LiveBalanceAuthorityInput["positions"],
  walletBalanceUsdt: number | null
): Pick<LiveBalanceAuthorityResult, "okx_used_margin_usdt" | "okx_total_position_notional_usdt" | "okx_effective_leverage_used" | "position_margin_lines"> {
  const position_margin_lines = positions.map((p) => {
    const lev = Number.isFinite(p.leverage) && p.leverage > 0 ? p.leverage : 1;
    const margin = Math.max(0, p.sizeUsd);
    const notional = margin * lev;
    return {
      symbol: String(p.symbol),
      side: String(p.side),
      notional_usdt: notional,
      applied_leverage: lev,
      estimated_margin_usdt: lev > 0 ? notional / lev : margin
    };
  });
  const okx_used_margin_usdt = position_margin_lines.reduce((acc, x) => acc + x.estimated_margin_usdt, 0);
  const okx_total_position_notional_usdt = position_margin_lines.reduce((acc, x) => acc + x.notional_usdt, 0);
  const okx_effective_leverage_used =
    walletBalanceUsdt != null && walletBalanceUsdt > 0
      ? okx_total_position_notional_usdt / walletBalanceUsdt
      : (position_margin_lines.length === 0 ? 0 : null);
  return { okx_used_margin_usdt, okx_total_position_notional_usdt, okx_effective_leverage_used, position_margin_lines };
}

export function deriveLiveBalanceAuthority(input: LiveBalanceAuthorityInput): LiveBalanceAuthorityResult {
  if (input.okxAuthMode !== "live") {
    const usage = computeUsage(input.positions, null);
    return {
      balance_source: "paper_config",
      live_balance_ready: false,
      live_balance_block_reason: null,
      okx_wallet_balance_usdt: null,
      okx_available_balance_usdt: null,
      ...usage,
      account_equity_display_source: "paper_config",
      account_equity_krw_display: 500_000,
      account_equity_krw_effective: 500_000,
      max_usable_margin_krw_effective: 420_000
    };
  }

  const parsed = parseWalletFromPayload(input.balancePayload);
  const ready =
    parsed.walletBalanceUsdt != null &&
    parsed.availableBalanceUsdt != null &&
    parsed.walletBalanceUsdt > 0 &&
    parsed.availableBalanceUsdt >= 0;

  if (!ready) {
    const usage = computeUsage(input.positions, null);
    return {
      balance_source: "unavailable",
      live_balance_ready: false,
      live_balance_block_reason: input.balanceFetchError ?? "LIVE_BALANCE_UNAVAILABLE",
      okx_wallet_balance_usdt: null,
      okx_available_balance_usdt: null,
      ...usage,
      account_equity_display_source: "unavailable",
      account_equity_krw_display: null,
      account_equity_krw_effective: null,
      max_usable_margin_krw_effective: null
    };
  }

  const usage = computeUsage(input.positions, parsed.walletBalanceUsdt);
  return {
    balance_source: "okx_live_wallet",
    live_balance_ready: true,
    live_balance_block_reason: null,
    okx_wallet_balance_usdt: parsed.walletBalanceUsdt,
    okx_available_balance_usdt: parsed.availableBalanceUsdt,
    ...usage,
    account_equity_display_source: "okx_live_wallet",
    account_equity_krw_display: (parsed.walletBalanceUsdt ?? 0) * 1000,
    account_equity_krw_effective: (parsed.walletBalanceUsdt ?? 0) * 1000,
    max_usable_margin_krw_effective: (parsed.availableBalanceUsdt ?? 0) * 1000
  };
}
