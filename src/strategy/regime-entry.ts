import type { PaperCandidateStrength, PaperSignal } from "./entry-signal";
import type { MarketRegime } from "./market-regime-detector";

export type RegimeEntryDecision =
  | Readonly<{ ok: true; direction: "long" | "short"; detail: Record<string, unknown> }>
  | Readonly<{ ok: false; reason: string; detail: Record<string, unknown> }>;

export type RegimeEntryContext = Readonly<{
  regime: MarketRegime;
  symbol: string;
  signal: PaperSignal;
  qualityScore: number;
  candidateStrength: PaperCandidateStrength | null;
  lastPrice: number;
  latestCandleClose: number;
  ema20: number | null;
  ema60: number | null;
  volumeRatioProxy: number;
  /** recent box (per-symbol) */
  boxHigh: number | null;
  boxLow: number | null;
  /** (price - low)/(high-low) in [0..1] if box is valid */
  boxPos: number | null;
  boxRel: number | null;
}>;

function isDir(signal: PaperSignal): "long" | "short" | null {
  if (signal === "paper_long_candidate") return "long";
  if (signal === "paper_short_candidate") return "short";
  return null;
}

/**
 * Regime-aware entry rules:
 * - RANGE: only box edges, middle forbidden, short TP / tighter SL handled by exit rules.
 * - TREND: breakout or pullback-confirm entries; fewer trades.
 * - NO_TRADE: always block.
 */
export function evaluateRegimeEntry(ctx: RegimeEntryContext): RegimeEntryDecision {
  const dir = isDir(ctx.signal);
  if (dir === null) return { ok: false, reason: "no_signal", detail: {} };
  if (ctx.regime === "NO_TRADE") {
    return { ok: false, reason: "no_trade_regime", detail: { regime: ctx.regime } };
  }

  // Common minimum quality floor (keep conservative).
  if (ctx.qualityScore < 64) {
    return { ok: false, reason: "blocked_low_signal", detail: { score: ctx.qualityScore, floor: 64 } };
  }

  if (ctx.regime === "RANGE") {
    if (ctx.boxPos === null || ctx.boxRel === null || ctx.boxHigh === null || ctx.boxLow === null) {
      return { ok: false, reason: "range_box_missing", detail: {} };
    }
    if (ctx.boxRel < 0.0045) {
      return { ok: false, reason: "range_box_too_narrow", detail: { box_rel: ctx.boxRel, min: 0.0045 } };
    }

    // Middle forbidden.
    if (ctx.boxPos > 0.33 && ctx.boxPos < 0.67) {
      return { ok: false, reason: "range_center_forbidden", detail: { box_pos: ctx.boxPos } };
    }

    // Edge-only directional mapping.
    if (dir === "long") {
      if (ctx.boxPos > 0.22) {
        return { ok: false, reason: "range_not_at_lower_edge", detail: { box_pos: ctx.boxPos, max: 0.22 } };
      }
      return { ok: true, direction: "long", detail: { edge: "lower", box_pos: ctx.boxPos, box_rel: ctx.boxRel } };
    }
    if (dir === "short") {
      if (ctx.boxPos < 0.78) {
        return { ok: false, reason: "range_not_at_upper_edge", detail: { box_pos: ctx.boxPos, min: 0.78 } };
      }
      return { ok: true, direction: "short", detail: { edge: "upper", box_pos: ctx.boxPos, box_rel: ctx.boxRel } };
    }
  }

  // TREND
  const e20 = ctx.ema20;
  const e60 = ctx.ema60;
  if (e20 === null || e60 === null || !Number.isFinite(e20) || !Number.isFinite(e60)) {
    return { ok: false, reason: "blocked_no_structure", detail: { sub: "ema_missing" } };
  }
  const cl = ctx.latestCandleClose;
  const emaAlignedLong = e20 > e60 * 1.0002 && cl >= e20 * 0.998;
  const emaAlignedShort = e20 < e60 * 0.9998 && cl <= e20 * 1.002;

  // Trade count reduction: require stronger volume / confirmation.
  if (ctx.volumeRatioProxy < 1.05) {
    return { ok: false, reason: "trend_volume_too_thin", detail: { volume_ratio_proxy: ctx.volumeRatioProxy, min: 1.05 } };
  }

  const hasBox = ctx.boxHigh !== null && ctx.boxLow !== null && ctx.boxPos !== null && ctx.boxRel !== null;
  const breakoutUp = hasBox ? ctx.lastPrice >= (ctx.boxHigh as number) * 1.0006 : false;
  const breakoutDown = hasBox ? ctx.lastPrice <= (ctx.boxLow as number) * 0.9994 : false;
  const pullbackLong = ctx.lastPrice <= e20 * 1.006 && ctx.lastPrice >= e20 * 0.994;
  const pullbackShort = ctx.lastPrice >= e20 * 0.994 && ctx.lastPrice <= e20 * 1.006;

  if (dir === "long") {
    if (!emaAlignedLong) return { ok: false, reason: "trend_not_aligned", detail: { sub: "ema_long_not_aligned" } };
    if (!(breakoutUp || pullbackLong)) {
      return { ok: false, reason: "trend_need_breakout_or_pullback", detail: { breakoutUp, pullbackLong } };
    }
    return { ok: true, direction: "long", detail: { breakoutUp, pullbackLong } };
  }

  if (dir === "short") {
    if (!emaAlignedShort) return { ok: false, reason: "trend_not_aligned", detail: { sub: "ema_short_not_aligned" } };
    if (!(breakoutDown || pullbackShort)) {
      return { ok: false, reason: "trend_need_breakout_or_pullback", detail: { breakoutDown, pullbackShort } };
    }
    return { ok: true, direction: "short", detail: { breakoutDown, pullbackShort } };
  }

  return { ok: false, reason: "blocked_no_structure", detail: {} };
}

