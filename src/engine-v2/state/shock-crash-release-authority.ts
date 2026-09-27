import type { Candle } from "../../models/types";
import type { EngineV2Input, EngineV2Regime } from "../types";

/** regime_final authority surface (excludes TRANSITION). */
export type RegimeFinalAuthority = Extract<EngineV2Regime, "TREND" | "RANGE" | "NO_TRADE">;
import { evaluateCrashRisk, evaluatePumpRisk, type CrashState, type PumpState } from "../../engine/crash-detector";
import { isHtfPolicyCompatibleWithCandidateSide } from "../market-judgment/whipsaw-aged-soft-downgrade";

export type ShockReleaseAuthorityProof = Readonly<{
    previous_shock_state: string;
    previous_crash_state: string;
    trend_score: number;
    ema_gap: number;
    higher_low: boolean;
    higher_high: boolean;
    upper_breakout_hold: boolean;
    htf_policy: string;
    release_eligible: boolean;
    release_reason: string | null;
    final_shock_state: string;
    final_crash_state: string;
    final_regime?: string;
    final_router_executor?: string;
}>;

const CRASH_HARD_ORDER: Record<string, number> = {
    NONE: 0,
    CRASH_ALERT: 1,
    CRASH_REDUCE: 2,
    CRASH_EXIT: 3,
    CRASH_LOCK: 4
};

function crashOrder(s: string): number {
    const u = String(s ?? "NONE").toUpperCase();
    if (u.includes("LOCK")) return CRASH_HARD_ORDER.CRASH_LOCK;
    if (u.includes("EXIT")) return CRASH_HARD_ORDER.CRASH_EXIT;
    if (u.includes("REDUCE")) return CRASH_HARD_ORDER.CRASH_REDUCE;
    if (u.includes("ALERT")) return CRASH_HARD_ORDER.CRASH_ALERT;
    return CRASH_HARD_ORDER.NONE;
}

export function evaluateLiveMarketDirectionalShock(input: EngineV2Input): "UP" | "DOWN" | "NONE" {
    const candles = input.candles ?? input.snapshot?.candles ?? [];
    if (!Array.isArray(candles) || candles.length < 10) return "NONE";
    const atr = input.snapshot?.atr ?? null;
    const now = input.now ?? Date.now();
    const globalCrash = evaluateCrashRisk({
        symbol: input.symbol,
        candles,
        atr: typeof atr === "number" ? atr : null,
        now,
        isGlobal: true
    });
    const globalPump = evaluatePumpRisk({
        symbol: input.symbol,
        candles,
        atr: typeof atr === "number" ? atr : null,
        now,
        isGlobal: true
    });
    const cOrd = crashOrder(globalCrash.state);
    const pOrd = pumpOrder(globalPump.state);
    if (cOrd > pOrd) return "DOWN";
    if (pOrd > cOrd) return "UP";
    return "NONE";
}

function pumpOrder(s: string): number {
    const u = String(s ?? "NONE").toUpperCase();
    if (u.includes("LOCK")) return 4;
    if (u.includes("EXIT")) return 3;
    if (u.includes("REDUCE")) return 2;
    if (u.includes("ALERT")) return 1;
    return 0;
}

export function evaluateLiveCrashPumpStates(input: EngineV2Input): { crashState: CrashState; pumpState: PumpState } {
    const candles = input.candles ?? input.snapshot?.candles ?? [];
    if (!Array.isArray(candles) || candles.length < 10) {
        return { crashState: "NONE", pumpState: "NONE" };
    }
    const atr = input.snapshot?.atr ?? null;
    const now = input.now ?? Date.now();
    return {
        crashState: evaluateCrashRisk({
            symbol: input.symbol,
            candles,
            atr: typeof atr === "number" ? atr : null,
            now,
            isGlobal: true
        }).state,
        pumpState: evaluatePumpRisk({
            symbol: input.symbol,
            candles,
            atr: typeof atr === "number" ? atr : null,
            now,
            isGlobal: true
        }).state
    };
}

