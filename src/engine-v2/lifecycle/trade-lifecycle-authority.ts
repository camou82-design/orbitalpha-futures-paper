import type { V2TradeLifecycleAuthorityInput, V2TradeLifecycleAuthorityResult, V2CooldownType, V2LifecycleStage } from "../types";

function resolveCooldownType(input: V2TradeLifecycleAuthorityInput): V2CooldownType {
    const reason = String(input.cooldownState.reason ?? "").toLowerCase();
    if (reason.includes("risk") || reason.includes("halt") || reason.includes("daily_loss")) return "risk_halt";
    if (reason.includes("reentry_fail") || reason.includes("fail_reentry")) return "fail_reentry";
    if (input.cooldownState.reentryBlocked || reason.includes("reentry") || reason.includes("cooldown")) return "time_reentry";
    if (
        (input.directionalShockState === "DOWN" && input.side === "long") ||
        (input.directionalShockState === "UP" && input.side === "short") ||
        reason.includes("direction") ||
        reason.includes("side_not_allowed")
    ) {
        return "direction_block";
    }
    return "none";
}

function resolveLifecycleStage(input: V2TradeLifecycleAuthorityInput): V2LifecycleStage {
    if (input.v2Decision === "ENTER") {
        return input.position ? "add_on" : "entry";
    }
    if (input.v2Decision === "EXIT") return "exit";
    const cooldownType = resolveCooldownType(input);
    if (cooldownType !== "none") return "cooldown";
    if (input.position != null && (input.unrealizedPnlPct ?? 0) > 0.003 && input.regime === "RANGE") return "partial";
    return "position_state";
}

