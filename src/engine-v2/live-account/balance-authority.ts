export type LiveBalanceAuthorityInput = Readonly<{
  okxAuthMode: "disabled" | "demo" | "live";
  balancePayload: Record<string, unknown> | null;
  balanceFetchError: string | null;
  okxPositionsPayload: ReadonlyArray<Record<string, unknown>> | null;
  positions: ReadonlyArray<{
    symbol: string;
    side: string;
    sizeUsd: number;
    leverage: number;
  }>;
}>;

export type LiveBalanceAuthorityResult = Readonly<{
  balance_source: "okx_live_wallet" | "paper_config" | "unavailable";
  position_source: "okx_actual" | "paper_estimated" | "unavailable";
  live_balance_ready: boolean;
  live_balance_block_reason: string | null;
  okx_wallet_balance_usdt: number | null;
  okx_available_balance_usdt: number | null;
  okx_used_margin_usdt: number | null;
  okx_total_position_notional_usdt: number | null;
  okx_effective_leverage_used: number | null;
  okx_position_parse_source: string | null;

  // Proof fields for diagnostics
  okx_auth_mode: "disabled" | "demo" | "live";
  balance_source_raw: string | null;
  wallet_field_source: string | null;
  available_field_source: string | null;
  raw_total_eq: number | null;
  raw_adj_eq: number | null;
  usdt_eq: number | null;
  usdt_cash_bal: number | null;
  usdt_avail_bal: number | null;
  usdt_avail_eq: number | null;
  usdt_frozen_bal: number | null;
  usdt_ord_frozen: number | null;

  // 로컬 paper positions 기준 추정치 필드 분리
  paper_position_estimated_used_margin_usdt: number;
  paper_position_estimated_notional_usdt: number;
  paper_position_estimated_effective_leverage_used: number | null;

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
    source: "okx_actual" | "paper_estimated";
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
  raw_total_eq: number | null;
  raw_adj_eq: number | null;
  usdt_eq: number | null;
  usdt_cash_bal: number | null;
  usdt_avail_bal: number | null;
  usdt_avail_eq: number | null;
  usdt_frozen_bal: number | null;
  usdt_ord_frozen: number | null;
  wallet_field_source: string | null;
  available_field_source: string | null;
} {
  const out = {
    walletBalanceUsdt: null as number | null,
    availableBalanceUsdt: null as number | null,
    raw_total_eq: null as number | null,
    raw_adj_eq: null as number | null,
    usdt_eq: null as number | null,
    usdt_cash_bal: null as number | null,
    usdt_avail_bal: null as number | null,
    usdt_avail_eq: null as number | null,
    usdt_frozen_bal: null as number | null,
    usdt_ord_frozen: null as number | null,
    wallet_field_source: null as string | null,
    available_field_source: null as string | null,
  };

  if (!payload) return out;

  out.raw_total_eq = toFiniteNumber(payload.totalEq);
  out.raw_adj_eq = toFiniteNumber(payload.adjEq);

  const details = Array.isArray(payload.details) ? (payload.details as Record<string, unknown>[]) : [];
  const selected = selectUsdtDetail(details);

  if (selected) {
    out.usdt_eq = toFiniteNumber(selected.eq);
    out.usdt_cash_bal = toFiniteNumber(selected.cashBal);
    out.usdt_avail_bal = toFiniteNumber(selected.availBal);
    out.usdt_avail_eq = toFiniteNumber(selected.availEq);
    out.usdt_frozen_bal = toFiniteNumber(selected.frozenBal);
    out.usdt_ord_frozen = toFiniteNumber(selected.ordFrozen);

    // Wallet source selection
    if (out.raw_total_eq != null) {
      out.walletBalanceUsdt = out.raw_total_eq;
      out.wallet_field_source = "payload.totalEq";
    } else if (out.usdt_eq != null) {
      out.walletBalanceUsdt = out.usdt_eq;
      out.wallet_field_source = "selected.eq";
    }

    // Available source selection
    if (out.usdt_avail_eq != null) {
      out.availableBalanceUsdt = out.usdt_avail_eq;
      out.available_field_source = "selected.availEq";
    } else if (out.usdt_avail_bal != null) {
      out.availableBalanceUsdt = out.usdt_avail_bal;
      out.available_field_source = "selected.availBal";
    } else if (out.usdt_eq != null) {
      out.availableBalanceUsdt = out.usdt_eq;
      out.available_field_source = "selected.eq_fallback";
    }
  }

  return out;
}