export type TrendRecoveryStructuralMetrics = Readonly<{
    trendScore: number;
    emaGap: number;
    higherLow: boolean;
    higherHigh: boolean;
    upperBreakoutHold: boolean;
    htfPolicy: string;
    trendDominant: boolean;
    structuralRecovery: boolean;
}>;

export function deriveTrendRecoveryStructuralMetrics(input: EngineV2Input): TrendRecoveryStructuralMetrics {
    const sn = input.snapshot ?? ({} as EngineV2Input["snapshot"]);
    const candles = (input.candles ?? sn.candles ?? []) as Candle[];
    const emaGap = Number(sn.emaGap ?? 0);
    const trendWeakness = Number(sn.canonicalTrendWeaknessScore ?? sn.trendWeaknessScore ?? 1);
    const canonicalTrendScore =
        typeof sn.canonicalTrendScore === "number" && Number.isFinite(sn.canonicalTrendScore)
            ? sn.canonicalTrendScore
            : Math.abs(emaGap) * 1000;

    let higherLow = false;
    let higherHigh = false;
    let upperBreakoutHold = false;

    if (candles.length >= 10) {
        const recent = candles.slice(-5);
        const prev = candles.slice(-10, -5);
        const recentHigh = Math.max(...recent.map((c) => c.high));
        const prevHigh = Math.max(...prev.map((c) => c.high));
        const recentLow = Math.min(...recent.map((c) => c.low));
        const prevLow = Math.min(...prev.map((c) => c.low));
        higherLow = recentLow > prevLow;
        higherHigh = recentHigh > prevHigh;
        const lastPrice = Number(sn.lastPrice ?? candles[candles.length - 1]?.close ?? 0);
        const boxHigh = Number(sn.boxHigh ?? 0);
        if (boxHigh > 0 && lastPrice >= boxHigh * 0.998) {
            const recentMin = Math.min(...recent.map((c) => c.low));
            upperBreakoutHold = recentMin >= boxHigh * 0.998;
        }
    }

    upperBreakoutHold =
        upperBreakoutHold ||
        (sn as { box_upper_breakout_hold?: boolean }).box_upper_breakout_hold === true ||
        (sn as { upper_breakout_hold?: boolean }).upper_breakout_hold === true;

    const htfPolicy = resolveHtfPolicyLabel(input);

    const trendDominant =
        Number.isFinite(canonicalTrendScore) &&
        canonicalTrendScore >= 0.55 &&
        Number.isFinite(emaGap) &&
        emaGap > 0 &&
        Number.isFinite(trendWeakness) &&
        trendWeakness < 0.55;

    const structuralRecovery =
        (higherLow || higherHigh) &&
        upperBreakoutHold &&
        isHtfPolicyCompatibleWithCandidateSide(htfPolicy, "long");

    return {
        trendScore: canonicalTrendScore,
        emaGap,
        higherLow,
        higherHigh,
        upperBreakoutHold,
        htfPolicy,
        trendDominant,
        structuralRecovery
    };
}

function resolveHtfPolicyLabel(input: EngineV2Input): string {
    const sn = input.snapshot ?? ({} as EngineV2Input["snapshot"]);
    const fromSnap = String(
        (sn as { htf_entry_policy?: string }).htf_entry_policy ??
            (sn as { htfEntryPolicy?: string }).htfEntryPolicy ??
            (sn as { htf_policy?: string }).htf_policy ??
            ""
    ).trim();
    if (fromSnap) return fromSnap.toUpperCase();

    const route = String((sn as { htfRouting?: string }).htfRouting ?? (sn as { htf_route?: string }).htf_route ?? "").toUpperCase();
    if (route === "TREND") return "ALLOW";

    const macro = String((sn as { macroPolarity?: string }).macroPolarity ?? "").toUpperCase();
    if (macro === "BULLISH") return "LONG_ONLY_OR_NONE";

    const htfPack = input.htf_candles ?? sn.htf_candles ?? {};
    const h1 = (htfPack as Record<string, Candle[]>)["1h"] ?? [];
    if (h1.length >= 4) {
        const last = h1[h1.length - 1]?.close;
        const prior = h1[h1.length - 4]?.close;
        if (Number.isFinite(last) && Number.isFinite(prior) && (last as number) > (prior as number)) {
            return "ALLOW";
        }
    }
    return "UNKNOWN";
}

