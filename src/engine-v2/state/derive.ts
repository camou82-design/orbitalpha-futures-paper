import type { EngineV2Input, EngineV2Position, EngineV2Side } from "../types";
import type { Candle } from "../../models/types";
import type { V2StateAuthority } from "./types";

const DEFAULT_LIVE_MAX_ORDER_NOTIONAL_USDT = 100;

export interface EarlyDecayReclaimInfo {
    ts: number;
    cycleKey: any;
    direction: "bullish" | "bearish";
    boxPos: number;
    previousShock: "UP" | "DOWN";
    consumed: boolean;
}

interface ShockState {
    activeDirection: "UP" | "DOWN" | "NONE" | "UNKNOWN";
    rawDirection: "UP" | "DOWN" | "NONE" | "UNKNOWN";
    candidateDirection: "UP" | "DOWN" | "NONE" | "UNKNOWN";
    candidateCount: number;
    neutralCount: number;
    candidateStartedAt: number | null;
    activatedAt: number | null;
    lastChangedAt: number;
    rawMovePct: number;
    requiredMovePct: number;
    emergencyBypass: boolean;
    lastProcessedCycle: number | string;
    lastEarlyDecayReclaim?: EarlyDecayReclaimInfo | null;
}

export const globalShockStates = new Map<string, ShockState>();

export function getLastEarlyDecayReclaim(symbol: string): EarlyDecayReclaimInfo | null {
    const sym = String(symbol);
    const st = globalShockStates.get(sym);
    if (!st || !st.lastEarlyDecayReclaim) return null;
    return st.lastEarlyDecayReclaim;
}

export function consumeLastEarlyDecayReclaim(symbol: string): void {
    const sym = String(symbol);
    const st = globalShockStates.get(sym);
    if (st && st.lastEarlyDecayReclaim) {
        st.lastEarlyDecayReclaim.consumed = true;
    }
}

export function clearGlobalShockStates(symbol?: string): void {
    if (symbol) {
        globalShockStates.delete(String(symbol));
    } else {
        globalShockStates.clear();
    }
}

