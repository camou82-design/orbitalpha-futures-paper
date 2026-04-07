import type { MarketRegime } from "../market-regime-detector";

export type ExecutorName = "RANGE" | "TREND" | "NONE";

export type RiskState = "NORMAL" | "LIMITED" | "BLOCKED";

export type EntryDecisionBase = Readonly<{
  entry_allowed: boolean;
  blocked_reason: string | null;
  expected_move: number | null;
  total_cost: number | null;
  risk_state: RiskState;
  regime: MarketRegime;
  executor: ExecutorName;
  detail: Record<string, unknown>;
}>;

export type RangeEntryDecision = Readonly<
  EntryDecisionBase & {
    executor: "RANGE";
    box_position: "upper" | "lower" | "middle" | "unknown";
  }
>;

export type TrendEntryDecision = Readonly<
  EntryDecisionBase & {
    executor: "TREND";
    breakout_state: "breakout_up" | "breakout_down" | "none" | "unknown";
    pullback_state: "pullback_ok" | "pullback_bad" | "unknown";
  }
>;

export type NoopEntryDecision = Readonly<EntryDecisionBase & { executor: "NONE" }>;

export type AnyEntryDecision = RangeEntryDecision | TrendEntryDecision | NoopEntryDecision;

