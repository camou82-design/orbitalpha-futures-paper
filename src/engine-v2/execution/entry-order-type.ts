export type EntryExecutionStyle = "MOMENTUM_MARKETABLE_IOC" | "PASSIVE_LIMIT";

export type EntryOrderTypeClassification = Readonly<{
  executionStyle: EntryExecutionStyle;
  ordType: "ioc" | "limit";
  classificationReason: string;
}>;

export function normalizePxToTickSz(px: number, tickSz: number): number {
  if (!Number.isFinite(px) || px <= 0) return px;
  if (!Number.isFinite(tickSz) || tickSz <= 0) return px;
  const precision = Math.max(0, -Math.floor(Math.log10(tickSz) + 0.0001));
  const steps = Math.round(px / tickSz);
  return Number((steps * tickSz).toFixed(precision));
}

export function buildMomentumIocLimitPx(input: Readonly<{
  side: "buy" | "sell";
  bestBid: number;
  bestAsk: number;
  tickSz: number;
  slippageCapPct: number;
}>): { rawLimitPx: number; normalizedLimitPx: number } {
  const cap = Math.max(0, input.slippageCapPct);
  const rawLimitPx =
    input.side === "sell"
      ? input.bestBid * (1 - cap)
      : input.bestAsk * (1 + cap);
  return {
    rawLimitPx,
    normalizedLimitPx: normalizePxToTickSz(rawLimitPx, input.tickSz)
  };
}

const MOMENTUM_PROMOTION_PREFIXES = ["SHOCK_REACTION_"] as const;

const MOMENTUM_PROMOTION_EXACT = new Set([
  "CONTINUATION_MICRO_PROBE",
  "V2_PROBE_ENTRY_CONFIRMED",
  "V2_TREND_QUALIFIED_FINAL_PROMOTION",
  "BREAKDOWN_CONTINUATION",
  "BREAKOUT_CONTINUATION"
]);

const PASSIVE_PROMOTION_PATTERNS = [
  /^V2_RETEST_/,
  /RETEST/i,
  /RECLAIM/i,
  /PULLBACK/i,
  /RANGE_MID/i,
  /WAIT_RECHECK/i,
  /_PROBE_PROMOTION$/i,
  /REACTION_PROBE/i
] as const;

const PASSIVE_SUBTYPE_PATTERNS = [
  /RETEST/i,
  /RECLAIM/i,
  /PULLBACK/i,
  /RANGE_UPPER_REACTION/i,
  /RANGE_LOWER_REACTION/i,
  /RANGE_MID/i,
  /BREAKOUT_RETEST_/i,
  /BREAKDOWN_RETEST_/i
] as const;

const MOMENTUM_SUBTYPE_PATTERNS = [
  /BREAKOUT_CONTINUATION/i,
  /BREAKDOWN_CONTINUATION/i,
  /VOLUME_SHOCK_/i,
  /SHOCK_/i
] as const;

function includesContinuationWithoutRetest(value: string): boolean {
  const upper = value.toUpperCase();
  return upper.includes("CONTINUATION") && !upper.includes("RETEST");
}

export function classifyEntryOrderExecution(input: Readonly<{
  promotionReason: string | null;
  entrySubtype: string | null;
  executorReason?: string | null;
}>): EntryOrderTypeClassification {
  const promo = (input.promotionReason ?? "").trim();
  const promoUpper = promo.toUpperCase();
  const subtype = (input.entrySubtype ?? "").trim();
  const subtypeUpper = subtype.toUpperCase();
  const reasonLower = (input.executorReason ?? "").trim().toLowerCase();

  for (const prefix of MOMENTUM_PROMOTION_PREFIXES) {
    if (promoUpper.startsWith(prefix)) {
      return {
        executionStyle: "MOMENTUM_MARKETABLE_IOC",
        ordType: "ioc",
        classificationReason: `promotion_prefix:${prefix}`
      };
    }
  }

  if (MOMENTUM_PROMOTION_EXACT.has(promoUpper)) {
    return {
      executionStyle: "MOMENTUM_MARKETABLE_IOC",
      ordType: "ioc",
      classificationReason: `promotion_exact:${promoUpper}`
    };
  }

  if (includesContinuationWithoutRetest(promoUpper)) {
    return {
      executionStyle: "MOMENTUM_MARKETABLE_IOC",
      ordType: "ioc",
      classificationReason: "promotion_continuation"
    };
  }

  if (
    reasonLower.includes("breakout_continuation") ||
    reasonLower.includes("breakdown_continuation") ||
    promoUpper.includes("BREAKOUT_CONTINUATION") ||
    promoUpper.includes("BREAKDOWN_CONTINUATION")
  ) {
    return {
      executionStyle: "MOMENTUM_MARKETABLE_IOC",
      ordType: "ioc",
      classificationReason: "continuation_executor_or_promotion"
    };
  }

  for (const pattern of MOMENTUM_SUBTYPE_PATTERNS) {
    if (pattern.test(subtypeUpper) && !/RETEST/i.test(subtypeUpper)) {
      return {
        executionStyle: "MOMENTUM_MARKETABLE_IOC",
        ordType: "ioc",
        classificationReason: `subtype_momentum:${subtypeUpper}`
      };
    }
  }

  for (const pattern of PASSIVE_PROMOTION_PATTERNS) {
    if (pattern.test(promo)) {
      return {
        executionStyle: "PASSIVE_LIMIT",
        ordType: "limit",
        classificationReason: `promotion_passive:${pattern.source}`
      };
    }
  }

  for (const pattern of PASSIVE_SUBTYPE_PATTERNS) {
    if (pattern.test(subtypeUpper)) {
      return {
        executionStyle: "PASSIVE_LIMIT",
        ordType: "limit",
        classificationReason: `subtype_passive:${subtypeUpper}`
      };
    }
  }

  return {
    executionStyle: "PASSIVE_LIMIT",
    ordType: "limit",
    classificationReason: "default_passive_limit"
  };
}

export function shouldCancelStaleEntryOrder(input: Readonly<{
  pendingSide: "long" | "short";
  currentDecision: string;
  currentSide: string;
}>): string | null {
  if (input.currentDecision !== "ENTER") {
    return "authority_no_longer_enter";
  }
  if (input.currentSide !== input.pendingSide) {
    return "authority_side_flipped";
  }
  return null;
}

export function hasBlockingEntryPendingState(
  pendingOrders: ReadonlyArray<{
    symbol: string;
    side: "long" | "short";
    ordId?: string;
    clOrdId?: string;
    entryPendingState?: string | null;
    status?: string;
  }>,
  symbol: string,
  side: "long" | "short"
): boolean {
  return pendingOrders.some((p) => {
    if (p.symbol !== symbol || p.side !== side) return false;
    if (p.ordId || p.clOrdId) return true;
    if (
      p.entryPendingState === "ENTRY_SUBMIT_PENDING" ||
      p.entryPendingState === "ENTRY_FILL_RECONCILING"
    ) {
      return true;
    }
    if (p.status === "ENTRY_ORDER_PENDING") return true;
    return false;
  });
}