export function evaluateStructuralReclaimEarlyDecay(args: {
    activeDirection: "UP" | "DOWN" | "NONE" | "UNKNOWN";
    candles: ReadonlyArray<Candle>;
    snapshot: any;
}): { eligible: boolean; reason: string; closed1mCount: number; structuralReclaimed: boolean } {
    const { activeDirection, candles, snapshot } = args;
    if (activeDirection === "NONE" || activeDirection === "UNKNOWN" || !Array.isArray(candles) || candles.length < 2) {
        return { eligible: false, reason: "NO_ACTIVE_SHOCK_OR_INSUFFICIENT_CANDLES", closed1mCount: 0, structuralReclaimed: false };
    }

    const c1 = candles[candles.length - 2];
    const c2 = candles[candles.length - 1];
    if (!c1 || !c2 || !Number.isFinite(c1.close) || !Number.isFinite(c2.close)) {
        return { eligible: false, reason: "INVALID_CANDLE_DATA", closed1mCount: 0, structuralReclaimed: false };
    }

    const lastPrice = Number(snapshot?.lastPrice ?? c2.close);
    const boxLow = Number(snapshot?.boxLow ?? 0);
    const boxHigh = Number(snapshot?.boxHigh ?? 0);
    const ema20 = Number(snapshot?.ema20 ?? 0);
    const ema60 = Number(snapshot?.ema60 ?? 0);

    if (activeDirection === "DOWN") {
        // Bullish Reversal from DOWN shock:
        // 1. Two consecutive closed 1m candles showing bullish progression
        const c1Bullish = c1.close >= c1.open || c1.close > (candles[candles.length - 3]?.close ?? c1.open);
        const c2Bullish = c2.close >= c2.open && c2.close >= c1.close;
        const twoClosed1mConfirm = c1Bullish && c2Bullish;
        const closedCount = twoClosed1mConfirm ? 2 : (c2Bullish ? 1 : 0);

        if (!twoClosed1mConfirm) {
            return { eligible: false, reason: "TWO_CLOSED_1M_BULLISH_NOT_CONFIRMED", closed1mCount: closedCount, structuralReclaimed: false };
        }

        // 2. Authoritative Bullish Structural Reclaim:
        // Reclaimed back inside/above boxLow, OR reclaimed above EMA20 / EMA60, OR broke above prior candle high with box support
        const boxLowReclaimed = boxLow > 0 && lastPrice >= boxLow;
        const emaReclaimed = ema20 > 0 && lastPrice >= ema20;
        const higherHighReclaimed = c2.close > c1.high && (boxLowReclaimed || emaReclaimed || (ema60 > 0 && lastPrice >= ema60));
        const structuralReclaimed = boxLowReclaimed || emaReclaimed || higherHighReclaimed;

        if (!structuralReclaimed) {
            return { eligible: false, reason: "BULLISH_STRUCTURAL_RECLAIM_NOT_CONFIRMED", closed1mCount: closedCount, structuralReclaimed: false };
        }

        return { eligible: true, reason: "BULLISH_STRUCTURAL_RECLAIM_EARLY_DECAY", closed1mCount: closedCount, structuralReclaimed: true };
    } else if (activeDirection === "UP") {
        // Bearish Reversal from UP shock:
        // 1. Two consecutive closed 1m candles showing bearish progression
        const c1Bearish = c1.close <= c1.open || c1.close < (candles[candles.length - 3]?.close ?? c1.open);
        const c2Bearish = c2.close <= c2.open && c2.close <= c1.close;
        const twoClosed1mConfirm = c1Bearish && c2Bearish;
        const closedCount = twoClosed1mConfirm ? 2 : (c2Bearish ? 1 : 0);

        if (!twoClosed1mConfirm) {
            return { eligible: false, reason: "TWO_CLOSED_1M_BEARISH_NOT_CONFIRMED", closed1mCount: closedCount, structuralReclaimed: false };
        }

        // 2. Authoritative Bearish Structural Reclaim:
        // Reclaimed back inside/below boxHigh, OR fell below EMA20 / EMA60, OR broke below prior candle low with box resistance
        const boxHighReclaimed = boxHigh > 0 && lastPrice <= boxHigh;
        const emaReclaimed = ema20 > 0 && lastPrice <= ema20;
        const lowerLowReclaimed = c2.close < c1.low && (boxHighReclaimed || emaReclaimed || (ema60 > 0 && lastPrice <= ema60));
        const structuralReclaimed = boxHighReclaimed || emaReclaimed || lowerLowReclaimed;

        if (!structuralReclaimed) {
            return { eligible: false, reason: "BEARISH_STRUCTURAL_RECLAIM_NOT_CONFIRMED", closed1mCount: closedCount, structuralReclaimed: false };
        }

        return { eligible: true, reason: "BEARISH_STRUCTURAL_RECLAIM_EARLY_DECAY", closed1mCount: closedCount, structuralReclaimed: true };
    }

    return { eligible: false, reason: "UNKNOWN", closed1mCount: 0, structuralReclaimed: false };
}

export function inferIntentSide(input: EngineV2Input): EngineV2Side {
    if (input.symbol === "BTCUSDT") {
        if (input.state.okxActualSide === "long") return "long";
        if (input.state.okxActualSide === "short") return "short";

        const rawPositions = Array.isArray(input.state.currentPositions) ? input.state.currentPositions : [];
        const btcPositions = rawPositions.filter(p => p != null && p.symbol === "BTCUSDT");
        const hasLong = btcPositions.some(p => String(p.side).toLowerCase() === "long");
        const hasShort = btcPositions.some(p => String(p.side).toLowerCase() === "short");
        if (hasLong && !hasShort) return "long";
        if (hasShort && !hasLong) return "short";
        if (hasLong && hasShort) {
            const first = btcPositions[0];
            return String(first.side).toLowerCase() === "long" ? "long" : "short";
        }
        return "none";
    }

    const shock = input.state.directionalShockState ?? "NONE";
    const s = input.snapshot?.signal ?? "none";
    let side: EngineV2Side = "none";

    if (s === "paper_long_candidate") side = "long";
    else if (s === "paper_short_candidate") side = "short";
    else {
        const emaGap = Number(input.snapshot?.emaGap ?? 0);
        if (emaGap > 0) side = "long";
        else if (emaGap < 0) side = "short";
    }

    // DOWN shock에서는 long 배제, UP shock에서는 short 배제
    if (shock === "DOWN" && side === "long") return "none";
    if (shock === "UP" && side === "short") return "none";

    return side;
}