export function evaluateStaleDownShockCrashReleaseAuthority(args: Readonly<{
    input: EngineV2Input;
    previousShockState: string;
    previousCrashState: string;
    activeDirection: "UP" | "DOWN" | "NONE" | "UNKNOWN";
    rawDirection: "UP" | "DOWN" | "NONE" | "UNKNOWN";
    neutralCount: number;
    activatedAt: number | null;
    emergencyBypass: boolean;
    nowMs: number;
    earlyDecayEligible: boolean;
    earlyDecayReason: string;
}>): Readonly<{
    releaseEligible: boolean;
    releaseReason: string | null;
    hardRearm: boolean;
    hardRearmReason: string | null;
    finalShockState: "UP" | "DOWN" | "NONE" | "UNKNOWN";
    finalCrashState: string;
    metrics: TrendRecoveryStructuralMetrics;
    persistenceSatisfied: boolean;
}> {
    const {
        input,
        previousShockState,
        previousCrashState,
        activeDirection,
        rawDirection,
        neutralCount,
        activatedAt,
        emergencyBypass,
        nowMs,
        earlyDecayEligible,
        earlyDecayReason
    } = args;

    const metrics = deriveTrendRecoveryStructuralMetrics(input);
    const live = evaluateLiveCrashPumpStates(input);
    const liveCrashOrd = crashOrder(live.crashState);
    const bridgeCrashOrd = crashOrder(previousCrashState);

    const downEmergencyActive =
        emergencyBypass && (rawDirection === "DOWN" || activeDirection === "DOWN");
    const hardRearm =
        downEmergencyActive ||
        liveCrashOrd >= CRASH_HARD_ORDER.CRASH_REDUCE ||
        live.crashState === "CRASH_EXIT" ||
        live.crashState === "CRASH_LOCK";

    if (hardRearm) {
        return {
            releaseEligible: false,
            releaseReason: null,
            hardRearm: true,
            hardRearmReason:
                liveCrashOrd >= CRASH_HARD_ORDER.CRASH_REDUCE
                    ? `LIVE_CRASH_${live.crashState}`
                    : "DOWN_EMERGENCY_BYPASS",
            finalShockState: liveCrashOrd >= CRASH_HARD_ORDER.CRASH_ALERT ? "DOWN" : activeDirection,
            finalCrashState: live.crashState !== "NONE" ? live.crashState : previousCrashState,
            metrics,
            persistenceSatisfied: false
        };
    }

    const staleDownShock =
        activeDirection === "DOWN" ||
        previousShockState === "DOWN" ||
        bridgeCrashOrd >= CRASH_HARD_ORDER.CRASH_EXIT;

    if (!staleDownShock) {
        return {
            releaseEligible: false,
            releaseReason: null,
            hardRearm: false,
            hardRearmReason: null,
            finalShockState: activeDirection,
            finalCrashState: previousCrashState,
            metrics,
            persistenceSatisfied: false
        };
    }

    const elapsedActive = activatedAt != null ? nowMs - activatedAt >= 45_000 : false;
    const neutralPersistence =
        rawDirection === "NONE" && neutralCount >= 2 && elapsedActive && activeDirection === "DOWN";

    const retestConfirmed = input.snapshot?.retestConfirmed === true;

    const persistenceSatisfied =
        earlyDecayEligible ||
        neutralPersistence ||
        (retestConfirmed && metrics.upperBreakoutHold);

    const recoveryBundle =
        metrics.trendDominant &&
        metrics.emaGap > 0 &&
        metrics.structuralRecovery;

    const releaseEligible = persistenceSatisfied && recoveryBundle;

    let releaseReason: string | null = null;
    if (releaseEligible) {
        if (earlyDecayEligible) releaseReason = `TREND_RECOVERY_${earlyDecayReason}`;
        else if (neutralPersistence) releaseReason = "TREND_RECOVERY_NEUTRAL_PERSISTENCE";
        else releaseReason = "TREND_RECOVERY_RETEST_UPPER_HOLD";
    }

    let finalShockState = activeDirection;
    let finalCrashState = previousCrashState;

    if (releaseEligible) {
        finalShockState = "NONE";
        if (bridgeCrashOrd >= CRASH_HARD_ORDER.CRASH_EXIT && liveCrashOrd <= CRASH_HARD_ORDER.CRASH_ALERT) {
            finalCrashState = liveCrashOrd >= CRASH_HARD_ORDER.CRASH_ALERT ? live.crashState : "NONE";
        } else if (bridgeCrashOrd >= CRASH_HARD_ORDER.CRASH_LOCK && liveCrashOrd === CRASH_HARD_ORDER.NONE) {
            finalCrashState = "NONE";
        }
    }

    return {
        releaseEligible,
        releaseReason,
        hardRearm: false,
        hardRearmReason: null,
        finalShockState,
        finalCrashState,
        metrics,
        persistenceSatisfied
    };
}