export function deriveTradeLifecycleAuthority(input: V2TradeLifecycleAuthorityInput): V2TradeLifecycleAuthorityResult {
    const proofReasons: string[] = [];
    const inconsistencyReasons: string[] = [];
    const cooldownType = resolveCooldownType(input);
    const lifecycleStage = resolveLifecycleStage(input);
    const isV2Owner = input.authoritySource === "v2" && input.adoptedEngine === "V2";
    const partialExecutionOwner = "paper_engine";
    const exitExecutionOwner = "paper_engine";
    const cooldownExecutionOwner = "paper_engine";
    const positionStateExecutionOwner = "paper_engine";
    const postEntryExecutionOwner = "paper_engine";

    if (input.directionalShockState === "DOWN" && input.side === "long") {
        proofReasons.push("DOWN_SHOCK_LONG_RESTRICTED_MANAGEMENT");
    } else if (input.directionalShockState === "UP" && input.side === "short") {
        proofReasons.push("UP_SHOCK_SHORT_RESTRICTED_MANAGEMENT");
    }

    const boxPos = input.rawMetricsSummary.boxPos;
    const rangeEdge =
        typeof boxPos === "number" && Number.isFinite(boxPos) && (boxPos <= 0.15 || boxPos >= 0.85);
    const rangeMid =
        typeof boxPos === "number" && Number.isFinite(boxPos) && boxPos > 0.35 && boxPos < 0.65;
    const trendHealthy = input.rawMetricsSummary.trendWeaknessScore <= 0.55;

    let addOnAllowed: boolean | null = null;
    let partialAction: V2TradeLifecycleAuthorityResult["partialAction"] = "none";
    let exitAction: V2TradeLifecycleAuthorityResult["exitAction"] = "none";

    if (input.position != null) {
        if (input.regime === "RANGE") {
            addOnAllowed = rangeEdge && !rangeMid;
            partialAction = (input.unrealizedPnlPct ?? 0) >= 0.003 && rangeEdge ? "protect_profit" : "prepare";
            exitAction = rangeMid && (input.unrealizedPnlPct ?? 0) >= 0.002 ? "watch" : "none";
            proofReasons.push(rangeEdge ? "RANGE_EDGE_MANAGEMENT" : "RANGE_MID_CONSERVATIVE_MANAGEMENT");
        } else if (input.regime === "TREND") {
            addOnAllowed = trendHealthy && (input.unrealizedPnlPct ?? 0) > 0;
            partialAction = trendHealthy ? "none" : "prepare";
            exitAction = trendHealthy ? "none" : "watch";
            proofReasons.push(trendHealthy ? "TREND_CONTINUATION_HOLD" : "TREND_WEAKNESS_EXIT_WATCH");
        } else {
            addOnAllowed = false;
            partialAction = "none";
            exitAction = input.v2Decision === "EXIT" ? "exit" : "watch";
            proofReasons.push("NON_RANGE_TREND_DEFENSIVE_MANAGEMENT");
        }
    }

    if (input.v2Decision === "EXIT") {
        exitAction = "exit";
        proofReasons.push("V2_DECISION_EXIT_CONFIRMED");
    }

    if (cooldownType !== "none" && input.v2Decision === "ENTER") {
        inconsistencyReasons.push("COOLDOWN_ENTER_CONFLICT");
    }
    if (input.authoritySource !== "v2") {
        inconsistencyReasons.push("AUTHORITY_SOURCE_NOT_V2");
    }
    if (input.adoptedEngine !== "V2") {
        inconsistencyReasons.push("ADOPTED_ENGINE_NOT_V2");
    }
    if (input.v2Side !== input.side && input.side !== null && input.v2Side !== null) {
        inconsistencyReasons.push("SIDE_MISMATCH_V2_SIDE");
    }
    if (
        input.directionalShockState === "DOWN" &&
        input.side === "long" &&
        cooldownType === "risk_halt" &&
        String(input.cooldownState.reason ?? "").toLowerCase().includes("direction")
    ) {
        inconsistencyReasons.push("DIRECTION_BLOCK_MERGED_INTO_RISK_COOLDOWN");
    }

    inconsistencyReasons.push("PARTIAL_EXECUTION_OWNER_NOT_V2");
    proofReasons.push(`partial_execution_owner=${partialExecutionOwner}`);
    inconsistencyReasons.push("EXIT_EXECUTION_OWNER_NOT_V2");
    proofReasons.push(`exit_execution_owner=${exitExecutionOwner}`);
    inconsistencyReasons.push("COOLDOWN_OWNER_NOT_V2");
    proofReasons.push(`cooldown_owner=${cooldownExecutionOwner}`);
    inconsistencyReasons.push("POSITION_STATE_OWNER_NOT_V2");
    proofReasons.push(`position_state_owner=${positionStateExecutionOwner}`);
    inconsistencyReasons.push("POST_ENTRY_EXECUTION_OWNER_PAPER_ENGINE");
    proofReasons.push(`post_entry_execution_owner=${postEntryExecutionOwner}`);
    if (isV2Owner && postEntryExecutionOwner === "paper_engine") {
        inconsistencyReasons.push("V2_LIFECYCLE_WITH_PAPER_EXECUTION_OWNER");
        proofReasons.push("lifecycle_authority_v2_execution_owner_paper_engine");
    }

    const legacyInterventionDetected = !isV2Owner || inconsistencyReasons.some((x) => x.includes("LEGACY"));
    const consistencyPass = inconsistencyReasons.length === 0 && isV2Owner;

    const result: V2TradeLifecycleAuthorityResult = {
        symbol: input.symbol,
        side: input.side,
        lifecycleStage,
        authoritySource: input.authoritySource,
        adoptedEngine: input.adoptedEngine,
        positionStateOwner: isV2Owner ? "v2" : input.authoritySource === "v1" ? "legacy" : "unknown",
        entryManagedByV2: isV2Owner,
        addOnManagedByV2: isV2Owner,
        partialManagedByV2: isV2Owner,
        exitManagedByV2: isV2Owner,
        cooldownManagedByV2: isV2Owner,
        positionStateManagedByV2: isV2Owner,
        addOnAllowed,
        partialAction,
        exitAction,
        cooldownType,
        cooldownReason: input.cooldownState.reason,
        legacyInterventionDetected,
        consistencyPass,
        inconsistencyReasons,
        proofReasons
    };
    return result;
}