/** Held/open-position management side: OKX actual first, then sole ledger open side. */
export function resolveHeldPositionSide(
    input: EngineV2Input,
    longPosition: EngineV2Position | null,
    shortPosition: EngineV2Position | null
): EngineV2Side {
    const okx = String(input.state.okxActualSide ?? "").toLowerCase();
    if (okx === "long") return "long";
    if (okx === "short") return "short";

    if (longPosition && !shortPosition) return "long";
    if (shortPosition && !longPosition) return "short";
    if (longPosition && shortPosition) {
        return toSideLower(longPosition);
    }
    return "none";
}

function toSideLower(p: EngineV2Position): "long" | "short" | "none" {
    const side = String(p.side).toLowerCase();
    if (side === "long") return "long";
    if (side === "short") return "short";
    return "none";
}

function ledgerNotionalKrw(positions: EngineV2Position[]): number {
    return Math.round(
        positions.reduce((acc, p) => acc + Math.max(0, Number(p.sizeUsd ?? 0)), 0)
    );
}

export function resolvePositionStateForSide(
    v2State: V2StateAuthority,
    side: EngineV2Side
): Readonly<{
    side: EngineV2Side;
    sameSidePosition: EngineV2Position | null;
    oppositeSidePosition: EngineV2Position | null;
    hasSameSidePosition: boolean;
    hasOppositeSidePosition: boolean;
    currentStage: number;
}> {
    const sameSidePosition =
        side === "long"
            ? v2State.longPosition
            : side === "short"
                ? v2State.shortPosition
                : null;
    const oppositeSidePosition =
        side === "long"
            ? v2State.shortPosition
            : side === "short"
                ? v2State.longPosition
                : null;
    const currentStage =
        side === "long"
            ? v2State.longStage
            : side === "short"
                ? v2State.shortStage
                : 0;
    return {
        side,
        sameSidePosition,
        oppositeSidePosition,
        hasSameSidePosition: sameSidePosition != null,
        hasOppositeSidePosition: oppositeSidePosition != null,
        currentStage
    };
}