function computePaperEstimatedUsage(
  positions: LiveBalanceAuthorityInput["positions"],
  walletBalanceUsdt: number | null
): {
  used_margin: number;
  notional: number;
  leverage: number | null;
  lines: LiveBalanceAuthorityResult["position_margin_lines"];
} {
  const lines: LiveBalanceAuthorityResult["position_margin_lines"] = positions.map((p) => {
    const lev = Number.isFinite(p.leverage) && p.leverage > 0 ? p.leverage : 1;
    const margin = Math.max(0, p.sizeUsd);
    const notional = margin * lev;
    return {
      symbol: String(p.symbol),
      side: String(p.side),
      notional_usdt: notional,
      applied_leverage: lev,
      estimated_margin_usdt: lev > 0 ? notional / lev : margin,
      source: "paper_estimated"
    };
  });
  const used_margin = lines.reduce((acc, x) => acc + x.estimated_margin_usdt, 0);
  const notional = lines.reduce((acc, x) => acc + x.notional_usdt, 0);
  const leverage =
    walletBalanceUsdt != null && walletBalanceUsdt > 0
      ? notional / walletBalanceUsdt
      : (lines.length === 0 ? 0 : null);
  return { used_margin, notional, leverage, lines };
}

function parseOkxPositions(
  payload: ReadonlyArray<Record<string, unknown>> | null
): {
  used_margin: number;
  notional: number;
  lines: LiveBalanceAuthorityResult["position_margin_lines"];
  parse_source: string;
} {
  if (!payload || !Array.isArray(payload)) return { used_margin: 0, notional: 0, lines: [], parse_source: "none" };
  const lines: LiveBalanceAuthorityResult["position_margin_lines"] = [];
  let totalMargin = 0;
  let totalNotional = 0;
  let marginSource = "none";
  let notionalSource = "none";

  for (const p of payload) {
    const pos = toFiniteNumber(p.pos);
    if (pos === null || pos === 0) continue;

    // Notional Priority: notionalUsd -> notional -> abs(pos * markPx)
    let nVal = toFiniteNumber(p.notionalUsd);
    if (nVal !== null) {
      if (notionalSource === "none") notionalSource = "notionalUsd";
    } else {
      nVal = toFiniteNumber(p.notional);
      if (nVal !== null) {
        if (notionalSource === "none" || notionalSource === "notionalUsd") notionalSource = "notional";
      } else {
        const markPx = toFiniteNumber(p.markPx);
        if (markPx !== null) {
          nVal = Math.abs(pos * markPx);
          if (notionalSource === "none" || notionalSource === "notionalUsd" || notionalSource === "notional") notionalSource = "markPx_calc";
        }
      }
    }
    const finalNotional = nVal ?? 0;

    // Margin Priority: imr -> margin -> notional/leverage
    let mVal = toFiniteNumber(p.imr);
    if (mVal !== null) {
      if (marginSource === "none") marginSource = "imr";
    } else {
      mVal = toFiniteNumber(p.margin);
      if (mVal !== null) {
        if (marginSource === "none" || marginSource === "imr") marginSource = "margin";
      } else {
        const lever = toFiniteNumber(p.lever);
        if (lever !== null && lever > 0) {
          mVal = finalNotional / lever;
          if (marginSource === "none" || marginSource === "imr" || marginSource === "margin") marginSource = "leverage_est";
        }
      }
    }
    const finalMargin = mVal ?? 0;

    totalMargin += finalMargin;
    totalNotional += Math.abs(finalNotional);

    lines.push({
      symbol: String(p.instId ?? "unknown"),
      side: String(p.posSide ?? "none"),
      notional_usdt: Math.abs(finalNotional),
      applied_leverage: toFiniteNumber(p.lever) ?? 1,
      estimated_margin_usdt: finalMargin,
      source: "okx_actual"
    });
  }

  return { 
    used_margin: totalMargin, 
    notional: totalNotional, 
    lines, 
    parse_source: payload.length === 0 ? "no_open_positions" : `m:${marginSource}|n:${notionalSource}`
  };
}

