import type { EngineV2Side, MarketJudgmentOutput } from "../types";
import type { V2StateAuthority } from "../state/types";
import type { V2AddOnPolicyResult } from "../addon/types";
import type { V2ExitPolicyResult } from "../exit/types";

export type V2TradeLifecycleStage =
    | "position_state"
    | "entry"
    | "add_on"
    | "partial"
    | "exit"
    | "cooldown";

type ProofCacheValue = Readonly<{ key: string; updatedAtMs: number }>;

const LIFECYCLE_PROOF_TTL_MS = 60 * 60 * 1000;
const LIFECYCLE_PROOF_MAX_SIZE = 5000;
const lifecycleProofLastKeyByEventSymbol = new Map<string, ProofCacheValue>();

function pruneLifecycleProofCache(nowMs: number): void {
    for (const [key, value] of lifecycleProofLastKeyByEventSymbol.entries()) {
        if (nowMs - value.updatedAtMs > LIFECYCLE_PROOF_TTL_MS) {
            lifecycleProofLastKeyByEventSymbol.delete(key);
        }
    }
    while (lifecycleProofLastKeyByEventSymbol.size > LIFECYCLE_PROOF_MAX_SIZE) {
        const oldestKey = lifecycleProofLastKeyByEventSymbol.keys().next().value as string | undefined;
        if (!oldestKey) break;
        lifecycleProofLastKeyByEventSymbol.delete(oldestKey);
    }
}

function shouldEmitLifecycleProof(symbol: string, key: string, highPriority: boolean, nowMs: number): boolean {
    pruneLifecycleProofCache(nowMs);
    const verbose = String(process.env.V2_PROOF_VERBOSE ?? "").toLowerCase() === "true";
    const mapKey = `V2_TRADE_LIFECYCLE_PROOF:${symbol}`;
    const previous = lifecycleProofLastKeyByEventSymbol.get(mapKey);
    if (verbose || highPriority || previous?.key !== key) {
        lifecycleProofLastKeyByEventSymbol.set(mapKey, { key, updatedAtMs: nowMs });
        return true;
    }
    return false;
}

function resolveLifecycleStage(addOnPolicy: V2AddOnPolicyResult | null, exitPolicy: V2ExitPolicyResult | null): V2TradeLifecycleStage {
    if (exitPolicy?.shouldExit === true) return "exit";
    if (exitPolicy?.shouldPartial === true || exitPolicy?.shouldReduce === true) return "partial";
    if (addOnPolicy?.isAddOn === true) return "add_on";
    if (exitPolicy?.hasPosition === true) return "position_state";
    return "entry";
}

function resolveCooldownType(v2State: V2StateAuthority): "direction_block" | "time_reentry" | "risk_halt" | "none" {
    if (String(v2State.riskMode ?? "").toUpperCase() === "HALT" || v2State.dailyLossGuardTriggered === true) {
        return "risk_halt";
    }
    if (v2State.freshTickBarrierActive === true || v2State.freshTickExecutionBlocked === true) {
        return "time_reentry";
    }
    if (
        v2State.directionalShockState !== "NONE" ||
        v2State.longAllow === false ||
        v2State.shortAllow === false
    ) {
        return "direction_block";
    }
    return "none";
}

function buildConsistencyReasons(
    v2State: V2StateAuthority,
    addOnPolicy: V2AddOnPolicyResult | null,
    exitPolicy: V2ExitPolicyResult | null
): string[] {
    const reasons: string[] = [];
    if (v2State.directionalShockState === "DOWN" && v2State.longAllow === true) {
        reasons.push("DOWN_SHOCK_LONG_ALLOW_TRUE");
    }
    if (v2State.directionalShockState === "UP" && v2State.shortAllow === true) {
        reasons.push("UP_SHOCK_SHORT_ALLOW_TRUE");
    }
    if (v2State.hasLongPosition && v2State.hasShortPosition) {
        reasons.push("DUAL_SIDE_POSITION_DETECTED");
    }
    if (addOnPolicy?.allowed === true && addOnPolicy.hasOppositeSidePosition === true) {
        reasons.push("ADDON_ALLOWED_WITH_OPPOSITE_POSITION");
    }
    if (addOnPolicy?.allowed === true && addOnPolicy.isAddOn !== true) {
        reasons.push("ADDON_ALLOWED_WITHOUT_EXISTING_POSITION");
    }
    if (exitPolicy && exitPolicy.hasPosition === false && exitPolicy.action !== "HOLD") {
        reasons.push("EXIT_ACTION_WITHOUT_POSITION");
    }
    if (exitPolicy?.shouldExit === true && exitPolicy.reduceRatio < 1) {
        reasons.push("FULL_EXIT_WITH_REDUCE_RATIO_UNDER_1");
    }
    return reasons;
}