export function deriveV2StateAuthority(input: EngineV2Input): V2StateAuthority {
    const rawPositions = Array.isArray(input.state.currentPositions) ? input.state.currentPositions : [];
    const currentPositions = rawPositions.filter((p) => p != null);
    const symbol = input.symbol;
    const symbolPositions = currentPositions.filter((p) => p.symbol === symbol);
    const candidateIntentSide = inferIntentSide(input);
    const longPosition = symbolPositions.find((p) => toSideLower(p) === "long") ?? null;
    const shortPosition = symbolPositions.find((p) => toSideLower(p) === "short") ?? null;
    const longStage = longPosition ? Math.max(1, Number(longPosition.entryStage ?? 1)) : 0;
    const shortStage = shortPosition ? Math.max(1, Number(shortPosition.entryStage ?? 1)) : 0;
    const heldPositionSide = resolveHeldPositionSide(input, longPosition, shortPosition);
    const managementSide = heldPositionSide;
    const heldPositionState = resolvePositionStateForSide(
        { longPosition, shortPosition, longStage, shortStage } as V2StateAuthority,
        heldPositionSide
    );
    const sameSidePosition = heldPositionState.sameSidePosition;
    const oppositeSidePosition = heldPositionState.oppositeSidePosition;
    const currentStage = heldPositionState.currentStage;
    const hasOppositeToCandidate =
        heldPositionSide !== "none" &&
        candidateIntentSide !== "none" &&
        heldPositionSide !== candidateIntentSide;
    const marketSnapshotReady =
        input.snapshot != null &&
        Number.isFinite(input.snapshot.lastPrice) &&
        input.snapshot.lastPrice > 0 &&
        Number.isFinite(input.snapshot.latestCandleClose);
    const positionStateReady = Array.isArray(input.state.currentPositions);
    const v2InputReady = marketSnapshotReady && positionStateReady;
    const killSwitch = input.state.killSwitch === true || input.state.killSwitchActive === true;
    const reconcileSafeMode = input.state.reconcileSafeMode === true || input.state.reconcileSafeModeActive === true;
    const crashState = String(input.state.crashState ?? "NONE").toUpperCase();
    const pumpState = String(input.state.pumpState ?? input.state.pump_state ?? "NONE").toUpperCase();
    return {
        symbol,
        now: input.now,
        currentPositions,
        symbolPositions,
        longPosition,
        shortPosition,
        hasLongPosition: longPosition != null,
        hasShortPosition: shortPosition != null,
        longStage,
        shortStage,
        sameSidePosition,
        oppositeSidePosition,
        hasSameSidePosition: heldPositionState.hasSameSidePosition,
        hasOppositeSidePosition: heldPositionState.hasOppositeSidePosition,
        currentStage,
        positionStateReady,
        marketSnapshotReady,
        v2InputReady,
        serverTradeEnabled: input.state.serverTradeEnabled !== false,
        closeOnlyMode: input.state.closeOnlyMode === true,
        killSwitch,
        reconcileSafeMode,
        riskMode: input.state.riskMode ?? null,
        dailyLossGuardTriggered: input.state.dailyLossGuardTriggered === true,
        freshTickBarrierActive: input.state.freshTickBarrierActive === true,
        freshTickExecutionBlocked: input.state.freshTickExecutionBlocked === true,
        freshTickCompletedCycles: Number.isFinite(input.state.freshTickCompletedCycles) ? input.state.freshTickCompletedCycles : 0,
        freshTickRequiredCycles: Number.isFinite(input.state.freshTickRequiredCycles) ? input.state.freshTickRequiredCycles : 0,
        paperExecutionReady: input.state.paperExecutionReady === true,
        signedExecutionReady: input.state.signedExecutionReady === true,
        okxAuthMode: input.state.okxAuthMode ?? "disabled",
        okxAuthReady: input.state.okxAuthReady === true,
        okxExchangeAuthOptIn: input.state.okxExchangeAuthOptIn === true,
        okxLiveEnabled: input.state.okxLiveEnabled === true,
        okxDemoEnabled: input.state.okxDemoEnabled === true,
        okxApiKeyPresent: input.state.okxApiKeyPresent === true,
        okxApiSecretPresent: input.state.okxApiSecretPresent === true,
        okxPassphrasePresent: input.state.okxPassphrasePresent === true,
        okxSimulatedTradingHeaderEnabled: input.state.okxSimulatedTradingHeaderEnabled === true,
        liveMaxOrderNotionalUsdt: ((): number => {
            const raw = input.state.liveMaxOrderNotionalUsdt;
            if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
            const configFallback = input.config.okxLiveMaxOrderNotionalUsdt;
            if (typeof configFallback === "number" && Number.isFinite(configFallback) && configFallback > 0) return configFallback;
            return DEFAULT_LIVE_MAX_ORDER_NOTIONAL_USDT;
        })(),
        ...((): {
            directionalShockState: "UP" | "DOWN" | "NONE" | "UNKNOWN";
            rawDirectionalShockState: "UP" | "DOWN" | "NONE" | "UNKNOWN";
            stabilizedDirectionalShockState: "UP" | "DOWN" | "NONE" | "UNKNOWN";
            rawShockMovePct: number;
            requiredShockMovePct: number;
            shockEmergencyBypass: boolean;
            longAllow: boolean;
            shortAllow: boolean;
        } => {
            const raw = (input.state.directionalShockState ?? "NONE") as "UP" | "DOWN" | "NONE" | "UNKNOWN";

            // Get symbol-specific state store or initialize
            const sym = String(symbol);
            if (!globalShockStates.has(sym)) {
                const initialActive = (raw === "UP" || raw === "DOWN") ? raw : "NONE";
                globalShockStates.set(sym, {
                    activeDirection: initialActive,
                    rawDirection: initialActive,
                    candidateDirection: "NONE",
                    candidateCount: 0,
                    neutralCount: 0,
                    candidateStartedAt: null,
                    activatedAt: initialActive !== "NONE" ? Date.now() : null,
                    lastChangedAt: Date.now(),
                    rawMovePct: 0,
                    requiredMovePct: 0,
                    emergencyBypass: false,
                    lastProcessedCycle: 0
                });
            }

            const originalSt = globalShockStates.get(sym)!;
            const isDiagnostic = (input as any).evaluationMode === "diagnostic";
            const st = isDiagnostic ? { ...originalSt } : originalSt;

            const nowMs = input.now || Date.now();

            const candles = input.candles || input.snapshot?.candles || [];
            const latestCandleTs = candles.length > 0 ? Number(candles[candles.length - 1]?.ts ?? 0) : 0;
            const cycleKey =
                (input as any).runCycleId ??
                (input.state as any)?.run_cycle_id ??
                (input.snapshot as any)?.fetchedAt ??
                (input.snapshot as any)?.snapshot_fetched_at ??
                (latestCandleTs > 0 ? latestCandleTs : null) ??
                nowMs;

            const isNewCycle = st.lastProcessedCycle !== cycleKey;
            st.lastProcessedCycle = cycleKey;

            // Setup variables
            st.rawDirection = raw === "UNKNOWN" ? "NONE" : raw;
            if (st.rawDirection !== "NONE") {
                st.neutralCount = 0;
            }

            // Calculate raw move magnitude if candles are available
            let rawMovePct = 0;
            if (candles.length >= 16) {
                const latestClose = candles[candles.length - 1].close;
                const prevClose = candles[candles.length - 16].close;
                rawMovePct = Math.abs((latestClose - prevClose) / prevClose);
            }
            st.rawMovePct = rawMovePct;

            // Calculate required move limit based on ATR or floor (0.12%)
            const atr = input.snapshot?.atr || 0;
            const lastPrice = input.snapshot?.lastPrice || 1;
            const atrPct = atr / lastPrice;
            const requiredMovePct = Math.max(0.0012, atrPct * 0.65);
            st.requiredMovePct = requiredMovePct;

            // Emergency bypass criteria: 0.35% absolute move OR ATR 1.8x breach OR Volume surge 2.5x with ATR expansion 1.4x
            let emergencyBypass = false;
            if (candles.length >= 6) {
                const latestClose = candles[candles.length - 1].close;
                const prevClose = candles[candles.length - 6].close;
                const signedMove5m = (latestClose - prevClose) / prevClose;
                const move5m = Math.abs(signedMove5m);
                const volumeExpansion = input.snapshot?.volumeExpansion ?? 1.0;
                const atrExpansion = input.snapshot?.atrExpansion ?? 1.0;

                const atrSeverity = atr > 0 ? Math.abs(latestClose - prevClose) / atr : 0;
                if (move5m >= 0.0035 || atrSeverity >= 1.8 || (volumeExpansion >= 2.5 && atrExpansion >= 1.4)) {
                    if ((st.rawDirection === "UP" && signedMove5m > 0) || (st.rawDirection === "DOWN" && signedMove5m < 0)) {
                        emergencyBypass = true;
                    }
                }
            }
            st.emergencyBypass = emergencyBypass;

            const prevActive = st.activeDirection;
            let activationBlockReason = "";
            let stateChanged = false;

            // Structural Reclaim Early Decay: If an active shock exists, check if 2 opposite closed 1m candles + structural reclaim have confirmed
            if (st.activeDirection === "UP" || st.activeDirection === "DOWN") {
                const earlyDecay = evaluateStructuralReclaimEarlyDecay({
                    activeDirection: st.activeDirection,
                    candles,
                    snapshot: input.snapshot
                });

                if (earlyDecay.eligible) {
                    st.activeDirection = "NONE";
                    st.candidateDirection = "NONE";
                    st.candidateCount = 0;
                    st.neutralCount = 0;
                    st.candidateStartedAt = null;
                    st.activatedAt = null;
                    st.lastChangedAt = nowMs;
                    st.lastEarlyDecayReclaim = {
                        ts: nowMs,
                        cycleKey,
                        direction: prevActive === "DOWN" ? "bullish" : "bearish",
                        boxPos: Number(input.snapshot?.boxPos ?? 0),
                        previousShock: prevActive as "UP" | "DOWN",
                        consumed: false
                    };
                    stateChanged = true;

                    console.info(JSON.stringify({
                        event: "V2_SHOCK_STRUCTURAL_RECLAIM_EARLY_DECAY_PROOF",
                        symbol: sym,
                        previous_shock: prevActive,
                        early_decay_applied: true,
                        early_decay_reason: earlyDecay.reason,
                        closed_1m_count: earlyDecay.closed1mCount,
                        structural_reclaimed: earlyDecay.structuralReclaimed,
                        ts: nowMs
                    }));
                }
            }

            if (st.rawDirection !== "NONE") {
                // If there's an active shock and raw direction has flipped to the opposite
                const isOpposite = (st.activeDirection === "UP" && st.rawDirection === "DOWN") ||
                                   (st.activeDirection === "DOWN" && st.rawDirection === "UP");

                if (isOpposite && !st.emergencyBypass) {
                    // Prevent direct flip without emergency bypass -> treat it as normal candidate flow from NONE
                    activationBlockReason = "DIRECT_FLIP_PROHIBITED_WITHOUT_BYPASS";
                } else if (st.emergencyBypass) {
                    // Emergency bypass: instantly activate
                    if (st.activeDirection !== st.rawDirection) {
                        st.activeDirection = st.rawDirection;
                        st.activatedAt = nowMs;
                        st.lastEarlyDecayReclaim = null;
                    }
                    st.candidateDirection = "NONE";
                    st.candidateCount = 0;
                    st.neutralCount = 0;
                    st.candidateStartedAt = null;
                    st.lastChangedAt = nowMs;
                } else {
                    // Normal activation flow
                    if (st.candidateDirection !== st.rawDirection) {
                        st.candidateDirection = st.rawDirection;
                        st.candidateCount = 1;
                        st.candidateStartedAt = nowMs;
                    } else if (isNewCycle) {
                        st.candidateCount++;
                    }

                    const elapsedCand = st.candidateStartedAt ? (nowMs - st.candidateStartedAt) >= 30000 : false;
                    const magnitudePassed = st.rawMovePct >= st.requiredMovePct;

                    if (st.candidateCount >= 2 && elapsedCand && magnitudePassed) {
                        if (st.activeDirection !== st.rawDirection) {
                            st.activeDirection = st.rawDirection;
                            st.activatedAt = nowMs;
                        }
                        st.lastChangedAt = nowMs;
                    } else {
                        if (st.candidateCount < 2) activationBlockReason = "INSUFFICIENT_CONSECUTIVE_RAW_COUNT";
                        else if (!elapsedCand) activationBlockReason = "MINIMUM_DURATION_NOT_MET";
                        else if (!magnitudePassed) activationBlockReason = "MINIMUM_MOVE_THRESHOLD_NOT_MET";
                    }
                }
            } else {
                // Raw is NONE: evaluation for release/deactivation
                if (st.activeDirection !== "NONE") {
                    if (isNewCycle) {
                        st.neutralCount++;
                    }
                    const elapsedActive = st.activatedAt ? (nowMs - st.activatedAt) >= 45000 : false;

                    if (st.neutralCount >= 2 && elapsedActive) {
                        st.activeDirection = "NONE";
                        st.candidateDirection = "NONE";
                        st.candidateCount = 0;
                        st.neutralCount = 0;
                        st.candidateStartedAt = null;
                        st.activatedAt = null;
                        st.lastChangedAt = nowMs;
                    }
                } else {
                    st.candidateDirection = "NONE";
                    st.candidateCount = 0;
                    st.neutralCount = 0;
                    st.candidateStartedAt = null;
                }
            }

            if (st.activeDirection !== prevActive) {
                stateChanged = true;
            }

            // V2_DIRECTIONAL_SHOCK_STABILIZATION_PROOF diagnostic log
            console.info(JSON.stringify({
                event: "V2_DIRECTIONAL_SHOCK_STABILIZATION_PROOF",
                symbol: sym,
                raw_direction: st.rawDirection,
                stable_direction_before: prevActive,
                stable_direction_after: st.activeDirection,
                candidate_direction: st.candidateDirection,
                candidate_count: st.candidateCount,
                neutral_count: st.neutralCount,
                raw_move_pct: st.rawMovePct,
                required_move_pct: st.requiredMovePct,
                magnitude_passed: st.rawMovePct >= st.requiredMovePct,
                emergency_bypass: st.emergencyBypass,
                activation_block_reason: activationBlockReason || null,
                state_changed: stateChanged,
                ts: nowMs
            }));

            const stabilizedShock = st.activeDirection;
            const hardCrashBlocked = crashState === "CRASH_EXIT" || crashState === "CRASH_LOCK";
            const hardPumpBlocked = pumpState === "PUMP_EXIT" || pumpState === "PUMP_LOCK";
            const dailyLossBlocked = input.state.dailyLossGuardTriggered === true;
            const serverControlBlocked =
                input.state.serverTradeEnabled === false ||
                input.state.closeOnlyMode === true ||
                input.state.killSwitch === true ||
                (input.state as any)?.killSwitchActive === true ||
                (input.state as any)?.reconcileSafeMode === true ||
                (input.state as any)?.reconcileSafeModeActive === true ||
                input.state.riskMode === "HALT";

            let derivedLongAllow = true;
            let derivedShortAllow = true;

            if (serverControlBlocked || dailyLossBlocked) {
                derivedLongAllow = false;
                derivedShortAllow = false;
            } else {
                if (hardCrashBlocked) {
                    derivedLongAllow = false;
                }
                if (hardPumpBlocked) {
                    derivedShortAllow = false;
                }

                if (stabilizedShock === "UP") {
                    derivedShortAllow = false;
                } else if (stabilizedShock === "DOWN") {
                    derivedLongAllow = false;
                } else {
                    if (input.state.longAllow === false) {
                        derivedLongAllow = false;
                    }
                    if (input.state.shortAllow === false) {
                        derivedShortAllow = false;
                    }
                }
            }

            return {
                directionalShockState: st.activeDirection,
                rawDirectionalShockState: raw,
                stabilizedDirectionalShockState: st.activeDirection,
                rawShockMovePct: st.rawMovePct,
                requiredShockMovePct: st.requiredMovePct,
                shockEmergencyBypass: st.emergencyBypass,
                longAllow: derivedLongAllow,
                shortAllow: derivedShortAllow
            };
        })(),
        crashState,
        pumpState,
        accountEquityKrw: Number.isFinite(input.state.accountEquityKrw) ? Number(input.state.accountEquityKrw) : 500_000,
        maxUsableMarginKrw: Number.isFinite(input.state.maxUsableMarginKrw) ? Number(input.state.maxUsableMarginKrw) : 420_000,
        exposureNotionalCapKrw: Number.isFinite(input.state.exposureNotionalCapKrw) ? Number(input.state.exposureNotionalCapKrw) : 2_000_000,
        symbolExposureNotionalCapKrw: Number.isFinite(input.state.symbolExposureNotionalCapKrw) ? Number(input.state.symbolExposureNotionalCapKrw) : 1_400_000,
        ledgerExposureNotionalKrw: ledgerNotionalKrw(currentPositions),
        symbolLedgerExposureNotionalKrw: ledgerNotionalKrw(symbolPositions),
        lossStreaks: input.state.lossStreaks ?? {},
        entryQualityProfiles: input.state.entryQualityProfiles,
        stateAuthoritySource: "v2_state_authority_from_bridge",
        heldPositionSide,
        managementSide,
        candidateIntentSide,
        inferredIntentSide: candidateIntentSide,
        hasOppositeToCandidate,
        liveBalanceReady: input.state.liveBalanceReady,
        accountEquityUsdt: input.state.accountEquityUsdt,
        availableBalanceUsdt: input.state.availableBalanceUsdt,
        okxActualPositionsReady: input.state.okxActualPositionsReady,
        actualAccountNotionalUsdtReady: input.state.actualAccountNotionalUsdtReady,
        okxActualPositions: input.state.okxActualPositions,
        okxPendingOrdersReady: input.state.okxPendingOrdersReady,
        okxPendingOrdersNotionalUsdt: input.state.okxPendingOrdersNotionalUsdt,
        okxPendingSymbolNotionalUsdt: input.state.okxPendingSymbolNotionalUsdt,
        hasSymbolPendingEntry: (input.state as any).hasSymbolPendingEntry,
        hasUnknownPendingNotional: (input.state as any).hasUnknownPendingNotional,
        balanceFetchedAt: input.state.balanceFetchedAt,
        positionsFetchedAt: input.state.positionsFetchedAt,
        pendingOrdersFetchedAt: input.state.pendingOrdersFetchedAt,
        lastLossReentryState: input.state.lastLossReentryState ?? null,
        hasOperatorPendingOrders: (input.state as any)?.hasOperatorPendingOrders,
        manualTakeoverActive: (input.state as any)?.manualTakeoverActive
    };
}