export function applyShockReleasedTrendRegimeAuthority(args: Readonly<{
    regimeFinal: EngineV2Regime;
    shockPhase: string;
    crashState: string;
    directionalShockState: string;
    snapshot: EngineV2Input["snapshot"];
    trendPhase: string;
}>): Readonly<{ regimeFinal: RegimeFinalAuthority | null; reason: string | null }> {
    const { regimeFinal, shockPhase, crashState, directionalShockState, snapshot, trendPhase } = args;
    if (regimeFinal === "NO_TRADE") return { regimeFinal: null, reason: null };

    const shockDown =
        shockPhase === "DOWN_SHOCK" ||
        String(directionalShockState ?? "NONE").toUpperCase() === "DOWN";
    const crashOrd = crashOrder(crashState);
    if (shockDown || crashOrd >= CRASH_HARD_ORDER.CRASH_EXIT) {
        return { regimeFinal: null, reason: null };
    }

    const inputStub = { snapshot, candles: snapshot?.candles ?? [] } as EngineV2Input;
    const metrics = deriveTrendRecoveryStructuralMetrics(inputStub);
    if (!metrics.trendDominant || !metrics.structuralRecovery) {
        return { regimeFinal: null, reason: null };
    }

    const tp = String(trendPhase ?? "").toUpperCase();
    const trendStructureOk =
        tp.includes("PULLBACK") ||
        tp.includes("CONTINUATION") ||
        tp.includes("TREND") ||
        metrics.trendScore >= 0.7;

    if (trendStructureOk && (regimeFinal === "RANGE" || regimeFinal === "TRANSITION")) {
        return { regimeFinal: "TREND", reason: "SHOCK_RELEASE_TREND_RECOVERY_AUTHORITY" };
    }
    return { regimeFinal: null, reason: null };
}

export function buildShockReleaseAuthorityProof(args: Readonly<{
    previousShockState: string;
    previousCrashState: string;
    release: ReturnType<typeof evaluateStaleDownShockCrashReleaseAuthority>;
    finalShockState: string;
    finalCrashState: string;
    finalRegime?: string;
    finalRouterExecutor?: string;
}>): ShockReleaseAuthorityProof {
    const { release } = args;
    const metrics = release.metrics;
    return {
        previous_shock_state: args.previousShockState,
        previous_crash_state: args.previousCrashState,
        trend_score: metrics.trendScore,
        ema_gap: metrics.emaGap,
        higher_low: metrics.higherLow,
        higher_high: metrics.higherHigh,
        upper_breakout_hold: metrics.upperBreakoutHold,
        htf_policy: metrics.htfPolicy,
        release_eligible: release.releaseEligible,
        release_reason: release.releaseReason,
        final_shock_state: args.finalShockState,
        final_crash_state: args.finalCrashState,
        final_regime: args.finalRegime,
        final_router_executor: args.finalRouterExecutor
    };
}