export function emitV2TradeLifecycleProof(args: Readonly<{
    symbol: string;
    side: EngineV2Side | "long" | "short" | "none";
    v2State: V2StateAuthority;
    judgment: MarketJudgmentOutput;
    addOnPolicy?: V2AddOnPolicyResult | null;
    exitPolicy?: V2ExitPolicyResult | null;
    reason?: string | null;
}>): void {
    const addOnPolicy = args.addOnPolicy ?? null;
    const exitPolicy = args.exitPolicy ?? null;
    const nowMs = Number(args.v2State.now ?? Date.now());
    const lifecycleStage = resolveLifecycleStage(addOnPolicy, exitPolicy);
    const cooldownType = resolveCooldownType(args.v2State);
    const inconsistencyReasons = buildConsistencyReasons(args.v2State, addOnPolicy, exitPolicy);
    const consistencyPass = inconsistencyReasons.length === 0;
    const highPriority =
        !consistencyPass ||
        lifecycleStage === "exit" ||
        lifecycleStage === "partial" ||
        addOnPolicy?.allowed === true;
    const key = [
        lifecycleStage,
        args.side ?? "none",
        args.judgment.regime_final,
        args.judgment.shockPhase,
        args.v2State.directionalShockState,
        addOnPolicy?.action ?? "NO_ADDON_POLICY",
        addOnPolicy?.reason ?? "NO_ADDON_REASON",
        exitPolicy?.action ?? "NO_EXIT_POLICY",
        exitPolicy?.reason ?? "NO_EXIT_REASON",
        cooldownType,
        consistencyPass ? "PASS" : inconsistencyReasons.join(",")
    ].join("|");

    if (!shouldEmitLifecycleProof(args.symbol, key, highPriority, nowMs)) return;

    console.info(JSON.stringify({
        event: "V2_TRADE_LIFECYCLE_PROOF",
        symbol: args.symbol,
        lifecycle_stage: lifecycleStage,
        authority_source: "v2",
        adopted_engine: "V2",
        regime: args.judgment.regime_final,
        market_subtype: args.judgment.subtype,
        directional_shock_state: args.v2State.directionalShockState,
        shock_phase: args.judgment.shockPhase,
        range_phase: args.judgment.rangePhase,
        trend_phase: args.judgment.trendPhase,
        transition_phase: args.judgment.transitionPhase,
        side: args.side ?? "none",
        current_stage: args.v2State.currentStage,
        has_long_position: args.v2State.hasLongPosition,
        has_short_position: args.v2State.hasShortPosition,
        has_same_side_position: args.v2State.hasSameSidePosition,
        has_opposite_side_position: args.v2State.hasOppositeSidePosition,
        long_allow: args.v2State.longAllow,
        short_allow: args.v2State.shortAllow,
        add_on_action: addOnPolicy?.action ?? null,
        add_on_allowed: addOnPolicy?.allowed ?? null,
        add_on_reason: addOnPolicy?.reason ?? null,
        partial_reason: exitPolicy?.shouldPartial === true || exitPolicy?.shouldReduce === true ? exitPolicy.reason : null,
        exit_action: exitPolicy?.action ?? null,
        exit_reason: exitPolicy?.reason ?? null,
        exit_should_exit: exitPolicy?.shouldExit ?? null,
        exit_should_reduce: exitPolicy?.shouldReduce ?? null,
        exit_should_partial: exitPolicy?.shouldPartial ?? null,
        exit_reduce_ratio: exitPolicy?.reduceRatio ?? null,
        cooldown_reason: cooldownType === "none" ? null : cooldownType,
        cooldown_type: cooldownType,
        position_state_owner: args.v2State.stateAuthoritySource,
        legacy_intervention_detected: false,
        consistency_pass: consistencyPass,
        inconsistency_reasons: inconsistencyReasons,
        evidence: args.reason ?? addOnPolicy?.evidence ?? exitPolicy?.evidence ?? null
    }));
}