export function deriveLiveBalanceAuthority(input: LiveBalanceAuthorityInput): LiveBalanceAuthorityResult {
  const paperUsage = computePaperEstimatedUsage(input.positions, null);

  if (input.okxAuthMode !== "live") {
    const walletBalanceUsdt = null;
    const usage = computePaperEstimatedUsage(input.positions, walletBalanceUsdt);
    return {
      balance_source: "paper_config",
      position_source: "paper_estimated",
      live_balance_ready: false,
      live_balance_block_reason: null,
      okx_wallet_balance_usdt: null,
      okx_available_balance_usdt: null,
      okx_used_margin_usdt: usage.used_margin,
      okx_total_position_notional_usdt: usage.notional,
      okx_effective_leverage_used: usage.leverage,
      okx_position_parse_source: "paper_estimated",

      okx_auth_mode: input.okxAuthMode,
      balance_source_raw: "paper_config",
      wallet_field_source: null,
      available_field_source: null,
      raw_total_eq: null,
      raw_adj_eq: null,
      usdt_eq: null,
      usdt_cash_bal: null,
      usdt_avail_bal: null,
      usdt_avail_eq: null,
      usdt_frozen_bal: null,
      usdt_ord_frozen: null,

      paper_position_estimated_used_margin_usdt: paperUsage.used_margin,
      paper_position_estimated_notional_usdt: paperUsage.notional,
      paper_position_estimated_effective_leverage_used: paperUsage.leverage,

      account_equity_display_source: "paper_config",
      account_equity_krw_display: 500_000,
      account_equity_krw_effective: 500_000,
      max_usable_margin_krw_effective: 420_000,
      position_margin_lines: usage.lines
    };
  }

  const parsedWallet = parseWalletFromPayload(input.balancePayload);
  const ready =
    parsedWallet.walletBalanceUsdt != null &&
    parsedWallet.availableBalanceUsdt != null &&
    parsedWallet.walletBalanceUsdt > 0 &&
    parsedWallet.availableBalanceUsdt >= 0;

  if (!ready) {
    return {
      balance_source: "unavailable",
      position_source: "unavailable",
      live_balance_ready: false,
      live_balance_block_reason: input.balanceFetchError ?? "LIVE_BALANCE_UNAVAILABLE",
      okx_wallet_balance_usdt: null,
      okx_available_balance_usdt: null,
      okx_used_margin_usdt: null,
      okx_total_position_notional_usdt: null,
      okx_effective_leverage_used: null,
      okx_position_parse_source: null,

      okx_auth_mode: input.okxAuthMode,
      balance_source_raw: "unavailable",
      wallet_field_source: parsedWallet.wallet_field_source,
      available_field_source: parsedWallet.available_field_source,
      raw_total_eq: parsedWallet.raw_total_eq,
      raw_adj_eq: parsedWallet.raw_adj_eq,
      usdt_eq: parsedWallet.usdt_eq,
      usdt_cash_bal: parsedWallet.usdt_cash_bal,
      usdt_avail_bal: parsedWallet.usdt_avail_bal,
      usdt_avail_eq: parsedWallet.usdt_avail_eq,
      usdt_frozen_bal: parsedWallet.usdt_frozen_bal,
      usdt_ord_frozen: parsedWallet.usdt_ord_frozen,

      paper_position_estimated_used_margin_usdt: paperUsage.used_margin,
      paper_position_estimated_notional_usdt: paperUsage.notional,
      paper_position_estimated_effective_leverage_used: paperUsage.leverage,

      account_equity_display_source: "unavailable",
      account_equity_krw_display: null,
      account_equity_krw_effective: null,
      max_usable_margin_krw_effective: null,
      position_margin_lines: []
    };
  }

  // Live mode: parse actual OKX positions
  const okxUsage = parseOkxPositions(input.okxPositionsPayload);
  const okxEffectiveLeverage = 
    (input.okxPositionsPayload && parsedWallet.walletBalanceUsdt != null && parsedWallet.walletBalanceUsdt > 0)
      ? okxUsage.notional / parsedWallet.walletBalanceUsdt
      : (okxUsage.lines.length === 0 ? 0 : null);

  const paperUsageWithLiveWallet = computePaperEstimatedUsage(input.positions, parsedWallet.walletBalanceUsdt);

  let live_balance_block_reason: string | null = null;
  if (parsedWallet.availableBalanceUsdt === 0 && (parsedWallet.walletBalanceUsdt ?? 0) > 0) {
    if (parsedWallet.usdt_avail_eq === 0) {
      live_balance_block_reason = "AVAILABLE_BALANCE_ZERO_WITH_POSITIVE_WALLET";
    } else if (parsedWallet.usdt_avail_eq == null) {
      live_balance_block_reason = "OKX_AVAILABLE_FIELD_MISSING";
    } else {
      live_balance_block_reason = "OKX_AVAILABLE_FIELD_ZERO";
    }
  }

  const result: LiveBalanceAuthorityResult = {
    balance_source: "okx_live_wallet",
    position_source: input.okxPositionsPayload ? "okx_actual" : "unavailable",
    live_balance_ready: true,
    live_balance_block_reason,
    okx_wallet_balance_usdt: parsedWallet.walletBalanceUsdt,
    okx_available_balance_usdt: parsedWallet.availableBalanceUsdt,
    okx_used_margin_usdt: input.okxPositionsPayload ? okxUsage.used_margin : null,
    okx_total_position_notional_usdt: input.okxPositionsPayload ? okxUsage.notional : null,
    okx_effective_leverage_used: input.okxPositionsPayload ? okxEffectiveLeverage : null,
    okx_position_parse_source: input.okxPositionsPayload ? okxUsage.parse_source : null,

    okx_auth_mode: input.okxAuthMode,
    balance_source_raw: "okx_live_wallet",
    wallet_field_source: parsedWallet.wallet_field_source,
    available_field_source: parsedWallet.available_field_source,
    raw_total_eq: parsedWallet.raw_total_eq,
    raw_adj_eq: parsedWallet.raw_adj_eq,
    usdt_eq: parsedWallet.usdt_eq,
    usdt_cash_bal: parsedWallet.usdt_cash_bal,
    usdt_avail_bal: parsedWallet.usdt_avail_bal,
    usdt_avail_eq: parsedWallet.usdt_avail_eq,
    usdt_frozen_bal: parsedWallet.usdt_frozen_bal,
    usdt_ord_frozen: parsedWallet.usdt_ord_frozen,

    paper_position_estimated_used_margin_usdt: paperUsage.used_margin,
    paper_position_estimated_notional_usdt: paperUsage.notional,
    paper_position_estimated_effective_leverage_used: paperUsageWithLiveWallet.leverage,

    account_equity_display_source: "okx_live_wallet",
    // KRW conversion: Fixed 1000 multiplier is used (estimated)
    account_equity_krw_display: (parsedWallet.walletBalanceUsdt ?? 0) * 1000,
    account_equity_krw_effective: (parsedWallet.walletBalanceUsdt ?? 0) * 1000,
    max_usable_margin_krw_effective: (parsedWallet.availableBalanceUsdt ?? 0) * 1000,
    position_margin_lines: okxUsage.lines
  };

  console.info(JSON.stringify({
    event: "OKX_LIVE_BALANCE_RAW_FIELD_PROOF",
    okx_auth_mode: result.okx_auth_mode,
    balance_source: result.balance_source,
    wallet_field_source: result.wallet_field_source,
    available_field_source: result.available_field_source,
    raw_total_eq: result.raw_total_eq,
    raw_adj_eq: result.raw_adj_eq,
    usdt_eq: result.usdt_eq,
    usdt_cash_bal: result.usdt_cash_bal,
    usdt_avail_bal: result.usdt_avail_bal,
    usdt_avail_eq: result.usdt_avail_eq,
    usdt_frozen_bal: result.usdt_frozen_bal,
    usdt_ord_frozen: result.usdt_ord_frozen,
    parsed_wallet_balance_usdt: result.okx_wallet_balance_usdt,
    parsed_available_balance_usdt: result.okx_available_balance_usdt,
    live_balance_block_reason: result.live_balance_block_reason
  }));

  return result;
}
