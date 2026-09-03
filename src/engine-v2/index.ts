import {
    EngineV2Input,
    EngineV2Decision,
    EngineV2InternalResult,
    EngineV2FinalDecision,
    EngineV2Side,
    ExecutorOutput,
    LegacySnapshotAdapter,
    LegacyConfigAdapter,
    LegacyPositionAdapter,
    LegacyResultAdapter,
    V2CommittedRiskPlan
} from "./types";
import { deriveTrendSideCandidate } from "./trend-side-candidate";
import { MarketSymbol, classifyRangeZone, rangeZoneLowerExtreme, rangeZoneUpperExtreme } from "../models/types";
import { evaluateSameSideLossReentryGate } from "./state/loss-reentry-gate";
import { applyV2ExitAuthorityInvariants, isExplicitTerminalExitReason } from "./exit/exit-authority-invariant";
import { resolveFinalExitAuthority, buildFinalExitAuthorityProof } from "./exit/final-exit-authority";
import { evaluateTerminalReentryBarrier, buildTerminalReentryBarrierProof, resolveTerminalBarrierContext } from "./lifecycle/terminal-reentry-barrier";
import { emitLiveExposureAuthorityProof, resolveLiveExposureAuthority } from "./live-account/exposure-authority";
import {
    evaluateEquityAdaptiveSizing,
    evaluateEquitySizingAuthority,
    buildEquitySizingAuthorityProof,
    buildRiskBasedNotionalProof,
    buildMarginCapacityProof,
    buildEquityAdaptiveSizingProof,
    MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
    MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE,
    MAX_ADVERSE_ADDON_EQUITY_MULTIPLE,
    MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE,
    RISK_PER_TRADE_PCT,
    resolveEffectiveLiveOrderNotionalCap,
    resolveUltimateSafetyCapForOrderSizing
} from "./risk-sizing/equity-adaptive-sizing";
import {
    applyExternalContextToConfidenceScore,
    buildExternalMarketContextProofLog,
    evaluateExternalMarketContext
} from "./external-market-context";
import {
    FTS_STRUCTURAL_STOP_BASIS,
    FTS_ABSOLUTE_SAFETY_MAX_STOP_PCT,
    getClosedCandlesForStructuralStop,
    isFastTrendShiftCanonicalStructuralStopBasis,
    buildFtsStructuralStopExecMetadata,
    resolveVerifiedFtsCanonicalStructuralStopAuthority,
    tryInheritFastTrendShiftStructuralStopFromDiag
} from "./risk-sizing/fast-trend-shift-structural-stop";
import { evaluateTpProfitabilityAuthority } from "./execution/tp-profitability-authority";
import {
    resolvePreEntryPolicySlPrice,
    resolveV2PreEntryExecutableTpBundle
} from "./execution/pre-entry-tp-provenance";

// Tier 5.6: Mandatory Risk Plan Audit (STOP_PRICE_MISSING Hard Block)
export function ensurePromotedEntryRiskPlan(
    execution: ExecutorOutput,
    v2DecisionAfterPromotion: EngineV2FinalDecision,
    v2SideAfterPromotion: EngineV2Side,
    v2CalculatedInvalidationPx: number | null,
    snapshot: any,
    judgment: ReturnType<typeof detectMarketRegime>,
    promotionReason: string | null,
    fixedBoundary: number | null = null
): string | null {
    if (v2DecisionAfterPromotion !== "ENTER") return null;
    const side = v2SideAfterPromotion;
    if (side !== "long" && side !== "short") return null;

    const entryPrice = Number(snapshot.lastPrice ?? 0);
    if (entryPrice <= 0) return null;

    const stopPriceBefore = execution.stopPrice;
    const invalidationPxBefore = execution.invalidationPx;

    const atrVal = Number(snapshot.atr ?? 0);
    const atrPct = atrVal / entryPrice;
    const maxStopDistancePct = Math.min(Math.max(atrPct * 3, 0.005), 0.03); // clamp between 0.5% and 3.0%
    const atrBuffer = atrVal * 0.5;

    // Build candidates list in priority order
    const rawCandidates: { source: string, price: number | null }[] = [];
    
    // 1. Existing executor stop
    rawCandidates.push({ source: "existing_valid", price: stopPriceBefore ?? invalidationPxBefore ?? null });
    
    // 2. continuation_watch_boundary_buffer
    if (fixedBoundary != null) {
        if (side === "long") {
            rawCandidates.push({ source: "continuation_watch_boundary_buffer", price: fixedBoundary * 0.998 });
        } else {
            rawCandidates.push({ source: "continuation_watch_boundary_buffer", price: fixedBoundary * 1.002 });
        }
    }
    
    // 3. v2CalculatedInvalidationPx
    rawCandidates.push({ source: "v2CalculatedInvalidationPx", price: v2CalculatedInvalidationPx });

    const boxLowVal = Number(snapshot.boxLow ?? entryPrice);
    const boxHighVal = Number(snapshot.boxHigh ?? entryPrice);
    
    let swingLowVal = entryPrice;
    let swingHighVal = entryPrice;
    const candles = snapshot.candles || [];
    if (candles.length > 0) {
        const recentLows = candles.slice(-20).map((c: any) => Number(c.low ?? c.l ?? entryPrice));
        swingLowVal = Math.min(...recentLows);
        const recentHighs = candles.slice(-20).map((c: any) => Number(c.high ?? c.h ?? entryPrice));
        swingHighVal = Math.max(...recentHighs);
    }

    if (side === "long") {
        rawCandidates.push({ source: "boxLow_buffer", price: boxLowVal > 0 && boxLowVal < entryPrice ? boxLowVal - atrBuffer : null });
        rawCandidates.push({ source: "swingLow_buffer", price: swingLowVal > 0 && swingLowVal < entryPrice ? swingLowVal - atrBuffer : null });
        rawCandidates.push({ source: "fallback_1.2pct", price: entryPrice * (1 - 0.012) });
    } else {
        rawCandidates.push({ source: "boxHigh_buffer", price: boxHighVal > entryPrice ? boxHighVal + atrBuffer : null });
        rawCandidates.push({ source: "swingHigh_buffer", price: swingHighVal > entryPrice ? swingHighVal + atrBuffer : null });
        rawCandidates.push({ source: "fallback_1.2pct", price: entryPrice * (1 + 0.012) });
    }


    const candidateStops = rawCandidates.map(c => {
        if (c.price == null || !Number.isFinite(c.price) || c.price <= 0) {
            return { source: c.source, price: c.price, directionValid: false, stopDistPct: 0, withinMaxDistance: false };
        }
        const directionValid = side === "long" ? c.price < entryPrice : c.price > entryPrice;
        const stopDistPct = Math.abs(entryPrice - c.price) / entryPrice;
        const withinMaxDistance = stopDistPct <= maxStopDistancePct;
        return { source: c.source, price: c.price, directionValid, stopDistPct, withinMaxDistance };
    });

    let selectedStopSource: string | null = null;
    let selectedStopPrice: number | null = null;

    const execMeta = (execution.metadata ?? {}) as Record<string, unknown>;
    const closedCandlesForFts = getClosedCandlesForStructuralStop(snapshot.candles || []);
    const boxHighValForFts = Number(snapshot.boxHigh ?? 0);
    const boxLowValForFts = Number(snapshot.boxLow ?? 0);
    const boxMidForFts =
        boxHighValForFts > 0 && boxLowValForFts > 0 ? (boxHighValForFts + boxLowValForFts) / 2 : null;
    const ftsResolverCrossCheck =
        closedCandlesForFts.length > 0 && atrVal > 0
            ? {
                  lastPrice: entryPrice,
                  atr: atrVal,
                  closedCandles: closedCandlesForFts,
                  boxMid: boxMidForFts,
                  previousConfirmedBoxHigh: boxHighValForFts > 0 ? boxHighValForFts : null,
                  previousConfirmedBoxLow: boxLowValForFts > 0 ? boxLowValForFts : null
              }
            : null;
    const ftsCanonicalAuthority = resolveVerifiedFtsCanonicalStructuralStopAuthority({
        side,
        entryPrice,
        stopPrice: stopPriceBefore,
        execMeta,
        fastTrendShiftDiag: judgment.diagnostics?.fastTrendShift ?? null,
        resolverCrossCheck: ftsResolverCrossCheck
    });
    const isFtsCanonicalStructuralStop = ftsCanonicalAuthority != null;

    if (isFtsCanonicalStructuralStop && ftsCanonicalAuthority != null) {
        const canonicalStop = ftsCanonicalAuthority.stopPrice;
        const stopDistPct = Math.abs(entryPrice - canonicalStop) / entryPrice;
        if (stopDistPct > FTS_ABSOLUTE_SAFETY_MAX_STOP_PCT) {
            selectedStopSource = null;
            selectedStopPrice = null;
        } else {
            selectedStopSource = "existing_valid";
            selectedStopPrice = canonicalStop;
        }
    } else {
        for (const c of candidateStops) {
            if (c.directionValid && c.withinMaxDistance) {
                selectedStopSource = c.source;
                selectedStopPrice = c.price;
                break;
            }
        }
    }

    const audit_passed = selectedStopPrice !== null;
    let blockReason: string | null = null;

    let closestInvalidSource: string | null = null;
    let closestInvalidPrice: number | null = null;
    let closestInvalidDistPct: number | null = null;

    if (!audit_passed) {
        const authorityStopSources = new Set([
            "existing_valid",
            "continuation_watch_boundary_buffer",
            "v2CalculatedInvalidationPx"
        ]);
        let hasFiniteDirectionValidStop = false;
        for (const c of candidateStops) {
            if (
                authorityStopSources.has(c.source) &&
                c.directionValid &&
                c.price != null &&
                Number.isFinite(c.price)
            ) {
                hasFiniteDirectionValidStop = true;
                break;
            }
        }
        if (
            ftsCanonicalAuthority != null &&
            Number.isFinite(ftsCanonicalAuthority.stopPrice) &&
            (side === "long"
                ? ftsCanonicalAuthority.stopPrice < entryPrice
                : ftsCanonicalAuthority.stopPrice > entryPrice)
        ) {
            hasFiniteDirectionValidStop = true;
        }
        blockReason = hasFiniteDirectionValidStop ? "STOP_DISTANCE_TOO_WIDE" : "STOP_PRICE_MISSING";
        let minDistance = Infinity;
        for (const c of candidateStops) {
            if (c.directionValid && c.price != null && c.stopDistPct < minDistance) {
                minDistance = c.stopDistPct;
                closestInvalidSource = c.source;
                closestInvalidPrice = c.price;
                closestInvalidDistPct = c.stopDistPct;
            }
        }
        if (ftsCanonicalAuthority != null) {
            closestInvalidSource = FTS_STRUCTURAL_STOP_BASIS;
            closestInvalidPrice = ftsCanonicalAuthority.stopPrice;
            closestInvalidDistPct = Math.abs(entryPrice - ftsCanonicalAuthority.stopPrice) / entryPrice;
        }
    }

    execution.stopPrice = selectedStopPrice;
    execution.invalidationPx = selectedStopPrice;

    const needsPatch =
        selectedStopSource !== "existing_valid" &&
        selectedStopSource !== FTS_STRUCTURAL_STOP_BASIS;

    if (needsPatch) {
        execution.metadata = {
            ...execution.metadata,
            promotedRiskPlanInjected: true,
            promotedRiskPlanSource: selectedStopSource ?? "none",
            promotedRiskPlanReason: promotionReason
        };
    } else if (isFtsCanonicalStructuralStop && ftsCanonicalAuthority != null) {
        execution.metadata = {
            ...execution.metadata,
            ...buildFtsStructuralStopExecMetadata(ftsCanonicalAuthority)
        };
    }

    console.info(JSON.stringify({
        event: "V2_PROMOTED_ENTRY_RISK_PLAN_PROOF",
        symbol: String(snapshot.symbol ?? ""),
        side,
        entryPrice,
        stopPriceBefore,
        invalidationPxBefore,
        stopPriceAfter: selectedStopPrice,
        invalidationPxAfter: selectedStopPrice,
        source: selectedStopSource ?? "none",
        promotionReason,
        auditEligible: needsPatch,
        blockReason,
        candidateStops,
        selectedStopSource,
        selectedStopPrice,
        maxStopDistancePct,
        atrPct,
        ...(blockReason === "STOP_DISTANCE_TOO_WIDE" && {
            closestInvalidStopSource: closestInvalidSource,
            closestInvalidStopPrice: closestInvalidPrice,
            closestInvalidStopDistPct: closestInvalidDistPct
        })
    }));

    return blockReason;
}
import { detectMarketRegime, emitRangeDriftStateProof } from "./market-judgment/detector";
import { detectStairStepStructure } from "./market-judgment/stair-step-detector";
import { calculateRegimeConfidence } from "./regime-confidence/scorer";
import { routeToExecutor } from "./engine-router/selector";
import { executeRangeRegime, rangeContinuationStateMap } from "./executors/range-executor";
import { executeTrendRegime, calculateAuthoritativeTrendStructuralStop } from "./executors/trend-executor";
import { executeTransitionRegime } from "./executors/transition-executor";
import { calculateRiskSizing } from "./risk-sizing/policy";
import { generateExplanation } from "./explain/diagnostic";
import { deriveV2StateAuthority, getLastEarlyDecayReclaim, consumeLastEarlyDecayReclaim } from "./state/derive";
import { evaluateV2AddOnPolicy } from "./addon/policy";
import { buildV2AddonEligibilityProof } from "./addon/eligibility-proof";
import { evaluateV2ExitPolicy } from "./exit/policy";
import {
    buildPnlStopMeaningfulMoveGateProof
} from "./exit/pnl-stop-gate";
import {
    buildSoftExitFeeGateProof,
    computeGrossReturnPct
} from "./exit/soft-exit-fee-gate";
import { evaluateV2ExitPolicySoftExitFeeGate } from "./exit/soft-exit-fee-live-bridge";
import { deriveMicroExecutionScore } from "./execution/micro-execution-score";
import { deriveTradeLifecycleAuthority } from "./lifecycle/trade-lifecycle-authority";
import type { MicroExecutionScoreSummary, V2ExitAuthorityResult, V2PartialAuthorityResult, V2TradeLifecycleAuthorityResult, V2CooldownAuthorityResult, V2PositionStateAuthorityResult } from "./types";
import {
    evaluateLowerBreakdownShortConfirmed,
    evaluateUpperBreakoutLongConfirmed,
    type RangeBoundaryContinuationContext
} from "./range-boundary-continuation";
import { evaluateFastTrendShiftUpperLongZoneConfirmed } from "./market-judgment/fast-trend-shift-upper-long-authority";
import { evaluateFastTrendShiftLowerShortZoneConfirmed } from "./market-judgment/fast-trend-shift-lower-short-authority";

const V2_PROOF_KEY_TTL_MS = 60 * 60 * 1000;
const V2_PROOF_KEY_MAX_SIZE = 5000;
const MICRO_EXECUTION_PERF_LOG_INTERVAL_MS = 5 * 60 * 1000;
const v2ProofLastKeyByEventSymbol = new Map<string, { key: string; updatedAtMs: number }>();

export interface DeadlockHistoryItem {
    timestamp: number;
    decision: string;
    side: string;
    qualityScore: number;
    grade: string;
    softBlockReason: string | null;
    hardBlockPresent: boolean;
    readinessOk: boolean;
    stopPlanOk: boolean;
    htfPolicy: string;
    zone: string;
    sideZoneValid: boolean;
}

const symbolHistoryMap = new Map<string, DeadlockHistoryItem[]>();
const symbolLastV2EnterDecisionAtMap = new Map<string, number>();
const symbolLastPositionOpenedAtMap = new Map<string, number>();
const symbolCyclesSinceLastEnterMap = new Map<string, number>();
const symbolLastProbeAtMap = new Map<string, number>();
const symbolLastProbeSideMap = new Map<string, string>();
const symbolLastProbeQualityMap = new Map<string, number>();
const symbolLastProbeStructureMap = new Map<string, string>();
export interface MarketJudgmentCache {
    runCycleId: string;
    judgment: ReturnType<typeof detectMarketRegime>;
    candleCount: number;
}
export const marketJudgmentCacheBySymbol = new Map<string, MarketJudgmentCache>();
const symbolHasPositionMap = new Map<string, boolean>();
const symbolLastDeadlockAuditLoggedAtMap = new Map<string, number>();
const symbolDeadlockAuditCycleMap = new Map<string, number>();

let isHistoryLoaded = false;

function loadLastEnterAtFromHistory(): void {
    if (isHistoryLoaded) return;
    try {
        const fs = require("fs");
        const path = require("path");
        const cwd = process.cwd();
        const possiblePaths = [
            path.join(cwd, "data/positions/history.json"),
            path.join(__dirname, "../../data/positions/history.json"),
            path.join(__dirname, "../data/positions/history.json")
        ];
        
        let fileContent = "";
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                fileContent = fs.readFileSync(p, "utf8");
                break;
            }
        }
        
        if (fileContent) {
            const history = JSON.parse(fileContent);
            if (Array.isArray(history)) {
                for (let i = history.length - 1; i >= 0; i--) {
                    const item = history[i];
                    if (item && item.symbol && typeof item.openedAt === "number") {
                        if (!symbolLastPositionOpenedAtMap.has(item.symbol)) {
                            symbolLastPositionOpenedAtMap.set(item.symbol, item.openedAt);
                            console.info(`V2_DEADLOCK_RESOLVER: Restored lastPositionOpenedAt for ${item.symbol} = ${item.openedAt}`);
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error("V2_DEADLOCK_RESOLVER: Failed to load lastPositionOpenedAt from history", e);
    }
    isHistoryLoaded = true;
}

const engineStartTime = Date.now();

function aggregateDeadlockMetrics(symbol: string, now: number): {
    lastPositionOpenedAt: number | null;
    lastV2EnterDecisionAt: number | null;
    minutesSinceLastPositionOpened: number;
    minutesSinceLastV2EnterDecision: number;
    cyclesSinceLastEnter: number;
    repeatedCandidateSide: string;
    repeatedCandidateCount: number;
    repeatedSoftBlockReasons: string[];
    hardBlockCount: number;
    readinessOkCount: number;
    stopPlanOkCount: number;
    htfPolicyHistory: string[];
    zoneHistory: string[];
    qualityScoreAvg: number;
    qualityScoreMax: number;
    sameDirectionPersistence: number;
    historyCount: number;
} {
    const history = symbolHistoryMap.get(symbol) ?? [];
    const cutoff = now - 30 * 60 * 1000;
    let filtered = history.filter(h => h.timestamp >= cutoff);
    if (filtered.length > 200) {
        filtered = filtered.slice(-200);
    }
    symbolHistoryMap.set(symbol, filtered);

    const lastPositionOpenedAt = symbolLastPositionOpenedAtMap.get(symbol) ?? null;
    const lastV2EnterDecisionAt = symbolLastV2EnterDecisionAtMap.get(symbol) ?? null;
    const effectiveLastPositionOpenedAt = lastPositionOpenedAt ?? engineStartTime;
    const minutesSinceLastPositionOpened = (now - effectiveLastPositionOpenedAt) / (60 * 1000);
    const minutesSinceLastV2EnterDecision = lastV2EnterDecisionAt ? (now - lastV2EnterDecisionAt) / (60 * 1000) : NaN;
    const cyclesSinceLastEnter = symbolCyclesSinceLastEnterMap.get(symbol) ?? 0;

    let repeatedCandidateSide = "none";
    let repeatedCandidateCount = 0;
    let longCount = 0;
    let shortCount = 0;
    
    const softBlockReasonsSet = new Set<string>();
    let hardBlockCount = 0;
    let readinessOkCount = 0;
    let stopPlanOkCount = 0;
    const htfPolicyHistory: string[] = [];
    const zoneHistory: string[] = [];
    let qualitySum = 0;
    let qualityScoreMax = 0;

    for (const h of filtered) {
        if (h.side === "long") longCount++;
        else if (h.side === "short") shortCount++;

        if (h.softBlockReason) {
            softBlockReasonsSet.add(h.softBlockReason);
        }
        if (h.hardBlockPresent) hardBlockCount++;
        if (h.readinessOk) readinessOkCount++;
        if (h.stopPlanOk) stopPlanOkCount++;
        htfPolicyHistory.push(h.htfPolicy);
        zoneHistory.push(h.zone);
        qualitySum += h.qualityScore;
        if (h.qualityScore > qualityScoreMax) {
            qualityScoreMax = h.qualityScore;
        }
    }

    if (longCount > 0 || shortCount > 0) {
        if (longCount >= shortCount) {
            repeatedCandidateSide = "long";
            repeatedCandidateCount = longCount;
        } else {
            repeatedCandidateSide = "short";
            repeatedCandidateCount = shortCount;
        }
    }

    const qualityScoreAvg = filtered.length > 0 ? qualitySum / filtered.length : 0;
    const repeatedSoftBlockReasons = Array.from(softBlockReasonsSet);

    let sameDirectionPersistence = 0;
    if (filtered.length > 0) {
        const lastSide = filtered[filtered.length - 1].side;
        if (lastSide !== "none") {
            for (let i = filtered.length - 1; i >= 0; i--) {
                if (filtered[i].side === lastSide) {
                    sameDirectionPersistence++;
                } else {
                    break;
                }
            }
        }
    }

    return {
        lastPositionOpenedAt,
        lastV2EnterDecisionAt,
        minutesSinceLastPositionOpened,
        minutesSinceLastV2EnterDecision,
        cyclesSinceLastEnter,
        repeatedCandidateSide,
        repeatedCandidateCount,
        repeatedSoftBlockReasons,
        hardBlockCount,
        readinessOkCount,
        stopPlanOkCount,
        htfPolicyHistory,
        zoneHistory,
        qualityScoreAvg,
        qualityScoreMax,
        sameDirectionPersistence,
        historyCount: filtered.length
    };
}

const microPerfStats = {
    calculatedCount: 0,
    totalCalcMs: 0,
    maxCalcMs: 0,
    fallbackNeutralCount: 0,
    usedOrderbookCount: 0,
    usedRecentTradesCount: 0,
    appliedCount: 0,
    deferredCount: 0,
    sizeReducedCount: 0,
    hardBlockedCount: 0,
    lastLoggedAtMs: Date.now()
};
function pruneV2ProofKeyMap(nowMs: number): void {
    for (const [k, v] of v2ProofLastKeyByEventSymbol.entries()) {
        if (nowMs - v.updatedAtMs > V2_PROOF_KEY_TTL_MS) {
            v2ProofLastKeyByEventSymbol.delete(k);
        }
    }
    while (v2ProofLastKeyByEventSymbol.size > V2_PROOF_KEY_MAX_SIZE) {
        const oldest = v2ProofLastKeyByEventSymbol.keys().next();
        if (oldest.done) break;
        v2ProofLastKeyByEventSymbol.delete(oldest.value);
    }
}
export function shouldEmitV2Proof(
    eventName: string,
    symbol: string,
    key: string,
    highPriority: boolean
): boolean {
    const nowMs = Date.now();
    pruneV2ProofKeyMap(nowMs);
    const verbose = String(process.env.V2_PROOF_VERBOSE ?? "").toLowerCase() === "true";
    const mapKey = `${eventName}:${symbol}`;
    if (verbose || highPriority) {
        v2ProofLastKeyByEventSymbol.set(mapKey, { key, updatedAtMs: nowMs });
        return true;
    }
    const prev = v2ProofLastKeyByEventSymbol.get(mapKey)?.key;
    if (prev !== key) {
        v2ProofLastKeyByEventSymbol.set(mapKey, { key, updatedAtMs: nowMs });
        return true;
    }
    v2ProofLastKeyByEventSymbol.set(mapKey, { key, updatedAtMs: nowMs });
    return false;
}

/**
 * orchestrator for Engine-V2 5-tier architecture.
 * Produces an independent EngineV2Decision.
 */
export function runEngineV2(input: EngineV2Input): { decision: EngineV2Decision; internal: EngineV2InternalResult } {
    loadLastEnterAtFromHistory();
    // Step 1: derive normalized state authority
    const v2State = deriveV2StateAuthority(input);
    // Step 2: project normalized state into authoritative input
    let authoritativeInput: EngineV2Input = {
        ...input,
        state: {
            ...input.state,
            currentPositions: v2State.currentPositions,
            lossStreaks: v2State.lossStreaks,
            directionalShockState: v2State.directionalShockState,
            longAllow: v2State.longAllow,
            shortAllow: v2State.shortAllow,
            executionReadiness: v2State.paperExecutionReady,
            paperExecutionReady: v2State.paperExecutionReady,
            signedExecutionReady: v2State.signedExecutionReady,
            freshTickBarrierActive: v2State.freshTickBarrierActive,
            freshTickExecutionBlocked: v2State.freshTickExecutionBlocked,
            freshTickCompletedCycles: v2State.freshTickCompletedCycles,
            freshTickRequiredCycles: v2State.freshTickRequiredCycles,
            entryQualityProfiles: v2State.entryQualityProfiles,
            serverTradeEnabled: v2State.serverTradeEnabled,
            closeOnlyMode: v2State.closeOnlyMode,
            killSwitch: v2State.killSwitch,
            reconcileSafeMode: v2State.reconcileSafeMode,
            riskMode: v2State.riskMode ?? undefined,
            dailyLossGuardTriggered: v2State.dailyLossGuardTriggered,
            crashState: v2State.crashState,
            pumpState: v2State.pumpState,
            pump_state: v2State.pumpState,
            accountEquityKrw: v2State.accountEquityKrw,
            maxUsableMarginKrw: v2State.maxUsableMarginKrw,
            exposureNotionalCapKrw: v2State.exposureNotionalCapKrw,
            symbolExposureNotionalCapKrw: v2State.symbolExposureNotionalCapKrw,
            okxAuthMode: v2State.okxAuthMode,
            okxAuthReady: v2State.okxAuthReady,
            okxExchangeAuthOptIn: v2State.okxExchangeAuthOptIn,
            okxLiveEnabled: v2State.okxLiveEnabled,
            okxDemoEnabled: v2State.okxDemoEnabled,
            okxApiKeyPresent: v2State.okxApiKeyPresent,
            okxApiSecretPresent: v2State.okxApiSecretPresent,
            okxPassphrasePresent: v2State.okxPassphrasePresent,
            okxSimulatedTradingHeaderEnabled: v2State.okxSimulatedTradingHeaderEnabled,
            liveMaxOrderNotionalUsdt: v2State.liveMaxOrderNotionalUsdt,
            liveBalanceReady: v2State.liveBalanceReady,
            accountEquityUsdt: v2State.accountEquityUsdt ?? undefined,
            availableBalanceUsdt: v2State.availableBalanceUsdt ?? undefined,
            okxActualPositionsReady: v2State.okxActualPositionsReady,
            actualAccountNotionalUsdtReady: v2State.actualAccountNotionalUsdtReady,
            okxActualPositions: v2State.okxActualPositions,
            okxPendingOrdersReady: v2State.okxPendingOrdersReady,
            okxPendingOrdersNotionalUsdt: v2State.okxPendingOrdersNotionalUsdt,
            okxPendingSymbolNotionalUsdt: v2State.okxPendingSymbolNotionalUsdt,
            balanceFetchedAt: v2State.balanceFetchedAt ?? undefined,
            positionsFetchedAt: v2State.positionsFetchedAt ?? undefined,
            pendingOrdersFetchedAt: v2State.pendingOrdersFetchedAt ?? undefined,
            lastLossReentryState: v2State.lastLossReentryState ?? null,
            hasOperatorPendingOrders: v2State.hasOperatorPendingOrders ?? undefined,
            manualTakeoverActive: v2State.manualTakeoverActive ?? undefined
        }
    };

    const heldPos = v2State.longPosition ?? v2State.shortPosition;
    const posAny = heldPos as any;
    const stateAny = authoritativeInput.state as any;
    const isManualTakeover =
        posAny?.manualTakeoverActive === true ||
        posAny?.lifecycleState === "OPERATOR_MANAGED" ||
        stateAny?.manualTakeoverActive === true ||
        stateAny?.hasOperatorPendingOrders === true;

    if (isManualTakeover) {
        const isPendingOrderSource = stateAny?.hasOperatorPendingOrders === true && !heldPos;
        console.info(JSON.stringify({
            event: "V2_MANUAL_TAKEOVER_AUTHORITY_PROOF",
            symbol: String(input.symbol),
            side: heldPos?.side ?? "none",
            manual_takeover_active: true,
            mutation_allowed: false,
            position_calculation_allowed: false,
            lifecycle_state: "OPERATOR_MANAGED",
            reason: isPendingOrderSource ? "OPERATOR_PENDING_ORDER_OBSERVE_ONLY" : "OPERATOR_MANUAL_INTERVENTION_OBSERVE_ONLY"
        }));
        const heldSideNormalized: EngineV2Side =
            String(heldPos?.side ?? "").toLowerCase() === "long"
                ? "long"
                : String(heldPos?.side ?? "").toLowerCase() === "short"
                  ? "short"
                  : "none";

        return {
            decision: {
                symbol: input.symbol as MarketSymbol,
                ts: input.now,
                regime: "NO_TRADE",
                confidence: "LOW",
                confidenceScore: 0,
                signal: "NONE",
                side: heldSideNormalized,
                decision: "HOLD",
                executionAction: "NONE",
                risk: {
                    stageMarginKrw: 0,
                    baseStageMarginKrw: 0,
                    sizeMultiplier: 0,
                    leverageProfile: "BASE",
                    appliedLeverage: 0,
                    leverageReason: "manual_takeover_observe_only",
                    leverageBlockReason: "MANUAL_TAKEOVER_ACTIVE",
                    isBlocked: true,
                    blockReason: "MANUAL_TAKEOVER_ACTIVE",
                    isAddOn: false,
                    entryQualityGrade: "B",
                    exposureNotionalKrw: 0,
                    equityMultiple: 0
                },
                explanation: {
                    reason: "MANUAL_TAKEOVER_ACTIVE_OBSERVE_ONLY",
                    uiLabelRegime: "NO_TRADE",
                    uiLabelStatus: "OBSERVE_ONLY"
                },
                rawMetrics: {
                    manual_takeover_active: true,
                    mutation_allowed: false,
                    position_calculation_allowed: false,
                    lifecycle_state: "OPERATOR_MANAGED"
                },
                metadata: {
                    manual_takeover_active: true,
                    mutation_allowed: false,
                    position_calculation_allowed: false,
                    lifecycle_state: "OPERATOR_MANAGED"
                }
            },
            internal: {
                judgment: { regime: "NO_TRADE", subtype: "NONE", isAmbiguous: false, shockPhase: "NONE", transitionPhase: "NONE" },
                confidence: { overall: 0, breakdown: {} },
                execution: { signal: "HOLD", side: heldSideNormalized, reason: "manual_takeover_active", baseSizeIntent: 0, isAddOnEligible: false },
                riskSizing: {
                    stageMarginKrw: 0,
                    baseStageMarginKrw: 0,
                    sizeMultiplier: 0,
                    leverageProfile: "BASE",
                    appliedLeverage: 0,
                    leverageReason: "manual_takeover",
                    isBlocked: true,
                    blockReason: "MANUAL_TAKEOVER_ACTIVE",
                    isAddOn: false,
                    entryQualityGrade: "SKIP",
                    exposureNotionalKrw: 0,
                    equityMultiple: 0
                },
                explanation: { reason: "MANUAL_TAKEOVER_ACTIVE_OBSERVE_ONLY", confidence: 0, metrics: {} }
            } as any
        };
    }

    // Tier 1: Market Judgment (authoritative input only)
    let judgment: ReturnType<typeof detectMarketRegime>;
    const symbol = authoritativeInput.symbol;
    const runCycleId = authoritativeInput.run_cycle_id;
    
    // Count effective candles to measure cache "quality"
    const effectiveCandles = Array.isArray(authoritativeInput.snapshot.candles) 
        ? authoritativeInput.snapshot.candles.length 
        : 0;
    
    let effectiveHtfCandles = 0;
    if (authoritativeInput.htf_candles) {
        for (const k of ["5m", "15m", "1h", "4h", "1d"] as const) {
            const arr = authoritativeInput.htf_candles[k];
            if (Array.isArray(arr)) effectiveHtfCandles += arr.length;
        }
    }
    const totalCandleCount = effectiveCandles + effectiveHtfCandles;

    const cached = runCycleId ? marketJudgmentCacheBySymbol.get(symbol) : undefined;
    if (cached && cached.runCycleId === runCycleId && totalCandleCount <= cached.candleCount) {
        judgment = cached.judgment;
    } else {
        judgment = detectMarketRegime(authoritativeInput);
        if (runCycleId) {
            marketJudgmentCacheBySymbol.set(symbol, {
                runCycleId,
                judgment,
                candleCount: totalCandleCount
            });
        }
    }

    // Synchronize computed fallback slopes back into authoritativeInput and input snapshots to prevent downstream 0 overrides
    const judgmentSlopes = judgment as any;
    if (judgmentSlopes.slopeSource === "candles_fallback") {
        authoritativeInput.snapshot.boxHighSlope = judgmentSlopes.bhSlope ?? 0;
        authoritativeInput.snapshot.boxLowSlope = judgmentSlopes.blSlope ?? 0;
        authoritativeInput.snapshot.rangeCenterSlope = judgmentSlopes.rcSlope ?? 0;
        authoritativeInput.snapshot.ema20Slope = judgmentSlopes.e20Slope ?? 0;
        
        input.snapshot.boxHighSlope = judgmentSlopes.bhSlope ?? 0;
        input.snapshot.boxLowSlope = judgmentSlopes.blSlope ?? 0;
        input.snapshot.rangeCenterSlope = judgmentSlopes.rcSlope ?? 0;
        input.snapshot.ema20Slope = judgmentSlopes.e20Slope ?? 0;

        console.info(JSON.stringify({
            event: "V2_SLOPE_DOWNSTREAM_SYNC_PROOF",
            symbol: String(input.symbol),
            bhSlope: judgmentSlopes.bhSlope,
            blSlope: judgmentSlopes.blSlope,
            rcSlope: judgmentSlopes.rcSlope,
            e20Slope: judgmentSlopes.e20Slope,
            source: judgmentSlopes.slopeSource
        }));
    }

    // Phase 6 Proof: Range Drift Analysis
    if (judgment.regime === "RANGE") {
        emitRangeDriftStateProof(String(input.symbol), judgment, authoritativeInput.snapshot);
    }

    // Tier 2: Regime Confidence (authoritative input only)
    const confidence = calculateRegimeConfidence(judgment, authoritativeInput);

    // Tier 3: Engine Router
    const routing = routeToExecutor(judgment, confidence);
    console.info(JSON.stringify({
        event: "V2_STATE_AUTHORITY_PROOF",
        symbol: String(input.symbol),
        state_authority_source: v2State.stateAuthoritySource,
        position_state_ready: v2State.positionStateReady,
        market_snapshot_ready: v2State.marketSnapshotReady,
        v2_input_ready: v2State.v2InputReady,
        serverTradeEnabled: v2State.serverTradeEnabled,
        closeOnlyMode: v2State.closeOnlyMode,
        killSwitch: v2State.killSwitch,
        reconcileSafeMode: v2State.reconcileSafeMode,
        riskMode: v2State.riskMode,
        dailyLossGuardTriggered: v2State.dailyLossGuardTriggered,
        freshTickBarrierActive: v2State.freshTickBarrierActive,
        freshTickExecutionBlocked: v2State.freshTickExecutionBlocked,
        directionalShockState: v2State.directionalShockState,
        crashState: v2State.crashState,
        pumpState: v2State.pumpState,
        longAllow: v2State.longAllow,
        shortAllow: v2State.shortAllow,
        current_positions_count: v2State.currentPositions.length,
        symbol_positions_count: v2State.symbolPositions.length,
        has_same_side_position: v2State.hasSameSidePosition,
        has_opposite_side_position: v2State.hasOppositeSidePosition,
        currentStage: v2State.currentStage,
        held_position_side: v2State.heldPositionSide,
        management_side: v2State.managementSide,
        candidate_intent_side: v2State.candidateIntentSide,
        inferredIntentSide: v2State.inferredIntentSide,
        has_opposite_to_candidate: v2State.hasOppositeToCandidate,
        hasLongPosition: v2State.hasLongPosition,
        hasShortPosition: v2State.hasShortPosition,
        longStage: v2State.longStage,
        shortStage: v2State.shortStage,
        position_side_resolution_basis: "held_position_side",
        accountEquityKrw: v2State.accountEquityKrw,
        maxUsableMarginKrw: v2State.maxUsableMarginKrw,
        exposureNotionalCapKrw: v2State.exposureNotionalCapKrw,
        symbolExposureNotionalCapKrw: v2State.symbolExposureNotionalCapKrw
    }));

    if (shouldEmitV2Proof("V2_LIVE_MAX_ORDER_NOTIONAL_RESOLVE_PROOF", String(input.symbol), `${v2State.liveMaxOrderNotionalUsdt}`, false)) {
        console.info(JSON.stringify({
            event: "V2_LIVE_MAX_ORDER_NOTIONAL_RESOLVE_PROOF",
            symbol: String(input.symbol),
            input_state_val: input.state.liveMaxOrderNotionalUsdt,
            input_config_val: input.config.okxLiveMaxOrderNotionalUsdt,
            resolved_val: v2State.liveMaxOrderNotionalUsdt,
            is_fallback_applied: v2State.liveMaxOrderNotionalUsdt !== input.state.liveMaxOrderNotionalUsdt,
            fallback_source: v2State.liveMaxOrderNotionalUsdt === input.config.okxLiveMaxOrderNotionalUsdt ? "config" :
                             v2State.liveMaxOrderNotionalUsdt === 100 ? "default_100" : "none",
            ts: Date.now()
        }));
    }

    if (v2State.directionalShockState === "DOWN" && v2State.inferredIntentSide === "long") {
        console.warn(JSON.stringify({
            event: "V2_INTENT_SIDE_ALIGNMENT_PROOF",
            symbol: String(input.symbol),
            directional_shock_state: v2State.directionalShockState,
            inferred_intent_side_before: v2State.inferredIntentSide,
            fixed: true,
            reason: "DOWN_SHOCK_EXCLUDES_LONG_INTENT"
        }));
    } else {
        console.info(JSON.stringify({
            event: "V2_INTENT_SIDE_ALIGNMENT_PROOF",
            symbol: String(input.symbol),
            directional_shock_state: v2State.directionalShockState,
            inferred_intent_side: v2State.inferredIntentSide,
            fixed: false
        }));
    }
    const marketProofKey = [
        judgment.subtype,
        judgment.shockPhase,
        judgment.rangePhase,
        judgment.trendPhase,
        judgment.transitionPhase,
        routing.executor,
        routing.reason
    ].join("|");
    if (shouldEmitV2Proof("V2_MARKET_JUDGMENT_PROOF", String(input.symbol), marketProofKey, false)) {
        console.info(JSON.stringify({
            event: "V2_MARKET_JUDGMENT_PROOF",
            symbol: String(input.symbol),
            market_judgment_state_source: "authoritative_input",
            v2_state_authority_source: v2State.stateAuthoritySource,
            judgmentVersion: judgment.judgmentVersion,
            regime: judgment.regime,
            regime_final: judgment.regime_final,
            subtype: judgment.subtype,
            subtypeReason: judgment.subtypeReason,
            shockPhase: judgment.shockPhase,
            rangePhase: judgment.rangePhase,
            trendPhase: judgment.trendPhase,
            transitionPhase: judgment.transitionPhase,
            confidenceScore: confidence.score,
            confidenceLevel: confidence.level,
            routerExecutor: routing.executor,
            routingReason: routing.reason,
            rangeScore: judgment.metrics.rangeScore,
            trendScore: judgment.metrics.trendScore,
            rangeConfidence: authoritativeInput.snapshot?.rangeConfidence ?? null,
            boxPos: authoritativeInput.snapshot?.boxPos ?? null,
            boxBreakSide: authoritativeInput.snapshot?.boxBreakSide ?? null,
            boxCohesion01: authoritativeInput.snapshot?.boxCohesion01 ?? null,
            breakoutFailureRate: authoritativeInput.snapshot?.breakoutFailureRate ?? null,
            emaGap: authoritativeInput.snapshot?.emaGap ?? null,
            trendWeaknessScore: authoritativeInput.snapshot?.trendWeaknessScore ?? null,
            directionalShockState: v2State.directionalShockState,
            crashState: v2State.crashState,
            pumpState: v2State.pumpState,
            data_ready: judgment.data_ready,
            dump_protection_hit: judgment.dump_protection_hit,
            volatility_guard_hit: judgment.volatility_guard_hit,
            fastTrendShift: judgment.diagnostics?.fastTrendShift ?? null
        }));
    }

    // Tier 4: Executors
    let v2CalculatedInvalidationPx: number | null = null;
    let expectedMissingCondition: string | null = null;
    let expectedNextAction: string | null = null;
    let execution: ExecutorOutput;
    
    // CONTINUATION_MICRO_PROBE scope variables
    let microProbeFixedBoundary: number | null = null;
    let microProbeSizeCap: number | null = null;
    let microProbeSetupKeyToConsume: string | null = null;
    
    if (routing.executor === "RANGE") execution = executeRangeRegime(authoritativeInput, judgment);
    else if (routing.executor === "TREND") execution = executeTrendRegime(authoritativeInput, judgment);
    else if (routing.executor === "TRANSITION") execution = executeTransitionRegime(authoritativeInput, judgment);
    else {
        execution = {
            signal: "NONE",
            side: "none",
            reason: "No Routing",
            baseSizeIntent: 0,
            recheckSuggested: false,
            isAddOnEligible: false,
            stopPrice: null,
            invalidationPx: null,
            metadata: {}
        };
    }

    const continuationState = rangeContinuationStateMap.get(String(input.symbol));
    if (continuationState) {
        const phaseOk = continuationState.phase === "CONTINUATION_WATCH" || continuationState.phase === "RETEST_TOUCHED";
        const dirOk = continuationState.direction === "down" || continuationState.direction === "up";
        const boundaryOk = Number(continuationState.watchBoundaryPrice) > 0;
        const startCandleOk = Number(continuationState.watchStartedCandleTs) > 0;
        const startTsOk = Number(continuationState.watchStartedAtTimestamp) > 0;
        const noPosition = v2State.currentPositions.length === 0;

        const evaluationNow = Number(authoritativeInput.now ?? Date.now());
        const continuationAgeMs = evaluationNow - Number(continuationState.watchStartedAtTimestamp);
        const ageOk = continuationAgeMs >= 0 && continuationAgeMs <= 10 * 60 * 1000;

        if (phaseOk && dirOk && boundaryOk && startCandleOk && startTsOk && noPosition && ageOk) {
            const execMetaBoundary = Number(execution.metadata?.watchBoundary ?? 0);
            const execMetaDirection = String(execution.metadata?.continuationDirection ?? "");
            const stateBoundary = Number(continuationState.watchBoundaryPrice);
            const stateDirection = String(continuationState.direction);

            if (execMetaBoundary > 0 && (execMetaBoundary !== stateBoundary || execMetaDirection !== stateDirection)) {
                console.info(JSON.stringify({
                    event: "V2_CONTINUATION_CONTEXT_MISMATCH_PROOF",
                    symbol: String(input.symbol),
                    activeEngineRouting: routing.executor,
                    metadataBoundary: execMetaBoundary,
                    stateBoundary,
                    metadataDirection: execMetaDirection,
                    stateDirection,
                    selectedSource: "range_state_map_bridge"
                }));
            }

            execution = {
                ...execution,
                metadata: {
                    ...(execution.metadata ?? {}),
                    watchBoundary: continuationState.watchBoundaryPrice,
                    watchStartedCandleTs: continuationState.watchStartedCandleTs,
                    continuationDirection: continuationState.direction,
                    continuationPhase: continuationState.phase,
                    continuationContextSource: "range_state_map_bridge",
                    continuationAgeMs
                }
            };
        }
    }
    v2CalculatedInvalidationPx = execution.invalidationPx;
    const USD_PER_KRW = 1 / 1400;
    const liveAccountEquityUsdt =
        typeof v2State.accountEquityUsdt === "number" && v2State.accountEquityUsdt > 0
            ? v2State.accountEquityUsdt
            : 0;
    const accountEquityUsd =
        liveAccountEquityUsdt > 0
            ? liveAccountEquityUsdt
            : (v2State.accountEquityKrw ?? 0) * USD_PER_KRW;
    const currentSymbolNotionalUsd = (v2State.symbolLedgerExposureNotionalKrw ?? 0) * USD_PER_KRW;
    const currentGlobalNotionalUsd = (v2State.ledgerExposureNotionalKrw ?? 0) * USD_PER_KRW;

    const preAddOnPosition = v2State.currentPositions.find(
        p => p.symbol === input.symbol && String(p.side).toLowerCase() === execution.side
    );

    const liveMaxAddonNotionalUsdt =
        input.config.okxLiveMaxAddonNotionalUsdt ??
        (v2State as { liveMaxAddonNotionalUsdt?: number }).liveMaxAddonNotionalUsdt ??
        20;

    const addOnPolicy = evaluateV2AddOnPolicy({
        symbol: String(input.symbol),
        side: execution.side,
        v2State,
        judgment,
        execution,
        snapshot: {
            qualityScore: authoritativeInput.snapshot.qualityScore,
            reviewing_ticks: authoritativeInput.snapshot.reviewing_ticks,
            boxPos: authoritativeInput.snapshot.boxPos,
            emaGap: authoritativeInput.snapshot.emaGap,
            trendWeaknessScore: authoritativeInput.snapshot.trendWeaknessScore,
            rangeConfidence: authoritativeInput.snapshot.rangeConfidence,
            lastPrice: authoritativeInput.snapshot.lastPrice,
            atr: authoritativeInput.snapshot.atr,
            volatilityProxyDiag: authoritativeInput.snapshot.volatilityProxy,
            latestCandleTs: (() => {
                const candles = input.candles ?? input.snapshot?.candles;
                if (!Array.isArray(candles) || candles.length === 0) return 0;
                const ts = Number(candles[candles.length - 1]?.ts ?? 0);
                return Number.isFinite(ts) && ts > 0 ? ts : 0;
            })()
        },
        accountEquityUsd,
        currentSymbolNotionalUsd,
        currentGlobalNotionalUsd,
        currentStopPrice: preAddOnPosition?.ledger_stop_px ?? undefined,
        maxAddonNotionalUsdt: liveMaxAddonNotionalUsdt
    });

    // --- V2_ADDON_BREAKEVEN_GATE_PROOF (Pyramiding-only Hard Gate) ---
    const breakevenGateBlocked =
        addOnPolicy.addonMode === "PYRAMIDING" &&
        addOnPolicy.allowed &&
        !addOnPolicy.breakevenStopConfirmed;
    if (breakevenGateBlocked) {
        if (shouldEmitV2Proof("V2_ADDON_BREAKEVEN_GATE_PROOF", String(input.symbol), `${addOnPolicy.side}|${addOnPolicy.reason}`, true)) {
            console.info(JSON.stringify({
                event: "V2_ADDON_BREAKEVEN_GATE_PROOF",
                symbol: String(input.symbol),
                side: addOnPolicy.side,
                action: addOnPolicy.action,
                reason: addOnPolicy.reason,
                breakevenStopRequired: addOnPolicy.breakevenStopRequired,
                breakevenStopConfirmed: addOnPolicy.breakevenStopConfirmed,
                breakevenStopPrice: addOnPolicy.breakevenStopPrice,
                lockedProfitUsdt: addOnPolicy.lockedProfitUsdt,
                gate_blocked: true,
                mandatory_safety_gate_active: true,
                detail: addOnPolicy.breakevenStopRequired === false ? "safety_gate_enforced_despite_required_false" : "confirmation_pending",
                ts: Date.now()
            }));
        }
        
        // Forced Override
        (addOnPolicy as any).allowed = false;
        (addOnPolicy as any).action = "ADDON_WATCH";
        (addOnPolicy as any).reason = "BREAKEVEN_STOP_NOT_CONFIRMED";
    }
    const shouldEmitAddOnProof =
        addOnPolicy.action !== "INITIAL_ONLY" ||
        addOnPolicy.hasSameSidePosition ||
        execution.signal === "LONG_CANDIDATE" ||
        execution.signal === "SHORT_CANDIDATE" ||
        execution.signal === "WAIT_RECHECK";
    const addOnProofKey = [
        addOnPolicy.action,
        addOnPolicy.reason,
        addOnPolicy.marketSubtype,
        addOnPolicy.transitionPhase,
        execution.signal,
        execution.side
    ].join("|");
    if (shouldEmitAddOnProof && shouldEmitV2Proof("V2_ADDON_POLICY_PROOF", String(input.symbol), addOnProofKey, addOnPolicy.action !== "INITIAL_ONLY")) {
        console.info(JSON.stringify({
            event: "V2_ADDON_POLICY_PROOF",
            symbol: String(input.symbol),
            side: addOnPolicy.side,
            action: addOnPolicy.action,
            allowed: addOnPolicy.allowed,
            reason: addOnPolicy.reason,
            addOnEligible: addOnPolicy.addOnEligible,
            isInitial: addOnPolicy.isInitial,
            isAddOn: addOnPolicy.isAddOn,
            currentStage: addOnPolicy.currentStage,
            hasSameSidePosition: addOnPolicy.hasSameSidePosition,
            hasOppositeSidePosition: addOnPolicy.hasOppositeSidePosition,
            marketRegime: addOnPolicy.marketRegime,
            marketSubtype: addOnPolicy.marketSubtype,
            shockPhase: addOnPolicy.shockPhase,
            rangePhase: addOnPolicy.rangePhase,
            trendPhase: addOnPolicy.trendPhase,
            transitionPhase: addOnPolicy.transitionPhase,
            qualityScore: addOnPolicy.qualityScore,
            reviewingTicks: addOnPolicy.reviewingTicks,
            pnlPct: addOnPolicy.pnlPct,
            boxPos: addOnPolicy.boxPos,
            emaGap: addOnPolicy.emaGap,
            trendWeaknessScore: addOnPolicy.trendWeaknessScore,
            rangeConfidence: addOnPolicy.rangeConfidence,
            evidence: addOnPolicy.evidence
        }));
    }

    if (judgment.subtype?.includes("FAST_TREND_SHIFT") || judgment.reason?.includes("FAST_TREND_SHIFT")) {
        if (shouldEmitV2Proof("V2_FAST_TREND_SHIFT_PROBE_PROOF", String(input.symbol), String(execution.side), true)) {
            console.info(JSON.stringify({
                event: "V2_FAST_TREND_SHIFT_PROBE_PROOF",
                symbol: String(input.symbol),
                side: execution.side,
                reason: judgment.reason,
                subtype: judgment.subtype,
                quality: authoritativeInput.snapshot.qualityScore,
                lastPrice: authoritativeInput.snapshot.lastPrice,
                baseSizeIntent: execution.baseSizeIntent,
                invalidationPx: execution.invalidationPx,
                ts: Date.now()
            }));
        }
    }

    if (
        addOnPolicy.action === "INITIAL_ONLY" &&
        (execution.signal === "LONG_CANDIDATE" || execution.signal === "SHORT_CANDIDATE" || execution.signal === "WAIT_RECHECK") &&
        shouldEmitV2Proof(
            "ADDON_POLICY_INITIAL_BYPASS_PROOF",
            String(input.symbol),
            `${execution.signal}|${execution.side}|${addOnPolicy.reason}`,
            true
        )
    ) {
        console.info(JSON.stringify({
            event: "ADDON_POLICY_INITIAL_BYPASS_PROOF",
            symbol: String(input.symbol),
            side: addOnPolicy.side,
            action: addOnPolicy.action,
            reason: addOnPolicy.reason,
            isInitial: addOnPolicy.isInitial,
            isAddOn: addOnPolicy.isAddOn,
            hasSameSidePosition: addOnPolicy.hasSameSidePosition,
            hasOppositeSidePosition: addOnPolicy.hasOppositeSidePosition,
            initial_blocked_by_addon_policy: false
        }));
    }
    if (addOnPolicy.isAddOn && addOnPolicy.allowed === false && (execution.signal === "LONG_CANDIDATE" || execution.signal === "SHORT_CANDIDATE")) {
        execution = {
            ...execution,
            signal: "WAIT_RECHECK" as const,
            side: "none" as const,
            reason: `ADDON_POLICY_${addOnPolicy.reason}`,
            baseSizeIntent: 0,
            recheckSuggested: true,
            isAddOnEligible: false,
            metadata: {
                ...execution.metadata,
                range_side_candidate:
                    (execution.metadata as any)?.range_side_candidate ??
                    (judgment.metadata as any)?.range_side_candidate ??
                    "none",
                trend_side_candidate:
                    (execution.metadata as any)?.trend_side_candidate ??
                    (judgment.metadata as any)?.trend_side_candidate ??
                    "none",
                addonPolicyAction: addOnPolicy.action,
                addonPolicyReason: addOnPolicy.reason,
                addonPolicyAllowed: false
            }
        };
    }
    // --- Unified finalAddonNotionalUsdt Calculation (Pyramid Sizing Source of Truth) ---
    const symbolMaxNotionalUsdt = liveAccountEquityUsdt > 0
        ? liveAccountEquityUsdt * MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE
        : accountEquityUsd * 0.8;
    const globalMaxNotionalUsdt = liveAccountEquityUsdt > 0
        ? liveAccountEquityUsdt * MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE
        : accountEquityUsd * 1.5;
    const remainingSymbolRoom = Math.max(0, symbolMaxNotionalUsdt - currentSymbolNotionalUsd);
    const remainingGlobalRoom = Math.max(0, globalMaxNotionalUsdt - currentGlobalNotionalUsd);
    const maxAdverseAddonUsdt = liveAccountEquityUsdt > 0
        ? liveAccountEquityUsdt * MAX_ADVERSE_ADDON_EQUITY_MULTIPLE
        : accountEquityUsd * MAX_ADVERSE_ADDON_EQUITY_MULTIPLE;

    const addonPolicyNotionalCap =
        addOnPolicy.addonMode === "CONFIRMED_ADVERSE_ADDON"
            ? (addOnPolicy.requestedAddonNotionalUsdt ?? addOnPolicy.addonMaxNotionalUsdt ?? maxAdverseAddonUsdt)
            : (addOnPolicy.addonMaxNotionalUsdt ?? 0);

    const finalAddonNotionalUsdt = Math.min(
        addonPolicyNotionalCap,
        remainingSymbolRoom,
        remainingGlobalRoom
    );

    console.info(JSON.stringify({
        event: "V2_TREND_FINAL_ADDON_NOTIONAL_PROOF",
        symbol: String(input.symbol),
        addonPolicyMax: addOnPolicy.addonMaxNotionalUsdt,
        liveAccountEquityUsdt,
        maxAdverseAddonUsdt,
        remainingSymbolRoom,
        remainingGlobalRoom,
        finalAddonNotionalUsdt
    }));

    authoritativeInput = {
        ...authoritativeInput,
        state: {
            ...authoritativeInput.state,
            addOnPolicyAllowed: addOnPolicy.allowed,
            addOnPolicyReason: addOnPolicy.reason,
            addOnPolicyAction: addOnPolicy.action,
            lockedProfitUsdt: addOnPolicy.lockedProfitUsdt,
            availableRiskBudgetUsdt: addOnPolicy.availableRiskBudgetUsdt,
            addonMaxNotionalUsdt: addOnPolicy.addonMaxNotionalUsdt,
            finalAddonNotionalUsdt: finalAddonNotionalUsdt,
            ...( {
                addOnPolicyMode: addOnPolicy.addonMode ?? "NONE",
                requestedAddonNotionalUsdt: addOnPolicy.requestedAddonNotionalUsdt
            } as Record<string, unknown> )
        }
    };
    const exitPreShock = v2State.directionalShockState ?? "NONE";
    const exitPreEmaGap = Number(authoritativeInput.snapshot.emaGap ?? 0);
    const exitPreBoxPos = Number(authoritativeInput.snapshot.boxPos ?? 0.5);
    const exitPreTrendSideCandidate = deriveTrendSideCandidate(exitPreShock, exitPreEmaGap);
    const exitPreRangeZone =
        exitPreBoxPos <= 0.26 ? "lower" : exitPreBoxPos >= 0.74 ? "upper" : "mid";
    const exitPreRangeSideCandidate: "long" | "short" | "none" =
        exitPreRangeZone === "lower"
            ? "long"
            : exitPreRangeZone === "upper"
              ? "short"
              : "none";
    const exitPreReversalConfirmed =
        (execution.metadata as Record<string, unknown> | undefined)?.reversal_confirmed === true;
    const exitPreMeta = execution.metadata as Record<string, unknown> | undefined;
    const exitPreBoxBreakSide = authoritativeInput.snapshot.boxBreakSide ?? "none";
    const exitInvalidationBreachConfirmed =
        exitPreReversalConfirmed === true ||
        exitPreMeta?.invalidation_breach_confirmed === true ||
        exitPreMeta?.structural_break_confirmed === true ||
        exitPreMeta?.confirmed_candle_close_beyond_invalidation === true;
    const exitBoxBreakConfirmed =
        exitPreMeta?.box_break_confirmed === true ||
        (exitPreReversalConfirmed === true &&
            String(exitPreBoxBreakSide) !== "none" &&
            String(exitPreBoxBreakSide).toLowerCase() !== "unknown");
    const exitPolicyBase = evaluateV2ExitPolicy({
        symbol: String(input.symbol),
        v2State,
        judgment,
        snapshot: {
            boxPos: authoritativeInput.snapshot.boxPos,
            boxBreakSide: authoritativeInput.snapshot.boxBreakSide,
            emaGap: authoritativeInput.snapshot.emaGap,
            trendWeaknessScore: authoritativeInput.snapshot.trendWeaknessScore,
            rangeConfidence: authoritativeInput.snapshot.rangeConfidence,
            qualityScore: authoritativeInput.snapshot.qualityScore,
            atr20: typeof authoritativeInput.snapshot.atr20 === "number" && authoritativeInput.snapshot.atr20 > 0 ? authoritativeInput.snapshot.atr20 : null
        },
        trendSideCandidate: exitPreTrendSideCandidate,
        rangeSideCandidate: exitPreRangeSideCandidate,
        reversalConfirmed: exitPreReversalConfirmed,
        invalidationBreachConfirmed: exitInvalidationBreachConfirmed,
        structuralBreakConfirmed: exitPreMeta?.structural_break_confirmed === true,
        boxBreakConfirmed: exitBoxBreakConfirmed,
        markPrice: Number(authoritativeInput.snapshot.lastPrice ?? 0)
    });

    const exitHeldPosition =
        exitPolicyBase.positionSide === "long"
            ? v2State.longPosition
            : exitPolicyBase.positionSide === "short"
              ? v2State.shortPosition
              : v2State.longPosition ?? v2State.shortPosition;
    const exitFeeRate = Number(authoritativeInput.config.paperTakerFeeRate ?? 0.0005);
    const exitGrossReturnPct = computeGrossReturnPct({
        positionSide: exitPolicyBase.positionSide,
        entryPrice: Number(exitHeldPosition?.entryPrice ?? 0),
        markPrice: Number(authoritativeInput.snapshot.lastPrice ?? 0),
        reportedPnlPct: exitPolicyBase.pnlPct
    });
    const exitNotionalUsd = Math.max(0, Number(exitPolicyBase.positionSizeUsd ?? 0));
    const softExitFeeGate = evaluateV2ExitPolicySoftExitFeeGate({
        policyReason: exitPolicyBase.reason,
        policyAction: exitPolicyBase.action,
        shouldExit: exitPolicyBase.shouldExit,
        shouldReduce: exitPolicyBase.shouldReduce,
        shouldPartial: exitPolicyBase.shouldPartial,
        reduceRatio: exitPolicyBase.reduceRatio,
        grossReturnPct: exitGrossReturnPct,
        positionNotionalUsd: exitNotionalUsd,
        feeRate: exitFeeRate,
        exitUrgency: exitPolicyBase.exitUrgency,
        oppositeHysteresisState: exitPolicyBase.oppositeHysteresisState,
        invalidationBreachConfirmed: exitInvalidationBreachConfirmed,
        reversalConfirmed: exitPreReversalConfirmed
    });
    const exitPolicy = softExitFeeGate.applied
        ? {
              ...exitPolicyBase,
              action: softExitFeeGate.action,
              reason: softExitFeeGate.reason,
              shouldExit: softExitFeeGate.shouldExit,
              shouldReduce: softExitFeeGate.shouldReduce,
              shouldPartial: softExitFeeGate.shouldPartial,
              reduceRatio: softExitFeeGate.reduceRatio,
              evidence: `${exitPolicyBase.evidence}${softExitFeeGate.evidenceSuffix}`
          }
        : exitPolicyBase;

    if (
        exitPolicyBase.hasPosition &&
        exitPolicyBase.pnlStopGateResult != null &&
        shouldEmitV2Proof(
            "V2_PNL_STOP_MEANINGFUL_MOVE_GATE_PROOF",
            String(input.symbol),
            `${exitPolicyBase.pnlStopGateResult.thresholdActionCandidate}|${exitPolicyBase.pnlStopGateResult.meaningfulMovePassed}|${exitPolicyBase.pnlStopGateResult.finalAction}|${exitPolicyBase.pnlStopGateResult.bypassReason ?? "none"}`,
            true
        )
    ) {
        console.info(JSON.stringify(buildPnlStopMeaningfulMoveGateProof(exitPolicyBase.pnlStopGateResult)));
    }

    if (
        softExitFeeGate.evaluated &&
        shouldEmitV2Proof(
            "V2_SOFT_EXIT_FEE_GATE_PROOF",
            String(input.symbol),
            `${exitPolicyBase.reason}|${softExitFeeGate.gateAction}|${softExitFeeGate.grossReturnPct}|${softExitFeeGate.feeBreakEvenPct}|${softExitFeeGate.bypassReason ?? "none"}`,
            true
        )
    ) {
        console.info(JSON.stringify(buildSoftExitFeeGateProof({
            symbol: String(input.symbol),
            side: exitPolicy.positionSide,
            authoritative_close_reason: exitPolicyBase.reason,
            mapped_fee_gate_reason: softExitFeeGate.mappedFeeGateReason,
            prior_reason: exitPolicyBase.reason,
            prior_action: exitPolicyBase.action,
            final_action: exitPolicy.action,
            final_reason: exitPolicy.reason,
            gross_return_pct: softExitFeeGate.grossReturnPct,
            entry_fee_pct: softExitFeeGate.entryFeePct,
            exit_fee_pct: softExitFeeGate.exitFeePct,
            slippage_buffer_pct: softExitFeeGate.slippageBufferPct,
            fee_break_even_pct: softExitFeeGate.feeBreakEvenPct,
            gate_action: softExitFeeGate.gateAction,
            bypass_reason: softExitFeeGate.bypassReason,
            position_notional_usd: exitNotionalUsd,
            block_reason: softExitFeeGate.blockReason
        })));
    }
    if (
        exitPolicy.hasPosition &&
        shouldEmitV2Proof(
            "V2_EXIT_POLICY_PROOF",
            String(input.symbol),
            `${exitPolicy.action}|${exitPolicy.reason}|${exitPolicy.positionSide}|${exitPolicy.currentStage}`,
            true
        )
    ) {
        console.info(JSON.stringify({
            event: "V2_EXIT_POLICY_PROOF",
            symbol: String(input.symbol),
            hasPosition: exitPolicy.hasPosition,
            positionSide: exitPolicy.positionSide,
            positionSizeUsd: exitPolicy.positionSizeUsd,
            currentStage: exitPolicy.currentStage,
            pnlPct: exitPolicy.pnlPct,
            action: exitPolicy.action,
            shouldExit: exitPolicy.shouldExit,
            shouldReduce: exitPolicy.shouldReduce,
            shouldPartial: exitPolicy.shouldPartial,
            reason: exitPolicy.reason,
            reduceRatio: exitPolicy.reduceRatio,
            exitUrgency: exitPolicy.exitUrgency,
            exitConfidence: exitPolicy.exitConfidence,
            marketRegime: exitPolicy.marketRegime,
            marketSubtype: exitPolicy.marketSubtype,
            shockPhase: exitPolicy.shockPhase,
            rangePhase: exitPolicy.rangePhase,
            trendPhase: exitPolicy.trendPhase,
            transitionPhase: exitPolicy.transitionPhase,
            boxPos: exitPolicy.boxPos,
            boxBreakSide: exitPolicy.boxBreakSide,
            emaGap: exitPolicy.emaGap,
            trendWeaknessScore: exitPolicy.trendWeaknessScore,
            rangeConfidence: exitPolicy.rangeConfidence,
            qualityScore: exitPolicy.qualityScore,
            evidence: exitPolicy.evidence
        }));
    }
    
    // --- V2 PROFIT PROTECTION STATE PROOF ---
    if (exitPolicy.reason.startsWith("PROFIT_PROTECTION_") && 
        shouldEmitV2Proof("V2_PROFIT_PROTECTION_STATE_PROOF", String(input.symbol), exitPolicy.reason, true)) {
        console.info(JSON.stringify({
            event: "V2_PROFIT_PROTECTION_STATE_PROOF",
            symbol: String(input.symbol),
            side: exitPolicy.positionSide,
            pnlPct: exitPolicy.pnlPct,
            peakPnlPct: exitPolicy.peakUnrealizedPnlPct,
            profit_protection_active: exitPolicy.profitProtectionActive,
            action: exitPolicy.action,
            reason: exitPolicy.reason,
            reduceRatio: exitPolicy.reduceRatio,
            evidence: exitPolicy.evidence
        }));
    }

    if (
        exitPolicy.hasPosition &&
        shouldEmitV2Proof(
            "V2_OPPOSITE_POSITION_HYSTERESIS_PROOF",
            String(input.symbol),
            `${exitPolicy.oppositeHysteresisState ?? "NONE"}|${exitPolicy.action}|${exitPolicy.reason}`,
            true
        )
    ) {
        console.info(JSON.stringify({
            event: "V2_OPPOSITE_POSITION_HYSTERESIS_PROOF",
            symbol: String(input.symbol),
            position_side: exitPolicy.positionSide,
            trend_side_candidate: exitPreTrendSideCandidate,
            range_side_candidate: exitPreRangeSideCandidate,
            trend_ok: Math.abs(exitPreEmaGap) >= 0.0004 && authoritativeInput.snapshot.trendWeaknessScore < 0.5,
            shock_phase: exitPolicy.shockPhase,
            market_subtype: exitPolicy.marketSubtype,
            transition_phase: exitPolicy.transitionPhase,
            invalidation_breached: exitPolicy.thesisValid === false && exitPolicy.action === "FULL_EXIT",
            opposite_confirmation_fresh: exitPreReversalConfirmed,
            thesis_valid: exitPolicy.thesisValid === true,
            profit_protection_active: exitPolicy.profitProtectionActive,
            hysteresis_state: exitPolicy.oppositeHysteresisState ?? "NONE",
            final_position_action: exitPolicy.action,
            block_reason: exitPolicy.oppositeHysteresisBlockReason ?? null
        }));
    }

    if (judgment.subtype === "WHIPSAW_SHOCK_RECHECK" && exitPolicy.hasPosition && (exitPolicy.shouldExit || exitPolicy.shouldReduce || exitPolicy.shouldPartial)) {
        console.info(JSON.stringify({
            event: "V2_WHIPSAW_EXIT_PASSTHROUGH_PROOF",
            symbol: String(input.symbol),
            subtype: judgment.subtype,
            exit_action: exitPolicy.action,
            exit_reason: exitPolicy.reason,
            pnl_pct: exitPolicy.pnlPct,
            detail: "WHIPSAW state active but existing position exit/reduction is allowed and passed through."
        }));
    }
    if (routing.executor === "TRANSITION") {
        const transitionMeta = (execution.metadata ?? {}) as Record<string, unknown>;
        const transitionAction = String(transitionMeta.transitionAction ?? "REJECT");
        const transitionProofKey = [
            transitionMeta.transitionSetupType ?? "NONE",
            transitionAction,
            execution.signal,
            execution.reason,
            transitionMeta.transitionRejectReason ?? "none"
        ].join("|");

        // --- V2_TRANSITION_SHORT_SETUP_DIAGNOSTIC_PROOF (DOWN shock + TRANSITION) ---
        // DOWN shock + TRANSITION 상황에서 short setup의 진단 결과를 로그로 남긴다.
        if (v2State.directionalShockState === "DOWN") {
            const retestConfirmed = transitionMeta.retestConfirmed === true;
            const reclaimConfirmed = transitionMeta.reclaimConfirmed === true;
            
            // setup이 통과되었는지 여부
            const setup_passed = transitionMeta.transitionPreflightSafetyPassed === true;
            const setup_fail_reason = transitionMeta.transitionPreflightBlockReason as string | null ?? transitionMeta.transitionRejectReason as string | null ?? "none";

            const localSnapshot = input.snapshot;
            const localBoxPos = localSnapshot.boxPos ?? 0.5;
            const localZone = classifyRangeZone(localBoxPos);
            const localEmaGap = localSnapshot.emaGap ?? 0;
            const localTrendWeaknessScore = localSnapshot.trendWeaknessScore ?? 1;

            const localTrendSideCandidate: EngineV2Side =
                v2State.directionalShockState === "DOWN" ? "short" :
                v2State.directionalShockState === "UP" ? "long" :
                localEmaGap < 0 ? "short" :
                localEmaGap > 0 ? "long" : "none";

            const localRangeSideCandidate: EngineV2Side =
                localZone === "lower" && v2State.longAllow ? "long" :
                localZone === "upper" && v2State.shortAllow ? "short" : "none";

            const localTrendOk =
                Number.isFinite(localEmaGap) &&
                Number.isFinite(localTrendWeaknessScore) &&
                Math.abs(localEmaGap) >= 0.0004 &&
                localTrendWeaknessScore < 0.5;

            console.info(JSON.stringify({
                event: "V2_TRANSITION_SHORT_SETUP_DIAGNOSTIC_PROOF",
                symbol: String(input.symbol),
                directionalShockState: v2State.directionalShockState ?? "NONE",
                market_subtype: judgment.subtype,
                transitionPhase: judgment.transitionPhase ?? "NONE",
                zone: localZone,
                boxPos: localBoxPos,
                trend_side_candidate: localTrendSideCandidate,
                range_side_candidate: localRangeSideCandidate,
                shortAllow: v2State.shortAllow,
                htf_entry_policy: judgment.htf_entry_policy ?? "NONE",
                trendOk: localTrendOk,
                qualityScore: localSnapshot.qualityScore ?? 0,
                emaGap: localEmaGap,
                retestConfirmed,
                reclaimConfirmed,
                reviewingTicks: localSnapshot.reviewing_ticks ?? 0,
                setup_passed,
                setup_fail_reason,
                entryCandidate: localSnapshot.entryCandidate === true,
                stopPrice: execution.stopPrice,
                signed_execution_ready: v2State.signedExecutionReady === true
            }));
        }

        if (
            shouldEmitV2Proof(
                "V2_TRANSITION_EXECUTOR_PROOF",
                String(input.symbol),
                transitionProofKey,
                transitionAction === "CONFIRM" || execution.signal === "WAIT_RECHECK"
            )
        ) {
            console.info(JSON.stringify({
                event: "V2_TRANSITION_EXECUTOR_PROOF",
                symbol: String(input.symbol),
                market_subtype: judgment.subtype,
                transitionPhase: transitionMeta.transitionPhase ?? judgment.transitionPhase ?? "NONE",
                transitionSetupType: transitionMeta.transitionSetupType ?? "NONE",
                transitionAction,
                signal: execution.signal,
                side: execution.side,
                reason: execution.reason,
                baseSizeIntent: execution.baseSizeIntent,
                isAddOnEligible: execution.isAddOnEligible,
                transitionWatchOnly: transitionMeta.transitionWatchOnly ?? null,
                transitionConfirmRequired: transitionMeta.transitionConfirmRequired ?? null,
                transitionRejectReason: transitionMeta.transitionRejectReason ?? null,
                transition_confirm_basis: transitionMeta.transitionConfirmBasis ?? "insufficient",
                transition_preflight_safety_passed: transitionMeta.transitionPreflightSafetyPassed ?? false,
                transition_preflight_block_reason: transitionMeta.transitionPreflightBlockReason ?? null,
                emaGap: transitionMeta.emaGap ?? authoritativeInput.snapshot?.emaGap ?? null,
                trendWeaknessScore: transitionMeta.trendWeaknessScore ?? authoritativeInput.snapshot?.trendWeaknessScore ?? null,
                rangeConfidence: transitionMeta.rangeConfidence ?? authoritativeInput.snapshot?.rangeConfidence ?? null,
                boxCohesion01: transitionMeta.boxCohesion01 ?? authoritativeInput.snapshot?.boxCohesion01 ?? null,
                breakoutFailureRate: transitionMeta.breakoutFailureRate ?? authoritativeInput.snapshot?.breakoutFailureRate ?? null,
                boxPos: transitionMeta.boxPos ?? authoritativeInput.snapshot?.boxPos ?? null,
                boxBreakSide: transitionMeta.boxBreakSide ?? authoritativeInput.snapshot?.boxBreakSide ?? null,
                qualityScore: transitionMeta.qualityScore ?? authoritativeInput.snapshot?.qualityScore ?? null,
                reviewingTicks: transitionMeta.reviewingTicks ?? authoritativeInput.snapshot?.reviewing_ticks ?? null,
                directionalShockState: transitionMeta.directionalShockState ?? authoritativeInput.state.directionalShockState ?? null,
                longAllow: transitionMeta.longAllow ?? authoritativeInput.state.longAllow ?? null,
                shortAllow: transitionMeta.shortAllow ?? authoritativeInput.state.shortAllow ?? null
            }));
        }
    }

    // Tier 5: Risk Sizing (executor/risk-sizing share same authoritative state)
    const externalSide: "long" | "short" | "none" =
        execution.side === "long" || execution.side === "short" ? execution.side : "none";
    const externalMarketContext = evaluateExternalMarketContext({
        side: externalSide,
        now: input.now,
        config: {
            enabled: input.config.externalMarketContextEnabled === true,
            shadowMode: input.config.externalMarketContextShadowMode !== false,
            weight: input.config.externalMarketContextWeight ?? 0.22,
            minSizeMultiplier: input.config.externalMarketMinSizeMultiplier ?? 0.8,
            maxSizeMultiplier: input.config.externalMarketMaxSizeMultiplier ?? 1.1,
            maxAgeMs: input.config.externalMarketContextMaxAgeMs ?? 900_000,
            emergencyEventEnabled: input.config.externalMarketEmergencyEventEnabled === true
        },
        snapshot: authoritativeInput.state.externalMarketSnapshot ?? null
    });
    if (input.evaluationMode !== "diagnostic") {
        console.info(
            JSON.stringify(
                buildExternalMarketContextProofLog(
                    String(input.symbol),
                    externalMarketContext,
                    authoritativeInput.state.externalMarketSnapshot ?? null,
                    externalSide
                )
            )
        );
    }
    let confidenceForSizing = confidence;
    if (externalMarketContext.externalContextApplied && externalSide !== "none") {
        const blendedScore = applyExternalContextToConfidenceScore(
            confidence.score,
            externalMarketContext,
            input.config.externalMarketContextWeight ?? 0.22
        );
        confidenceForSizing = {
            score: blendedScore,
            level: blendedScore >= 75 ? "HIGH" : blendedScore < 50 ? "LOW" : "MID"
        };
    }
    const externalSizeMultiplierForSizing =
        externalMarketContext.externalContextApplied && externalSide !== "none"
            ? externalMarketContext.externalSizeMultiplier
            : null;
    const riskSizing = calculateRiskSizing(
        judgment,
        confidenceForSizing,
        execution,
        authoritativeInput,
        externalSizeMultiplierForSizing
    );
    if (riskSizing.diagnostics) {
        (riskSizing.diagnostics as Record<string, unknown>).addon_policy_mode = addOnPolicy.addonMode ?? "NONE";
        (riskSizing.diagnostics as Record<string, unknown>).requested_addon_notional_usdt =
            addOnPolicy.requestedAddonNotionalUsdt ?? null;
    }

    // Tier 5: Explanation (Diagnostics)
    const explanation = generateExplanation(judgment, execution, riskSizing);

    // Final Decision Formulation (Authority Enforcer)
    let finalDecision: EngineV2FinalDecision = "SKIP";
    const isCrashLockish = (state: string): boolean =>
        state.includes("CRASH_LOCK") || state.includes("CRASH_EXIT");
    const isPumpLockish = (state: string): boolean =>
        state.includes("PUMP_ALERT") || state.includes("PUMP_LOCK");

    const rawSignal = input.snapshot?.signal ?? "none";
    const hasRawCandidate =
        rawSignal === "paper_long_candidate" ||
        rawSignal === "paper_short_candidate" ||
        input.snapshot?.entryCandidate === true;

    const hardNoTrade =
        judgment.data_ready === false ||
        judgment.dump_protection_hit === true;

    const softNoTrade =
        judgment.volatility_guard_hit === true ||
        judgment.regime_final === "NO_TRADE" ||
        judgment.no_trade_reason != null;

    const isBlocked = riskSizing.isBlocked;
    const invalidNoneSignal = execution.signal === "NONE";
    const waitingRecheck = execution.signal === "WAIT_RECHECK";
    const invalidSideForEnter = execution.side === "none";
    const invalidSize = riskSizing.stageMarginKrw <= 0;
    let blockReason = riskSizing.blockReason ?? null;

    if (hardNoTrade) {
        finalDecision = "DISABLED";
    } else if (softNoTrade && hasRawCandidate) {
        finalDecision = "HOLD";
    } else if (softNoTrade) {
        finalDecision = "DISABLED";
    } else if (isBlocked && blockReason === "WHIPSAW_SHOCK_RECHECK") {
        finalDecision = "REJECT";
        if (shouldEmitV2Proof("V2_WHIPSAW_SHOCK_RECHECK_PROOF", String(input.symbol), judgment.subtype, true)) {
            console.info(JSON.stringify({
                event: "V2_WHIPSAW_SHOCK_RECHECK_PROOF",
                symbol: String(input.symbol),
                market_subtype: judgment.subtype,
                structural_hit_count: judgment.diagnostics?.structural_hit_count ?? 0,
                confirmation_wait_reasons: judgment.diagnostics?.confirmation_wait_reasons || []
            }));
        }
    } else if (isBlocked && blockReason === "NO_TRADE_REGIME") {
        finalDecision = "DISABLED";
    } else if (isBlocked) {
        finalDecision = "REJECT";
    } else if (waitingRecheck) {
        finalDecision = "HOLD";
    } else if (invalidNoneSignal) {
        finalDecision = "SKIP";
    } else if (invalidSideForEnter) {
        finalDecision = "SKIP";
    } else if (invalidSize) {
        finalDecision = "REJECT";
    } else {
        finalDecision = "ENTER";
    }

    if (softNoTrade && hasRawCandidate && !hardNoTrade) {
        explanation.reason = "SOFT_NO_TRADE_DOWNGRADED_TO_HOLD";
        explanation.summary = "신호는 존재하나 하위 시장 판단이 보수적이므로 즉시 진입 유보 및 확증 대기";
    }

    let finalReason: string;
    if (finalDecision === "ENTER") {
        finalReason = explanation.reason;
    } else if (finalDecision === "HOLD") {
        finalReason = `HOLD: ${explanation.reason || execution.reason}`;
    } else if (finalDecision === "DISABLED") {
        finalReason = `DISABLED: ${judgment.no_trade_reason ?? blockReason ?? judgment.regime}`;
    } else if (finalDecision === "REJECT") {
        finalReason = `REJECTED: ${blockReason ?? execution.reason}`;
    } else {
        finalReason = `SKIPPED: ${execution.reason}`;
    }
    let decisionBeforeReadiness: EngineV2FinalDecision = finalDecision;
    if (blockReason === "EXECUTION_READINESS_FALSE") {
        if (waitingRecheck) decisionBeforeReadiness = "HOLD";
        else if (invalidNoneSignal || invalidSideForEnter) decisionBeforeReadiness = "SKIP";
        else if (invalidSize) decisionBeforeReadiness = "REJECT";
        else decisionBeforeReadiness = "ENTER";
    }

    const v2DecisionBeforePromotion = finalDecision;
    const v2SideBeforePromotion = execution.side;
    const v2RejectReasonBeforePromotion = blockReason;
    let v2DecisionAfterPromotion = finalDecision;
    let v2SideAfterPromotion: EngineV2Side = execution.side;
    let v2RejectReasonAfterPromotion: string | null = blockReason;
    let promotionApplied = false;
    let promotionReason: string | null = null;
    let promotionBlockReason: string | null = null;
    let microProbeBlockReason: string | null = null;
    let promotionMinConditionPassed = false;
    let shockReactionPromotionType: string | null = null;
    let shockReactionBlockReason: string | null = null;
    let shockReactionSetupEvidence: Record<string, unknown> | null = null;
    let countertrendExceptionUsed = false;
    let contaminationSoftened = false;
    let contaminationHardReject = false;
    let contaminationSoftenReason: string | null = null;

    const shock = v2State.directionalShockState ?? "NONE";
    const whipsawShockRecheckActive = judgment.subtype === "WHIPSAW_SHOCK_RECHECK";
    const crashState = String(v2State.crashState ?? "").toUpperCase();
    const pumpStateResolved = String(v2State.pumpState ?? "").toUpperCase();
    const marketMode = String(judgment.regime ?? "UNKNOWN");
    const activeEngineRouting = String(routing.executor ?? "UNKNOWN");
    const qualityScore = Number(input.snapshot?.qualityScore ?? 0);
    const trendWeaknessScore = Number(input.snapshot?.trendWeaknessScore ?? 1);
    const emaGap = Number(input.snapshot?.emaGap ?? 0);
    const trendOk =
        Number.isFinite(emaGap) &&
        Number.isFinite(trendWeaknessScore) &&
        Math.abs(emaGap) >= 0.0004 &&
        trendWeaknessScore < 0.5;
    const entryQualityGrade = riskSizing.entryQualityGrade ?? "B";
    const reviewingTicks = Number(input.snapshot?.reviewing_ticks ?? 0);
    const allowNewLong = Boolean((riskSizing.diagnostics as Record<string, unknown> | undefined)?.allow_new_long ?? v2State.longAllow);
    const allowNewShort = Boolean((riskSizing.diagnostics as Record<string, unknown> | undefined)?.allow_new_short ?? v2State.shortAllow);
    const riskLongAllow = v2State.longAllow;
    const riskShortAllow = v2State.shortAllow;
    const trendSideCandidate: EngineV2Side = deriveTrendSideCandidate(shock, emaGap);
    const execMeta = execution.metadata ?? {};
    const readNullableNumber = (...values: unknown[]): number | null => {
        for (const v of values) {
            if (typeof v === "number" && Number.isFinite(v)) return v;
        }
        return null;
    };
    const readNullableBoolean = (...values: unknown[]): boolean | null => {
        for (const v of values) {
            if (typeof v === "boolean") return v;
        }
        return null;
    };
    const boxPos = readNullableNumber(execMeta.boxPos, input.snapshot?.boxPos);
    const rangeLowerThreshold = 0.26;
    const rangeUpperThreshold = 0.74;
    const boxBreakSide =
        typeof execMeta.boxBreakSide === "string"
            ? String(execMeta.boxBreakSide)
            : typeof input.snapshot?.boxBreakSide === "string"
                ? String(input.snapshot.boxBreakSide)
                : "none";
    // Canonical RANGE zone: classifyRangeZone(boxPos). Executor metadata may not match legacy zone (V2 inconsistency prevention).
    const zone = boxPos == null || !Number.isFinite(boxPos) ? ("mid" as const) : classifyRangeZone(boxPos);
    const rangeConfidence = readNullableNumber(execMeta.rangeConfidence, input.snapshot?.rangeConfidence);
    const boxCohesion01 = readNullableNumber(execMeta.boxCohesion01, input.snapshot?.boxCohesion01);
    const trendWeaknessFromMeta = readNullableNumber(execMeta.trendWeaknessScore, input.snapshot?.trendWeaknessScore);
    const relaxedRangeEntry = readNullableBoolean(execMeta.relaxedRangeEntry) === true;
    const reversalConfirmed = readNullableBoolean(execMeta.reversal_confirmed) === true;
    const sideZoneValidMeta = readNullableBoolean(execMeta.sideZoneValid);
    const sideZoneValid =
        sideZoneValidMeta != null
            ? sideZoneValidMeta
            : ((zone === "lower" && allowNewLong && riskLongAllow) || (zone === "upper" && allowNewShort && riskShortAllow));
    const rangeMetadataSource =
        execMeta.rangeConfidence != null ||
            execMeta.boxCohesion01 != null ||
            execMeta.trendWeaknessScore != null ||
            execMeta.boxPos != null ||
            execMeta.reversal_confirmed != null ||
            execMeta.relaxedRangeEntry != null
            ? "executor_metadata"
            : "snapshot_fallback";
    const rangeMetadataMissingFields = [
        rangeConfidence == null ? "rangeConfidence" : null,
        boxCohesion01 == null ? "boxCohesion01" : null,
        trendWeaknessFromMeta == null ? "trendWeaknessScore" : null,
        boxPos == null ? "boxPos" : null
    ].filter((x): x is string => x != null);
    const signalGateBlockedReason =
        typeof input.snapshot?.signalGateBlockedReason === "string"
            ? input.snapshot.signalGateBlockedReason
            : null;
    const rangeSignalDowngraded = input.snapshot?.rangeSignalDowngraded === true;
    const rangeSignalKeptByRelax = input.snapshot?.rangeSignalKeptByRelax === true;
    const entryCandidate = input.snapshot?.entryCandidate === true;
    const rangeSideCandidate: EngineV2Side =
        zone === "lower" && allowNewLong && riskLongAllow ? "long" :
            zone === "upper" && allowNewShort && riskShortAllow ? "short" : "none";
    const rangeEdgeExtreme =
        (rangeSideCandidate === "long" && (boxPos ?? 0.5) <= 0.08) ||
            (rangeSideCandidate === "short" && (boxPos ?? 0.5) >= 0.92);
    const alignedSignal =
        trendSideCandidate === "short" ? "paper_short_candidate" :
            trendSideCandidate === "long" ? "paper_long_candidate" : "none";

    const readinessDiag = (riskSizing.diagnostics ?? {}) as Record<string, unknown>;
    const isLiveExecution = v2State.okxLiveEnabled === true || readinessDiag.okx_live_enabled === true;
    const paperExecutionReady = readinessDiag.paper_execution_ready === true;
    const signedExecutionReady = isLiveExecution ? readinessDiag.signed_execution_ready === true : true;
    const hardControlClear =
        paperExecutionReady === true &&
        v2State.serverTradeEnabled === true &&
        v2State.closeOnlyMode !== true &&
        v2State.killSwitch !== true &&
        v2State.reconcileSafeMode !== true &&
        String(v2State.riskMode ?? "").toUpperCase() !== "HALT" &&
        v2State.dailyLossGuardTriggered !== true;

    // Fix 1. stale FRESH_TICK block cleanup
    if (v2RejectReasonAfterPromotion === "FRESH_TICK_EXECUTION_BLOCKED" || v2RejectReasonAfterPromotion === "FRESH_TICK_BARRIER_ACTIVE") {
        const isActuallyBlocked =
            v2State.freshTickExecutionBlocked === true ||
            v2State.freshTickBarrierActive === true ||
            paperExecutionReady !== true;

        const canClear =
            paperExecutionReady === true &&
            signedExecutionReady === true &&
            v2State.freshTickBarrierActive !== true &&
            v2State.freshTickExecutionBlocked !== true;

        if (canClear && !isActuallyBlocked) {
            const reasonBefore = v2RejectReasonAfterPromotion;
            v2RejectReasonAfterPromotion = null;
            console.info(JSON.stringify({
                event: "FRESH_TICK_STALE_BLOCK_CLEARED_PROOF",
                symbol: String(input.symbol),
                reason_before: reasonBefore,
                paper_execution_ready: paperExecutionReady,
                signed_execution_ready: signedExecutionReady,
                barrier_active: v2State.freshTickBarrierActive,
                execution_blocked: v2State.freshTickExecutionBlocked
            }));
        }
    }

    const unpromotableRejectReasons = new Set<string>([
        "ENTRY_QUALITY_CONTAMINATED_SIMILAR",
        "CRASH_ENTRY_GUARD_BLOCK",
        "RISK_EXPOSURE_CAP_PRE_SUBMIT",
        "ORDER_BUILD_FAIL",
        "FRESH_TICK_EXECUTION_BLOCKED",
        "FRESH_TICK_BARRIER_ACTIVE",
        "WHIPSAW_SHOCK_RECHECK"
    ]);
    const hardBlockReasons = new Set<string>([
        "CRASH_ENTRY_GUARD_BLOCK",
        "RISK_EXPOSURE_CAP_PRE_SUBMIT",
        "ORDER_BUILD_FAIL",
        "MAX_SLOTS_REACHED",
        "MIN_ORDER_SIZE_UNDERFLOW",
        "SERVER_TRADE_DISABLED",
        "CLOSE_ONLY_MODE",
        "KILL_SWITCH_ACTIVE",
        "RECONCILE_SAFE_MODE",
        "RISK_MODE_HALT",
        "DAILY_LOSS_GUARD",
        "FRESH_TICK_EXECUTION_BLOCKED",
        "FRESH_TICK_BARRIER_ACTIVE",
        "WHIPSAW_SHOCK_RECHECK"
    ]);
    if (v2RejectReasonAfterPromotion === "WHIPSAW_SHOCK_RECHECK_TRANSITION_HOLD") v2RejectReasonAfterPromotion = "WHIPSAW_SHOCK_RECHECK";

    let hardBlockPresent =
        !hardControlClear ||
        (v2RejectReasonAfterPromotion != null && hardBlockReasons.has(v2RejectReasonAfterPromotion));
    let hardBlockReason =
        !hardControlClear
            ? "HARD_CONTROL_NOT_CLEAR"
            : (v2RejectReasonAfterPromotion != null && hardBlockReasons.has(v2RejectReasonAfterPromotion)
                ? v2RejectReasonAfterPromotion
                : null);
    const entryQualityDiag = (riskSizing.diagnostics ?? {}) as Record<string, unknown>;
    const profitDistance = typeof entryQualityDiag.entry_quality_distance_profit === "number"
        ? entryQualityDiag.entry_quality_distance_profit
        : null;
    const lossDistance = typeof entryQualityDiag.entry_quality_distance_loss === "number"
        ? entryQualityDiag.entry_quality_distance_loss
        : null;
    const contaminatedDistance = typeof entryQualityDiag.entry_quality_distance_contaminated === "number"
        ? entryQualityDiag.entry_quality_distance_contaminated
        : null;
    const trendShockAligned =
        shock === "NONE" ||
        (shock === "UP" && trendSideCandidate === "long") ||
        (shock === "DOWN" && trendSideCandidate === "short");
    // Paper shock override can force TREND while V2 routeToExecutor stays RANGE — trend authority must not inherit RANGE zone vetoes.
    const trendRoutingAuthority =
        activeEngineRouting === "TREND" ||
        (shock !== "NONE" && trendShockAligned && trendSideCandidate !== "none" && trendOk);
    const isTrendAuthorityCandidate =
        trendSideCandidate !== "none" &&
        trendOk &&
        trendShockAligned &&
        (entryQualityGrade === "S" || entryQualityGrade === "A" || qualityScore >= 80);
    const rangeSideAligned =
        (zone === "lower" && rangeSideCandidate === "long") ||
        (zone === "upper" && rangeSideCandidate === "short");
    const rangePromotableContext = rangeSideAligned || rangeEdgeExtreme;
    const rangeContextActive = activeEngineRouting === "RANGE" || marketMode === "RANGE";
    const shockDownActive = shock === "DOWN";
    const shockUpActive = shock === "UP";
    const shockDownRangeMidWatch =
        shockDownActive &&
        rangeContextActive &&
        zone === "mid" &&
        isCrashLockish(crashState);
    const shockUpRangeMidWatch =
        shockUpActive &&
        rangeContextActive &&
        zone === "mid" &&
        isPumpLockish(pumpStateResolved);
    const shockReactionWatchActive = shockDownRangeMidWatch || shockUpRangeMidWatch;
    const shockReactionDirection: "DOWN" | "UP" | "NONE" =
        shockDownActive ? "DOWN" : shockUpActive ? "UP" : "NONE";
    const shockReactionAllowedPrimarySide: EngineV2Side =
        shockReactionDirection === "DOWN" ? "short" : shockReactionDirection === "UP" ? "long" : "none";
    const shockEdgeSetupActiveReason: string[] = [];
    if (shockReactionDirection !== "NONE") shockEdgeSetupActiveReason.push("directional_shock_only");
    if (isCrashLockish(crashState)) shockEdgeSetupActiveReason.push("crash_lockish_watch");
    if (isPumpLockish(pumpStateResolved)) shockEdgeSetupActiveReason.push("pump_lockish_watch");
    const crashRecoveryHintFromState =
        crashState.includes("CRASH_REDUCE") ||
        crashState.includes("CRASH_RECOVERY");
    const pumpRecoveryHintFromState =
        pumpStateResolved.includes("PUMP_REDUCE") ||
        pumpStateResolved.includes("PUMP_RECOVERY");
    const shockRecoveryHint =
        relaxedRangeEntry ||
        reversalConfirmed ||
        crashRecoveryHintFromState ||
        pumpRecoveryHintFromState ||
        (typeof execMeta.crash_lock_bypass_reason === "string" && execMeta.crash_lock_bypass_reason.length > 0) ||
        (typeof execMeta.override_reason === "string" && execMeta.override_reason.length > 0);
    if (shockRecoveryHint) shockEdgeSetupActiveReason.push("recovery_hint_present");

    const edgeUpper = (boxPos ?? 0.5) >= 0.92 || zone === "upper";
    const edgeLower = (boxPos ?? 0.5) <= 0.08 || zone === "lower";
    const downUpperFailureShort =
        shockDownActive &&
        rangeContextActive &&
        edgeUpper &&
        (reversalConfirmed || relaxedRangeEntry || trendSideCandidate === "short");
    const downLowerBreakdownContinuationShort =
        shockDownActive &&
        rangeContextActive &&
        (zone === "lower" || boxBreakSide === "lower") &&
        emaGap < 0 &&
        trendSideCandidate === "short";
    const downLowerReversalConfirmedLong =
        shockDownActive &&
        rangeContextActive &&
        edgeLower &&
        reversalConfirmed &&
        shockRecoveryHint;
    const upLowerSupportLong =
        shockUpActive &&
        rangeContextActive &&
        edgeLower &&
        (reversalConfirmed || relaxedRangeEntry || trendSideCandidate === "long");
    const upUpperBreakoutContinuationLong =
        shockUpActive &&
        rangeContextActive &&
        (zone === "upper" || boxBreakSide === "upper") &&
        emaGap > 0 &&
        trendSideCandidate === "long";
    const upUpperReversalConfirmedShort =
        shockUpActive &&
        rangeContextActive &&
        edgeUpper &&
        reversalConfirmed &&
        shockRecoveryHint;

    // Shock reaction watch dry-run matrix (symmetry):
    // - DOWN + RANGE mid => HOLD/WAIT_RECHECK, no ENTER
    // - UP + RANGE mid => HOLD/WAIT_RECHECK, no ENTER
    // - DOWN + upper failure => short candidate setup
    // - DOWN + lower breakdown => short candidate setup
    // - DOWN + lower reversal confirmed => limited long exception setup
    // - UP + lower support => long candidate setup
    // - UP + upper breakout => long candidate setup
    // - UP + upper reversal confirmed => limited short exception setup

    if (hardControlClear) {
        if (shockReactionWatchActive) {
            const shockUpMidMomentumConfirmed =
                shock === "UP" &&
                trendSideCandidate === "long" &&
                riskLongAllow === true &&
                allowNewLong === true &&
                emaGap > 0 &&
                qualityScore >= 70 &&
                trendWeaknessScore < 0.65 &&
                !pumpStateResolved.includes("ULTRA") &&
                !pumpStateResolved.includes("CRITICAL") &&
                hardBlockPresent === false;

            const shockDownMidMomentumConfirmed =
                shock === "DOWN" &&
                trendSideCandidate === "short" &&
                riskShortAllow === true &&
                allowNewShort === true &&
                emaGap < 0 &&
                qualityScore >= 60 && // Adjust: 70 -> 60 softened
                trendOk === true &&   // Adjust: trendOk condition specified
                paperExecutionReady === true && // Adjust: execution ready condition specified
                trendWeaknessScore < 0.75 && // Adjust: slightly softened (0.65 -> 0.75)
                !crashState.includes("ULTRA") &&
                !crashState.includes("CRITICAL") &&
                hardBlockPresent === false;

            if (shockUpMidMomentumConfirmed) {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = "long";
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "SHOCK_REACTION_UP_MID_MOMENTUM_CONFIRMED";
                shockReactionPromotionType = "MID_MOMENTUM_CONFIRMED";
                shockReactionBlockReason = null;
                promotionBlockReason = null;
                console.info(JSON.stringify({
                    event: "V2_SHOCK_REACTION_SHORT_PROMOTION_PROOF",
                    symbol: String(input.symbol),
                    shock_state: shock,
                    side: "long",
                    zone: zone,
                    quality_score: qualityScore,
                    promotion_reason: "SHOCK_REACTION_UP_MID_MOMENTUM_CONFIRMED"
                }));
            } else if (shockDownMidMomentumConfirmed) {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = "short";
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "SHOCK_REACTION_DOWN_MID_MOMENTUM_CONFIRMED";
                shockReactionPromotionType = "MID_MOMENTUM_CONFIRMED";
                shockReactionBlockReason = null;
                promotionBlockReason = null;
                console.info(JSON.stringify({
                    event: "V2_SHOCK_REACTION_SHORT_PROMOTION_PROOF",
                    symbol: String(input.symbol),
                    shock_state: shock,
                    side: "short",
                    zone: zone,
                    quality_score: qualityScore,
                    promotion_reason: "SHOCK_REACTION_DOWN_MID_MOMENTUM_CONFIRMED"
                }));
            } else {
                shockReactionBlockReason = "SHOCK_REACTION_WATCH_MID_CHASE_BLOCKED";
                if (promotionBlockReason == null) promotionBlockReason = shockReactionBlockReason;

                expectedMissingCondition = shockReactionBlockReason;
                if (shock === "DOWN") {
                    expectedNextAction = "WAIT_FOR_BREAKDOWN_RETEST_FAILURE";
                } else if (shock === "UP") {
                    expectedNextAction = "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION";
                }

                if (v2DecisionAfterPromotion === "ENTER" || v2DecisionAfterPromotion === "SKIP") {
                    v2DecisionAfterPromotion = "HOLD";
                }
                v2RejectReasonAfterPromotion = "WAIT_RECHECK";
            }

            console.info(JSON.stringify({
                event: "SHOCK_REACTION_WATCH_PROOF",
                symbol: String(input.symbol),
                directional_shock_state: shock,
                crash_state: crashState || null,
                pump_state: pumpStateResolved || null,
                market_mode: marketMode,
                active_engine_routing: activeEngineRouting,
                boxPos,
                zone,
                side_before: v2SideBeforePromotion,
                side_after: v2SideAfterPromotion,
                decision_before: v2DecisionBeforePromotion,
                decision_after: v2DecisionAfterPromotion,
                promotion_applied: promotionApplied,
                promotion_type: shockReactionPromotionType,
                promotion_block_reason: promotionBlockReason,
                reversal_confirmed: reversalConfirmed,
                relaxedRangeEntry,
                range_edge_extreme: rangeEdgeExtreme,
                side_zone_valid: sideZoneValid,
                hard_block_present: hardBlockPresent,
                hard_block_reason: hardBlockReason,
                shock_reaction_watch_active: shockReactionWatchActive,
                shock_reaction_reason: promotionApplied ? promotionReason : "range_mid_requires_reaction_watch",
                shock_edge_setup_active_reason: shockEdgeSetupActiveReason.length > 0 ? shockEdgeSetupActiveReason.join("|") : null,
                shock_reaction_allowed_primary_side: shockReactionAllowedPrimarySide,
                shock_reaction_blocked_chase_reason: promotionApplied ? null : "mid_chase_forbidden",
                shock_reaction_next_valid_setups:
                    shockReactionDirection === "DOWN"
                        ? "upper_failure_short|lower_breakdown_short|lower_reversal_confirmed_long"
                        : "lower_support_long|upper_breakout_long|upper_reversal_confirmed_short",
                shock_reaction_promotion_type: shockReactionPromotionType
            }));
            console.info(JSON.stringify({
                event: "SHOCK_REACTION_BLOCKED_MID_CHASE_PROOF",
                symbol: String(input.symbol),
                directional_shock_state: shock,
                crash_state: crashState || null,
                pump_state: pumpStateResolved || null,
                market_mode: marketMode,
                active_engine_routing: activeEngineRouting,
                boxPos,
                zone,
                promotion_block_reason: promotionBlockReason
            }));
            console.info(JSON.stringify({
                event: "SHOCK_REACTION_SYMMETRY_PROOF",
                symbol: String(input.symbol),
                directional_shock_state: shock,
                crash_state: crashState || null,
                pump_state: pumpStateResolved || null,
                market_mode: marketMode,
                active_engine_routing: activeEngineRouting,
                boxPos,
                zone,
                down_watch_active: shockDownRangeMidWatch,
                up_watch_active: shockUpRangeMidWatch,
                shock_reaction_watch_active: shockReactionWatchActive,
                shock_reaction_direction: shockReactionDirection,
                setup_type: null,
                setup_block_reason: promotionBlockReason,
                allowed_primary_side: shockReactionAllowedPrimarySide,
                countertrend_exception_used: false
            }));
        }

        // Shock edge setups (independent of generic promotion): no mid chase, edge-only continuation/reversal.
        if (
            !shockReactionWatchActive &&
            shockReactionDirection !== "NONE" &&
            rangeContextActive &&
            (v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "HOLD")
        ) {
            const continuationQualityOk = qualityScore >= 65 || reviewingTicks >= 1;
            let setupType: string | null = null;
            let setupSide: EngineV2Side = "none";
            let setupEvidence: Record<string, unknown> = {};
            let setupBlockReason: string | null = null;
            let allowedPrimarySide: EngineV2Side = shockReactionAllowedPrimarySide;
            let countertrendUsed = false;

            if (shockReactionDirection === "DOWN") {
                if (downUpperFailureShort && (allowNewShort || riskShortAllow) && continuationQualityOk) {
                    setupType = "upper_failure_short";
                    setupSide = "short";
                    setupEvidence = { edgeUpper, reversalConfirmed, relaxedRangeEntry };
                } else if (downLowerBreakdownContinuationShort && (allowNewShort || riskShortAllow) && continuationQualityOk) {
                    setupType = "lower_breakdown_continuation_short";
                    setupSide = "short";
                    setupEvidence = { boxBreakSide, emaGap, trend_side_candidate: trendSideCandidate };
                } else if (downLowerReversalConfirmedLong && false) { // ?섏젙: SHOCK_REACTION_DOWN?먯꽌 long 諛곗젣
                    setupType = "lower_reversal_confirmed_long";
                    setupSide = "long";
                    countertrendUsed = true;
                    setupEvidence = { edgeLower, reversalConfirmed, shockRecoveryHint };
                } else {
                    setupBlockReason = "SHOCK_REACTION_SETUP_NOT_READY_DOWN";
                }
            } else if (shockReactionDirection === "UP") {
                if (upLowerSupportLong && (allowNewLong || riskLongAllow) && continuationQualityOk) {
                    setupType = "lower_support_long";
                    setupSide = "long";
                    setupEvidence = { edgeLower, reversalConfirmed, relaxedRangeEntry };
                } else if (upUpperBreakoutContinuationLong && (allowNewLong || riskLongAllow) && continuationQualityOk) {
                    setupType = "upper_breakout_continuation_long";
                    setupSide = "long";
                    setupEvidence = { boxBreakSide, emaGap, trend_side_candidate: trendSideCandidate };
                } else if (upUpperReversalConfirmedShort) {
                    setupType = "upper_reversal_confirmed_short";
                    setupSide = "short";
                    countertrendUsed = true;
                    setupEvidence = { edgeUpper, reversalConfirmed, shockRecoveryHint };
                } else {
                    setupBlockReason = "SHOCK_REACTION_SETUP_NOT_READY_UP";
                }
            }

            if (setupType != null && setupSide !== "none") {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = setupSide;
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = `SHOCK_REACTION_${setupType}`;
                promotionMinConditionPassed = true;
                shockReactionPromotionType = setupType;
                shockReactionSetupEvidence = setupEvidence;
                countertrendExceptionUsed = countertrendUsed;
                shockReactionBlockReason = null;
                promotionBlockReason = null;

                if (shock === "DOWN" && setupSide === "short") {
                    console.info(JSON.stringify({
                        event: "V2_SHOCK_REACTION_SHORT_PROMOTION_PROOF",
                        symbol: String(input.symbol),
                        shock_state: shock,
                        side: "short",
                        zone: zone,
                        quality_score: qualityScore,
                        promotion_reason: promotionReason
                    }));
                }
            } else if (setupBlockReason != null) {
                v2DecisionAfterPromotion = "HOLD";
                v2SideAfterPromotion = "none";
                v2RejectReasonAfterPromotion = "WAIT_RECHECK";
                promotionApplied = false;
                promotionReason = null;
                promotionMinConditionPassed = false;
                shockReactionPromotionType = null;
                shockReactionSetupEvidence = null;
                countertrendExceptionUsed = false;
                shockReactionBlockReason = setupBlockReason;
                if (promotionBlockReason == null) promotionBlockReason = setupBlockReason;
            }
            if (setupType != null || setupBlockReason != null) {
                console.info(JSON.stringify({
                    event: "SHOCK_REACTION_SYMMETRY_PROOF",
                    symbol: String(input.symbol),
                    directional_shock_state: shock,
                    crash_state: crashState || null,
                    pump_state: pumpStateResolved || null,
                    market_mode: marketMode,
                    active_engine_routing: activeEngineRouting,
                    boxPos,
                    zone,
                    down_watch_active: shockDownRangeMidWatch,
                    up_watch_active: shockUpRangeMidWatch,
                    shock_reaction_watch_active: shockReactionWatchActive,
                    shock_reaction_direction: shockReactionDirection,
                    setup_type: setupType,
                    setup_block_reason: setupBlockReason,
                    shock_edge_setup_active_reason: shockEdgeSetupActiveReason.length > 0 ? shockEdgeSetupActiveReason.join("|") : null,
                    allowed_primary_side: allowedPrimarySide,
                    countertrend_exception_used: countertrendUsed
                }));
            }
        }
        if (v2RejectReasonAfterPromotion != null && unpromotableRejectReasons.has(v2RejectReasonAfterPromotion)) {
            promotionBlockReason = v2RejectReasonAfterPromotion;
        }
        if (v2RejectReasonAfterPromotion === "ENTRY_QUALITY_CONTAMINATED_SIMILAR") {
            const contaminatedClearlyDominant =
                profitDistance != null && contaminatedDistance != null
                    ? contaminatedDistance <= profitDistance * 1.005
                    : false;
            const nearlyEqualToLoss =
                lossDistance != null && contaminatedDistance != null
                    ? contaminatedDistance <= lossDistance * 1.005
                    : false;
            const sideZoneInvalid = activeEngineRouting === "RANGE" && (!sideZoneValid || zone === "mid");
            const explicitHardContamination =
                qualityScore < 70 ||
                sideZoneInvalid ||
                (contaminatedClearlyDominant && nearlyEqualToLoss);
            contaminationHardReject = explicitHardContamination;
            const highQualitySoftenEligible =
                (entryQualityGrade === "S" || entryQualityGrade === "A") &&
                qualityScore >= 80 &&
                paperExecutionReady === true &&
                !hardBlockPresent &&
                v2State.serverTradeEnabled === true &&
                ((activeEngineRouting === "TREND" && trendShockAligned && trendSideCandidate !== "none") ||
                    (activeEngineRouting === "RANGE" && rangePromotableContext));
            if (highQualitySoftenEligible && !explicitHardContamination) {
                contaminationSoftened = true;
                contaminationSoftenReason = "V2_CONTAMINATION_SOFTENED_FOR_HIGH_QUALITY_AUTHORITY";
                v2DecisionAfterPromotion = "HOLD";
                v2RejectReasonAfterPromotion = null;
                promotionBlockReason = null;
            } else if (entryQualityGrade === "B" && !explicitHardContamination) {
                contaminationSoftened = true;
                contaminationSoftenReason = "V2_CONTAMINATION_B_GRADE_REVIEW";
                v2DecisionAfterPromotion = "HOLD";
                v2RejectReasonAfterPromotion = "WAIT_RECHECK";
                promotionBlockReason = null;
            } else if (explicitHardContamination) {
                promotionBlockReason = "ENTRY_QUALITY_CONTAMINATED_SIMILAR";
            }
        }
        const trendPromotionCandidate =
            promotionBlockReason == null &&
            !shockReactionWatchActive &&
            (v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "HOLD" || v2SideAfterPromotion === "none") &&
            (v2RejectReasonAfterPromotion === "WAIT_RECHECK" || v2RejectReasonAfterPromotion == null || contaminationSoftened) &&
            trendRoutingAuthority &&
            trendSideCandidate !== "none" &&
            trendOk;
        if (trendPromotionCandidate && trendShockAligned) {
            if (entryQualityGrade === "S" || entryQualityGrade === "A") {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = trendSideCandidate;
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = contaminationSoftened
                    ? "V2_CONTAMINATION_SOFTENED_FOR_HIGH_QUALITY_AUTHORITY"
                    : "V2_TREND_QUALIFIED_FINAL_PROMOTION";
                promotionMinConditionPassed = true;
            } else if (entryQualityGrade === "B" && (reviewingTicks >= 2 || qualityScore >= 78)) {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = trendSideCandidate;
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "V2_TREND_QUALIFIED_FINAL_PROMOTION";
                promotionMinConditionPassed = true;
            }
        }

        const rangePromotionCandidate =
            promotionBlockReason == null &&
            !shockReactionWatchActive &&
            (v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "HOLD" || v2SideAfterPromotion === "none") &&
            activeEngineRouting === "RANGE" &&
            rangeSideCandidate !== "none" &&
            zone !== "mid" &&
            sideZoneValid &&
            (rangeConfidence ?? 0) >= 0.65 &&
            (boxCohesion01 ?? 0) >= 0.9 &&
            (trendWeaknessFromMeta ?? 0) >= 0.7 &&
            (
                (
                    qualityScore >= 80 &&
                    (
                        relaxedRangeEntry ||
                        reversalConfirmed ||
                        ((rangeConfidence ?? 0) >= 0.70 && rangeSideCandidate === "long" && (boxPos ?? 1) <= 0.08) ||
                        ((rangeConfidence ?? 0) >= 0.70 && rangeSideCandidate === "short" && (boxPos ?? 0) >= 0.92)
                    )
                ) ||
                (
                    entryQualityGrade === "B" &&
                    (
                        qualityScore >= 78 ||
                        reviewingTicks >= 2 ||
                        ((rangeConfidence ?? 0) >= 0.70 && sideZoneValid && rangeEdgeExtreme)
                    )
                )
            );
        if (rangePromotionCandidate) {
            v2DecisionAfterPromotion = "ENTER";
            v2SideAfterPromotion = rangeSideCandidate;
            v2RejectReasonAfterPromotion = null;
            promotionApplied = true;
            promotionReason = contaminationSoftened
                ? "V2_CONTAMINATION_SOFTENED_FOR_HIGH_QUALITY_AUTHORITY"
                : "V2_RANGE_QUALIFIED_FINAL_PROMOTION";
            promotionMinConditionPassed = true;
        }

        const saCandidateSide: EngineV2Side =
            activeEngineRouting === "RANGE" ? (rangeSideCandidate !== "none" ? rangeSideCandidate : trendSideCandidate) :
            activeEngineRouting === "TREND" ? trendSideCandidate :
            (trendSideCandidate !== "none" ? trendSideCandidate : rangeSideCandidate);

        const saPromotionNeeded =
            (entryQualityGrade === "S" || entryQualityGrade === "A") &&
            saCandidateSide !== "none" &&
            !shockReactionWatchActive &&
            (v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "HOLD") &&
            v2SideAfterPromotion === "none";
        if (saPromotionNeeded) {
            v2DecisionAfterPromotion = "ENTER";
            v2SideAfterPromotion = saCandidateSide;
            v2RejectReasonAfterPromotion = null;
            promotionApplied = true;
            promotionReason = promotionReason ?? "V2_TREND_QUALIFIED_FINAL_PROMOTION";
            promotionMinConditionPassed = true;
        }

        if (shock === "DOWN" && v2DecisionAfterPromotion === "ENTER") {
            const downCounterTrendLongAllowed =
                v2SideAfterPromotion === "long" &&
                (zone === "lower" || rangeEdgeExtreme) &&
                reversalConfirmed &&
                shockRecoveryHint &&
                false; // ?섏젙: DOWN shock?먯꽌??long 臾댁“嫄?李⑤떒
            if (v2SideAfterPromotion !== "short" && !downCounterTrendLongAllowed) {
                v2DecisionAfterPromotion = "HOLD";
                v2SideAfterPromotion = "none";
                v2RejectReasonAfterPromotion = "WAIT_RECHECK";
                promotionApplied = false;
                promotionReason = null;
                promotionMinConditionPassed = false;
                shockReactionBlockReason = "DOWN_SHOCK_COUNTERTREND_LONG_NOT_CONFIRMED";
                promotionBlockReason = shockReactionBlockReason;
                countertrendExceptionUsed = false;
            }
        }
        if (shock === "UP" && v2DecisionAfterPromotion === "ENTER") {
            const upCounterTrendShortAllowed =
                v2SideAfterPromotion === "short" &&
                (zone === "upper" || rangeEdgeExtreme) &&
                reversalConfirmed &&
                shockRecoveryHint;
            if (v2SideAfterPromotion !== "long" && !upCounterTrendShortAllowed) {
                v2DecisionAfterPromotion = "HOLD";
                v2SideAfterPromotion = "none";
                v2RejectReasonAfterPromotion = "WAIT_RECHECK";
                promotionApplied = false;
                promotionReason = null;
                promotionMinConditionPassed = false;
                shockReactionBlockReason = "UP_SHOCK_COUNTERTREND_SHORT_NOT_CONFIRMED";
                promotionBlockReason = shockReactionBlockReason;
                countertrendExceptionUsed = false;
            }
        }

        // ?섏젙 2. 怨듯넻 V2 probe ENTER 寃쎈줈 異붽?
        const hasSameSidePosition = v2State.currentPositions.some(p => p.symbol === input.symbol && String(p.side).toLowerCase() === trendSideCandidate);
        const hasOppositeSidePosition = v2State.currentPositions.some(p => p.symbol === input.symbol && String(p.side).toLowerCase() !== trendSideCandidate);

        const execMetaForBoundary = execMeta as Record<string, unknown>;
        const judgmentMetaForBoundary = (judgment.metadata ?? {}) as Record<string, unknown>;
        const authSnapForBoundary = authoritativeInput.snapshot as unknown as Record<string, unknown>;
        const inputSnapForBoundary = input.snapshot as unknown as Record<string, unknown>;
        const continuationStateForBoundary = rangeContinuationStateMap.get(String(input.symbol));
        const boundaryClosedClose =
            typeof authSnapForBoundary.closedClose === "number"
                ? authSnapForBoundary.closedClose
                : (typeof inputSnapForBoundary.closedClose === "number"
                    ? inputSnapForBoundary.closedClose
                    : null);
        const rangeBoundaryCtx: RangeBoundaryContinuationContext = {
            trendSideCandidate,
            zone,
            boxBreakSide,
            boxLow: Number(authSnapForBoundary.boxLow ?? inputSnapForBoundary.boxLow ?? 0),
            boxHigh: Number(authSnapForBoundary.boxHigh ?? inputSnapForBoundary.boxHigh ?? 0),
            closedClose: boundaryClosedClose,
            lastPrice: Number(authSnapForBoundary.lastPrice ?? inputSnapForBoundary.lastPrice ?? 0),
            previousConfirmedBoxLow: continuationStateForBoundary?.previousConfirmedBoxLow ?? null,
            previousConfirmedBoxHigh: continuationStateForBoundary?.previousConfirmedBoxHigh ?? null,
            emaGap,
            htfEntryPolicy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
            htfRequiresStrongerConfirmation: judgment.htf_requires_stronger_confirmation === true,
            counterTrendRisk: judgment.counter_trend_risk === true,
            riskLongAllow,
            riskShortAllow,
            allowNewLong,
            allowNewShort,
            whipsawShockRecheckActive,
            hardBlockPresent,
            paperExecutionReady,
            signedExecutionReady,
            hasSameSidePosition,
            hasOppositeSidePosition,
            judgmentSubtype: String(judgment.subtype ?? ""),
            rangePhase: judgment.rangePhase ?? null,
            transitionPhase: judgment.transitionPhase ?? null,
            continuationDirection:
                typeof execMetaForBoundary.continuationDirection === "string"
                    ? String(execMetaForBoundary.continuationDirection)
                    : continuationStateForBoundary?.direction ?? null,
            continuationPhase:
                typeof execMetaForBoundary.continuationPhase === "string"
                    ? String(execMetaForBoundary.continuationPhase)
                    : continuationStateForBoundary?.phase ?? null,
            retestConfirmed:
                execMetaForBoundary.retest_confirmed === true ||
                judgmentMetaForBoundary.retestConfirmed === true ||
                authSnapForBoundary.retestConfirmed === true ||
                inputSnapForBoundary.retestConfirmed === true,
            retestTouched:
                execMetaForBoundary.retestTouched === true ||
                judgmentMetaForBoundary.retestTouched === true ||
                authSnapForBoundary.retestTouched === true ||
                inputSnapForBoundary.retestTouched === true,
            retestRejected:
                execMetaForBoundary.retestRejected === true ||
                judgmentMetaForBoundary.retestRejected === true ||
                authSnapForBoundary.retestRejected === true ||
                inputSnapForBoundary.retestRejected === true,
            reversalConfirmed,
            execReason: typeof execution.reason === "string" ? execution.reason : null,
            lateChaseBlocked: execMetaForBoundary.late_chase_blocked === true,
            retestRequired: execMetaForBoundary.retest_required === true
        };

        const probeCommonOk =
            !whipsawShockRecheckActive &&
            hardControlClear === true &&
            hardBlockPresent === false &&
            paperExecutionReady === true &&
            signedExecutionReady === true &&
            !hasSameSidePosition &&
            !hasOppositeSidePosition &&
            qualityScore >= 67 &&
            trendOk === true &&
            (entryQualityGrade === "S" || entryQualityGrade === "A" || entryQualityGrade === "B") &&
            (readinessDiag.live_balance_block == null || readinessDiag.live_balance_ready === true);

        if (probeCommonOk && (v2DecisionAfterPromotion === "HOLD" || v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "REJECT")) {
            const probeDownOk =
                shock === "DOWN" &&
                trendSideCandidate === "short" &&
                riskShortAllow === true &&
                allowNewShort === true &&
                emaGap < 0 &&
                !crashState.includes("ULTRA") &&
                !crashState.includes("CRITICAL");

            const probeUpOk =
                shock === "UP" &&
                trendSideCandidate === "long" &&
                riskLongAllow === true &&
                allowNewLong === true &&
                emaGap > 0 &&
                !pumpStateResolved.includes("ULTRA") &&
                !pumpStateResolved.includes("CRITICAL");

            if (probeDownOk || probeUpOk) {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = trendSideCandidate;
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "V2_PROBE_ENTRY_CONFIRMED";
                promotionBlockReason = null;
                shockReactionBlockReason = null;
            }
        }

        // ?섏젙 4. RANGE_MID_CHOP ?꾩슜 micro probe ENTER 寃쎈줈 異붽?
        const isRangeMidChop = judgment.regime === "RANGE" && judgment.subtype === "RANGE_MID_CHOP";
        const microProbeCommonOk =
            !whipsawShockRecheckActive &&
            isRangeMidChop &&
            shock === "NONE" &&
            hardControlClear === true &&
            hardBlockPresent === false &&
            paperExecutionReady === true &&
            signedExecutionReady === true &&
            !hasSameSidePosition &&
            !hasOppositeSidePosition &&
            (rangeConfidence ?? 0) >= 0.75 &&
            (entryQualityGrade === "S" || entryQualityGrade === "A" || entryQualityGrade === "B") &&
            qualityScore >= 64 &&
            trendOk === true &&
            (trendSideCandidate === "long" || trendSideCandidate === "short") &&
            (readinessDiag.live_balance_block == null || readinessDiag.live_balance_ready === true) &&
            !pumpStateResolved.includes("ULTRA") && !pumpStateResolved.includes("CRITICAL") &&
            !crashState.includes("ULTRA") && !crashState.includes("CRITICAL");

        if (microProbeCommonOk && (v2DecisionAfterPromotion === "HOLD" || v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "REJECT")) {
            const sideAllowed = trendSideCandidate === "long" ? (riskLongAllow && allowNewLong) : (riskShortAllow && allowNewShort);
            if (sideAllowed) {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = trendSideCandidate;
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "V2_RANGE_MID_MICRO_PROBE_CONFIRMED";
                promotionBlockReason = null;
                shockReactionBlockReason = null;
            }
        }

        // ?섏젙 5. WAIT_RECHECK 諛섎났 ?밴꺽 寃쎈줈 異붽? (recheck promotion path)
        const recheckPromotionEligible =
            !whipsawShockRecheckActive &&
            v2RejectReasonAfterPromotion === "WAIT_RECHECK" &&
            reviewingTicks >= 2 && // 2~3??諛섎났
            hardControlClear === true &&
            hardBlockPresent === false &&
            paperExecutionReady === true &&
            signedExecutionReady === true &&
            !hasSameSidePosition &&
            !hasOppositeSidePosition &&
            qualityScore >= 60;

        if (recheckPromotionEligible && (v2DecisionAfterPromotion === "HOLD" || v2DecisionAfterPromotion === "SKIP")) {
            const sideAllowed = trendSideCandidate === "long" ? (riskLongAllow && allowNewLong) : (riskShortAllow && allowNewShort);
            if (sideAllowed && trendSideCandidate !== "none" && trendOk) {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = trendSideCandidate;
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "V2_WAIT_RECHECK_QUALIFIED_PROMOTION";
                promotionBlockReason = null;
                console.info(JSON.stringify({
                    event: "V2_WAIT_RECHECK_PROMOTION_PROOF",
                    symbol: String(input.symbol),
                    reviewing_ticks: reviewingTicks,
                    side: trendSideCandidate,
                    quality_score: qualityScore,
                    promotion_reason: "V2_WAIT_RECHECK_QUALIFIED_PROMOTION"
                }));
            }
        }

        // ?섏젙 6. TRANSITION WATCH + SHOCK_REACTION_DOWN + upper short valid => micro/probe short probe
        // reviewingTicks=0?댁뼱??1?뚯감遺€???덉슜. full size 湲덉?, micro/probe cap 媛뺤젣.
        const transitionWatchShortMeta = (execution.metadata ?? {}) as Record<string, unknown>;
        const transitionWatchShortSetupType = String(transitionWatchShortMeta.transitionSetupType ?? "NONE");
        const transitionWatchShortAction = String(transitionWatchShortMeta.transitionAction ?? "REJECT");
        const transitionWatchShortRejectReason = transitionWatchShortMeta.transitionRejectReason as string | null ?? null;

        const isTransitionWatchShortEligibleContext =
            activeEngineRouting === "TRANSITION" &&
            shock === "DOWN" &&
            (transitionWatchShortSetupType === "SHOCK_DOWN_REACTION" || judgment.subtype === "SHOCK_REACTION_DOWN") &&
            transitionWatchShortAction === "WATCH" &&
            (transitionWatchShortRejectReason === "INSUFFICIENT_CONFIRMATION" || transitionWatchShortRejectReason === "EMA_GAP_ONLY_PREFLIGHT_BLOCKED");

        const lowerBreakdownShortForTransition = evaluateLowerBreakdownShortConfirmed({
            ...rangeBoundaryCtx,
            trendSideCandidate: "short",
            skipExecutionGate: true
        }).confirmed;

        const transitionWatchShortZoneOk =
            zone === "upper" ||
            (zone === "lower" && lowerBreakdownShortForTransition) ||
            (judgment.subtype === "BREAKDOWN_RETEST_FAILED" && (zone === "mid" || zone === "lower"));

        const transitionWatchShortConditionsMet =
            !whipsawShockRecheckActive &&
            isTransitionWatchShortEligibleContext &&
            transitionWatchShortZoneOk &&
            trendSideCandidate === "short" &&
            riskShortAllow === true &&
            allowNewShort === true &&
            qualityScore >= 60 &&
            emaGap < 0 &&
            hardBlockPresent === false &&
            hardControlClear === true &&
            paperExecutionReady === true &&
            signedExecutionReady === true &&
            !hasSameSidePosition &&
            !hasOppositeSidePosition &&
            !crashState.includes("ULTRA") &&
            !crashState.includes("CRITICAL") &&
            (v2DecisionAfterPromotion === "HOLD" || v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "REJECT");

        let transitionWatchShortPromotionPassed = false;
        let transitionWatchShortFailReason: string | null = null;

        if (!isTransitionWatchShortEligibleContext) {
            if (activeEngineRouting !== "TRANSITION") transitionWatchShortFailReason = "NOT_TRANSITION_WATCH";
            else if (shock !== "DOWN") transitionWatchShortFailReason = "NOT_DOWN_SHOCK";
            else if (!(transitionWatchShortSetupType === "SHOCK_DOWN_REACTION" || judgment.subtype === "SHOCK_REACTION_DOWN")) transitionWatchShortFailReason = "NOT_SHOCK_REACTION_SETUP";
            else if (transitionWatchShortAction !== "WATCH") transitionWatchShortFailReason = "ACTION_NOT_WATCH";
            else transitionWatchShortFailReason = "NOT_ELIGIBLE_CONTEXT_OTHER";
        } else {
            if (!transitionWatchShortZoneOk) {
                transitionWatchShortFailReason =
                    zone === "lower" ? "ZONE_LOWER_BREAKDOWN_NOT_CONFIRMED" : "ZONE_NOT_UPPER";
            }
            else if (trendSideCandidate !== "short") transitionWatchShortFailReason = "TREND_SIDE_NOT_SHORT";
            else if (!riskShortAllow || !allowNewShort) transitionWatchShortFailReason = "SHORT_NOT_ALLOWED";
            else if (qualityScore < 60) transitionWatchShortFailReason = "QUALITY_TOO_LOW";
            else if (emaGap >= 0) transitionWatchShortFailReason = "EMA_GAP_NOT_NEGATIVE";
            else if (hardBlockPresent) transitionWatchShortFailReason = "HARD_BLOCK_PRESENT";
            else if (!hardControlClear) transitionWatchShortFailReason = "HARD_CONTROL_NOT_CLEAR";
            else if (!paperExecutionReady) transitionWatchShortFailReason = "PAPER_EXECUTION_NOT_READY";
            else if (!signedExecutionReady) transitionWatchShortFailReason = "SIGNED_EXECUTION_NOT_READY";
            else if (hasSameSidePosition || hasOppositeSidePosition) transitionWatchShortFailReason = "HAS_POSITION";
            else if (crashState.includes("ULTRA") || crashState.includes("CRITICAL")) transitionWatchShortFailReason = "CRASH_STATE_ACTIVE";
            else if (v2DecisionAfterPromotion === "ENTER") transitionWatchShortFailReason = "ALREADY_PROMOTED";
            else transitionWatchShortPromotionPassed = transitionWatchShortConditionsMet;
        }

        if (shouldEmitV2Proof(
            "V2_TRANSITION_WATCH_SHORT_PROMOTION_PROOF",
            String(input.symbol),
            `${transitionWatchShortSetupType}|${transitionWatchShortAction}|${transitionWatchShortRejectReason}|${zone}|${qualityScore}|${transitionWatchShortPromotionPassed}`,
            isTransitionWatchShortEligibleContext
        )) {
            console.info(JSON.stringify({
                event: "V2_TRANSITION_WATCH_SHORT_PROMOTION_PROOF",
                symbol: String(input.symbol),
                transition_action: transitionWatchShortAction,
                transition_reject_reason: transitionWatchShortRejectReason,
                zone,
                range_side_candidate: rangeSideCandidate,
                trend_side_candidate: trendSideCandidate,
                short_allow: riskShortAllow && allowNewShort,
                quality_score: qualityScore,
                ema_gap: emaGap,
                promotion_passed: transitionWatchShortPromotionPassed,
                promotion_fail_reason: transitionWatchShortFailReason
            }));
        }

        const isWhipsawRecheckBlock =
            whipsawShockRecheckActive ||
            judgment.subtype === "WHIPSAW_SOFT_WATCH" ||
            v2RejectReasonAfterPromotion === "WHIPSAW_SHOCK_RECHECK";
        const htfHoldBlock = judgment.htf_entry_policy === "HOLD" || judgment.counter_trend_risk === true;
        if (isWhipsawRecheckBlock && (v2DecisionAfterPromotion === "HOLD" || v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "REJECT" || htfHoldBlock)) {
            const atr20 = Number(input.snapshot.atr20 ?? 0);
            const entryPrice = Number(input.snapshot.lastPrice ?? 0);
            const closedClose = input.snapshot.closedClose;
            const blSlope = Number(input.snapshot.boxLowSlope ?? 0);
            const rcSlope = Number(input.snapshot.rcSlope ?? 0);
            const bhSlope = Number(input.snapshot.boxHighSlope ?? 0);
            const trendPhase = judgment.trendPhase;
            const htfPolicy = judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT";
            const shockPhase = judgment.shockPhase;
            
            let microProbeAllowed = false;
            let microProbeSide: EngineV2Side = "none";
            let microProbeDistancePct = 0;
            let maxAllowedDistancePct = 0;
            let htfReverseRisk = false;
            let atrPct = 0;
            
            const rangeMeta = (execution.metadata ?? {}) as Record<string, unknown>;
            let watchBoundary = Number(rangeMeta.watchBoundary ?? 0);
            let watchStartedCandleTs = Number(rangeMeta.watchStartedCandleTs ?? 0);
            let continuationDirection = String(rangeMeta.continuationDirection ?? "none");
            
            if (atr20 <= 0 || entryPrice <= 0) {
                microProbeBlockReason = "ATR_DATA_NOT_READY";
            } else if (!watchBoundary || watchBoundary <= 0) {
                const cState = rangeContinuationStateMap.get(String(input.symbol));
                const evalNow = Number(input.now ?? Date.now());
                const boundaryPrice = Number(cState?.watchBoundaryPrice ?? 0);
                const startedCandleTs = Number(cState?.watchStartedCandleTs ?? 0);
                const startedAtTs = Number(cState?.watchStartedAtTimestamp ?? 0);
                const dir = String(cState?.direction ?? "");
                const ageMs = evalNow - startedAtTs;

                if (!cState || boundaryPrice <= 0 || isNaN(boundaryPrice)) {
                    microProbeBlockReason = "WATCH_BOUNDARY_MISSING";
                } else if (startedCandleTs <= 0 || isNaN(startedCandleTs)) {
                    microProbeBlockReason = "WATCH_STARTED_CANDLE_TS_INVALID";
                } else if (startedAtTs <= 0 || isNaN(startedAtTs)) {
                    microProbeBlockReason = "WATCH_STARTED_AT_TIMESTAMP_INVALID";
                } else if (ageMs < 0 || ageMs > 10 * 60 * 1000) {
                    microProbeBlockReason = "CONTINUATION_CONTEXT_STALE";
                } else if (dir !== "up" && dir !== "down") {
                    microProbeBlockReason = "CONTINUATION_DIRECTION_INVALID";
                } else {
                    watchBoundary = boundaryPrice;
                    watchStartedCandleTs = startedCandleTs;
                    continuationDirection = dir;
                }
            }
            
            if (watchBoundary > 0 && microProbeBlockReason == null) {
                if (closedClose == null) {
                    microProbeBlockReason = "CLOSED_CLOSE_NULL";
                } else if (shockPhase !== "NONE") {
                    microProbeBlockReason = "SHOCK_PHASE_ACTIVE";
                } else {
                    atrPct = atr20 / entryPrice;
                
                    const shortCandleBreakdown = closedClose < watchBoundary && entryPrice < watchBoundary;
                    const longCandleBreakout = closedClose > watchBoundary && entryPrice > watchBoundary;
                    
                    if (shortCandleBreakdown) {
                        microProbeSide = "short";
                        microProbeDistancePct = (watchBoundary - entryPrice) / watchBoundary;
                        htfReverseRisk = judgment.counter_trend_risk === true || judgment.htf_requires_stronger_confirmation === true;
                        
                        if (trendPhase !== "DOWN") microProbeBlockReason = "TREND_NOT_DOWN";
                        else if (!(blSlope < 0 || rcSlope < 0)) microProbeBlockReason = "SLOPE_NOT_NEGATIVE";
                        else if (htfPolicy !== "SHORT_ONLY_OR_NONE" && htfPolicy !== "BOTH" && htfPolicy !== "PROBE_ONLY") microProbeBlockReason = "HTF_POLICY_NOT_SHORT";
                        else if (emaGap >= 0) microProbeBlockReason = "EMA_GAP_NOT_NEGATIVE";
                        else if (continuationDirection !== "none" && continuationDirection !== "down") microProbeBlockReason = "CONTINUATION_DIRECTION_MISMATCH";
                        else microProbeAllowed = true;
                    } else if (longCandleBreakout) {
                        microProbeSide = "long";
                        microProbeDistancePct = (entryPrice - watchBoundary) / watchBoundary;
                        htfReverseRisk = judgment.counter_trend_risk === true || judgment.htf_requires_stronger_confirmation === true;
                        
                        if (trendPhase !== "UP") microProbeBlockReason = "TREND_NOT_UP";
                        else if (!(bhSlope > 0 || rcSlope > 0)) microProbeBlockReason = "SLOPE_NOT_POSITIVE";
                        else if (htfPolicy !== "LONG_ONLY_OR_NONE" && htfPolicy !== "BOTH" && htfPolicy !== "PROBE_ONLY") microProbeBlockReason = "HTF_POLICY_NOT_LONG";
                        else if (emaGap <= 0) microProbeBlockReason = "EMA_GAP_NOT_POSITIVE";
                        else if (continuationDirection !== "none" && continuationDirection !== "up") microProbeBlockReason = "CONTINUATION_DIRECTION_MISMATCH";
                        else microProbeAllowed = true;
                    } else {
                        microProbeBlockReason = "NO_CANDLE_BREAKOUT_OR_BREAKDOWN";
                    }
                }
            }
            
            let setupKey = "none";
            if (microProbeSide !== "none" && watchBoundary > 0 && watchStartedCandleTs > 0) {
                setupKey = `${input.symbol}_${microProbeSide}_${watchBoundary}_${watchStartedCandleTs}`;
                
                const lastProbeSetupKey = symbolLastProbeStructureMap.get(input.symbol);
                if (lastProbeSetupKey === setupKey) {
                    microProbeAllowed = false;
                    microProbeBlockReason = "DUPLICATE_SETUP_KEY";
                }
            } else if (microProbeAllowed) {
                microProbeAllowed = false;
                microProbeBlockReason = "SETUP_KEY_INVALID";
            }
            
            if (microProbeSide !== "none" && microProbeAllowed) {
                maxAllowedDistancePct = Math.max(0.0015, Math.min(0.0035, atrPct * 0.5));
                if (microProbeDistancePct > maxAllowedDistancePct) {
                    microProbeAllowed = false;
                    microProbeBlockReason = "DISTANCE_TOO_WIDE";
                } else if (hasSameSidePosition || hasOppositeSidePosition) {
                    microProbeAllowed = false;
                    microProbeBlockReason = "ALREADY_HAS_POSITION";
                } else if (hardBlockPresent) {
                    const onlyWhipsawBlock = hardControlClear && (v2RejectReasonAfterPromotion === "WHIPSAW_SHOCK_RECHECK" || v2RejectReasonAfterPromotion === "WHIPSAW_RECHECK_NOT_CONFIRMED");
                    if (!onlyWhipsawBlock) {
                        microProbeAllowed = false;
                        microProbeBlockReason = "HARD_BLOCK_PRESENT";
                    }
                }
            }
            
            let effectiveSizeMultiplier = 0;
            const probeSizeCap = htfReverseRisk ? 0.15 : 0.20;
            
            if (microProbeSide !== "none" && microProbeAllowed) {
                const isWhipsaw = v2RejectReasonAfterPromotion === "WHIPSAW_SHOCK_RECHECK" || v2RejectReasonAfterPromotion === "WHIPSAW_RECHECK_NOT_CONFIRMED" || v2RejectReasonAfterPromotion === "WHIPSAW_SHOCK_RECHECK_TRANSITION_HOLD";
                
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = microProbeSide;
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "CONTINUATION_MICRO_PROBE";
                promotionBlockReason = null;
                shockReactionBlockReason = null;
                
                const releasableWhipsawRiskBlock =
                    promotionReason === "CONTINUATION_MICRO_PROBE" &&
                    isWhipsaw &&
                    hardControlClear &&
                    signedExecutionReady &&
                    (
                        riskSizing.blockReason == null ||
                        riskSizing.blockReason === "WHIPSAW_SHOCK_RECHECK" ||
                        riskSizing.blockReason === "WHIPSAW_RECHECK_NOT_CONFIRMED" ||
                        riskSizing.blockReason === "WHIPSAW_SHOCK_RECHECK_TRANSITION_HOLD"
                    );

                if (releasableWhipsawRiskBlock) {
                    riskSizing.isBlocked = false;
                    riskSizing.blockReason = null;
                    hardBlockPresent = false;
                    hardBlockReason = null;
                }
                microProbeFixedBoundary = watchBoundary;
                
                const existingSizeMultiplier = Number((riskSizing as any).sizeMultiplier ?? 1.0);
                effectiveSizeMultiplier = Math.min(existingSizeMultiplier, probeSizeCap);
                microProbeSizeCap = effectiveSizeMultiplier;
                
                microProbeSetupKeyToConsume = setupKey;
            }
            
            console.info(JSON.stringify({
                event: "V2_WHIPSAW_MICRO_PROBE_EVALUATION_PROOF",
                symbol: String(input.symbol),
                side: microProbeSide,
                setupKey,
                fixedBoundary: watchBoundary,
                boundarySource: "watchBoundary",
                lastPrice: entryPrice,
                closedClose: closedClose ?? null,
                atr20: atr20,
                atrPct: atrPct,
                distanceFromBoundaryPct: microProbeDistancePct,
                maxAllowedDistancePct: maxAllowedDistancePct,
                trendAligned: microProbeSide === "short" ? trendPhase === "DOWN" : trendPhase === "UP",
                slopeAligned: microProbeSide === "short" ? (blSlope < 0 || rcSlope < 0) : (bhSlope > 0 || rcSlope > 0),
                htfPolicy: htfPolicy,
                htfReverseRisk: htfReverseRisk,
                shockPhase: shockPhase,
                probeSizeCap: probeSizeCap,
                effectiveSizeMultiplier: effectiveSizeMultiplier,
                microProbeAllowed: microProbeAllowed,
                blockReason: microProbeBlockReason
            }));
        }


        // Step 7. Retest Recognition Layer (Breakdown/Breakout Retest Promotion)
        const isRetestEligiblePhase = judgment.subtype === "BREAKDOWN_RETEST_FAILED" ||
                                     judgment.subtype === "BREAKOUT_RETEST_CONFIRMED_VOLUME" ||
                                     judgment.subtype === "BREAKOUT_RETEST_CONFIRMED";

        const m = (judgment.metadata as any) ?? {};
        const retestLevel = m.retestLevel ?? (judgment.subtype === "BREAKDOWN_RETEST_FAILED" ? (input.snapshot.boxLow ?? 0) : (input.snapshot.boxHigh ?? 0));
        const lastPrice = input.snapshot.lastPrice;
        const retestTouched = m.retestTouched ?? false;
        const retestRejected = m.retestRejected ?? false;
        const retestConfirmed = m.retestConfirmed ?? false;
        const distanceFromRetestPct = m.distanceFromRetestPct ?? 0;
        const chaseDistanceBlocked = m.chaseDistanceBlocked ?? (isRetestEligiblePhase && distanceFromRetestPct > 0.005);

        const isShortRetestPhase = judgment.subtype === "BREAKDOWN_RETEST_FAILED";

        const retestCommonOk =
            !whipsawShockRecheckActive &&
            isRetestEligiblePhase &&
            hardControlClear === true &&
            hardBlockPresent === false &&
            paperExecutionReady === true &&
            signedExecutionReady === true &&
            !hasSameSidePosition &&
            !hasOppositeSidePosition &&
            qualityScore >= 55 &&
            !chaseDistanceBlocked &&
            retestTouched &&
            retestRejected &&
            retestConfirmed;

        if (isRetestEligiblePhase && !retestCommonOk) {
            if (!retestTouched) expectedMissingCondition = "RETEST_TOUCH";
            else if (!retestRejected) expectedMissingCondition = "RETEST_REJECTION";
            else if (!retestConfirmed) expectedMissingCondition = "RETEST_CONFIRMATION";
            else if (chaseDistanceBlocked) expectedMissingCondition = "CHASE_DISTANCE_LIMIT";

            expectedNextAction = "WATCH_FOR_RETEST_REJECTION";
        }

        if (retestCommonOk && (v2DecisionAfterPromotion === "HOLD" || v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "REJECT")) {
            const isShortRetest = isShortRetestPhase && trendSideCandidate === "short" && riskShortAllow && allowNewShort && emaGap <= 0;
            const isLongRetest = (judgment.subtype === "BREAKOUT_RETEST_CONFIRMED_VOLUME" || judgment.subtype === "BREAKOUT_RETEST_CONFIRMED") &&
                                trendSideCandidate === "long" && riskLongAllow && allowNewLong && emaGap >= 0;

            if (isShortRetest || isLongRetest) {
                const atr = Number(input.snapshot.atr ?? 0);
                const side = isShortRetest ? "short" : "long";
                let retestInvalidationPx = 0;

                if (side === "short") {
                    retestInvalidationPx = retestLevel + Math.max(retestLevel * 0.002, atr * 0.35);
                } else {
                    retestInvalidationPx = retestLevel - Math.max(retestLevel * 0.002, atr * 0.35);
                }

                let stopPriceValid = retestInvalidationPx > 0 && !isNaN(retestInvalidationPx);
                if (stopPriceValid) {
                    if (side === "short" && retestInvalidationPx <= lastPrice) stopPriceValid = false;
                    if (side === "long" && retestInvalidationPx >= lastPrice) stopPriceValid = false;
                }

                if (!stopPriceValid) {
                    console.warn(JSON.stringify({
                        event: "V2_RETEST_STOP_PRICE_INVALID_BLOCK_PROOF",
                        symbol: String(input.symbol),
                        side,
                        lastPrice,
                        calculatedInvalidationPx: retestInvalidationPx,
                        retestLevel
                    }));
                } else {
                    v2DecisionAfterPromotion = "ENTER";
                    v2SideAfterPromotion = trendSideCandidate;
                    v2RejectReasonAfterPromotion = null;
                    promotionApplied = true;
                    promotionReason = isShortRetest ? "V2_RETEST_SHORT_CONFIRMED" : "V2_RETEST_LONG_CONFIRMED";
                    promotionBlockReason = null;
                    promotionMinConditionPassed = true;

                    // Store for later metadata population
                    v2CalculatedInvalidationPx = retestInvalidationPx;

                    console.info(JSON.stringify({
                        event: "V2_RETEST_STOP_PRICE_PLAN_PROOF",
                        symbol: String(input.symbol),
                        side,
                        retestLevel,
                        lastPrice,
                        invalidationPx: retestInvalidationPx,
                        buffer_used: Math.abs(retestInvalidationPx - retestLevel)
                    }));

                    console.info(JSON.stringify({
                        event: isShortRetest ? "V2_BREAKDOWN_RETEST_RECOGNITION_PROOF" : "V2_BREAKOUT_RETEST_RECOGNITION_PROOF",
                        symbol: String(input.symbol),
                        phase: judgment.subtype,
                        side: trendSideCandidate,
                        retestLevel,
                        distanceFromRetestPct,
                        retestTouched,
                        retestRejected,
                        retestConfirmed,
                        ema_gap: emaGap,
                        quality_score: qualityScore,
                        reviewing_ticks: reviewingTicks,
                        promotion_reason: promotionReason,
                        invalidationPx: retestInvalidationPx
                    }));
                }
            }
        }

        // --- Hardening 2026-05-10: Detailed Trend Promotion Block Reasons & RANGE Zone Safety ---
        const regimeLabel = String(judgment.regime ?? "");
        const trendPromotionBlockApplies =
            !whipsawShockRecheckActive &&
            trendSideCandidate !== "none" &&
            !promotionApplied &&
            (activeEngineRouting === "TREND" || regimeLabel === "RANGE" || regimeLabel === "TRANSITION");

        if (trendPromotionBlockApplies) {
            const metaRec = execMeta as Record<string, unknown>;
            const upperLongProbeEligible =
                trendSideCandidate === "long" &&
                zone === "upper" &&
                qualityScore >= 70 &&
                (v2DecisionAfterPromotion === "SKIP" ||
                    v2DecisionAfterPromotion === "HOLD" ||
                    v2DecisionAfterPromotion === "REJECT");

            if (upperLongProbeEligible) {
                const st = judgment.subtype;
                const rp = judgment.rangePhase;
                const breakoutWatchOk =
                    st === "BREAKOUT_OBSERVATION" ||
                    st === "RANGE_BREAKOUT_CANDIDATE" ||
                    st === "VOLUME_BREAKOUT_OBSERVATION" ||
                    st === "VOLUME_SHOCK_UP" ||
                    st === "BREAKOUT_RETEST_CONFIRMED_VOLUME" ||
                    st === "BREAKOUT_RETEST_CONFIRMED" ||
                    String(boxBreakSide).toLowerCase() === "upper" ||
                    rp === "BREAKOUT" ||
                    rp === "BREAKOUT_OBSERVATION" ||
                    rp === "VOLUME_BREAKOUT_OBSERVATION" ||
                    rp === "VOLUME_SHOCK_UP";

                const strongConfirmationOk =
                    reversalConfirmed === true || breakoutWatchOk === true;

                const chaseBlockedFlag = metaRec.late_chase_blocked === true;
                const retestPendingSubtype =
                    st === "VOLUME_BREAKOUT_OBSERVATION" ||
                    st === "VOLUME_SHOCK_UP";
                const retestConfirmedSubtype =
                    st === "BREAKOUT_RETEST_CONFIRMED_VOLUME" || st === "BREAKOUT_RETEST_CONFIRMED";
                const retestRequiredFlag =
                    metaRec.retest_required === true ||
                    (retestPendingSubtype && !retestConfirmedSubtype);

                const supportRecheckFlag = metaRec.support_recheck_required === true;

                const boxHigh = Number(authoritativeInput.snapshot.boxHigh ?? 0);
                const boxLow = Number(authoritativeInput.snapshot.boxLow ?? 0);
                const boxMid = (boxHigh + boxLow) / 2;
                const atrProbe = Number(authoritativeInput.snapshot.atr ?? 0);
                const lastPriceProbe = Number(authoritativeInput.snapshot.lastPrice ?? 0);
                const entryPxProbe = lastPriceProbe;
                const minProfitDistProbe = Math.max(atrProbe * 0.35, entryPxProbe * 0.001);
                const minStopDistProbe = Math.max(atrProbe * 0.5, entryPxProbe * 0.0015);
                let probeInv = Math.min(boxLow - minStopDistProbe, entryPxProbe - minStopDistProbe);
                let probeTp1 = Math.max(boxMid, entryPxProbe + minProfitDistProbe);
                if (probeTp1 <= entryPxProbe) probeTp1 = entryPxProbe + minProfitDistProbe;
                let probeTp2 = Math.max(boxHigh, probeTp1 + minProfitDistProbe);
                if (probeTp2 <= probeTp1) probeTp2 = probeTp1 + minProfitDistProbe;
                const boxHeight = boxHigh - boxLow;
                const boxHeightPct = boxLow > 0 ? boxHeight / boxLow : 0;
                const longOrderOkProbe =
                    probeInv < entryPxProbe && entryPxProbe < probeTp1 && probeTp1 < probeTp2;
                const longPlanGeomInvalid =
                    !Number.isFinite(entryPxProbe) ||
                    entryPxProbe <= 0 ||
                    !Number.isFinite(probeTp1) ||
                    !Number.isFinite(probeTp2) ||
                    !Number.isFinite(probeInv) ||
                    probeTp1 <= 0 ||
                    probeTp2 <= 0 ||
                    probeInv <= 0 ||
                    boxHeightPct < 0.0008 ||
                    !longOrderOkProbe;
                const stopValidLong =
                    probeInv > 0 &&
                    Number.isFinite(probeInv) &&
                    Number.isFinite(lastPriceProbe) &&
                    probeInv < lastPriceProbe;
                const tpValidLong = !longPlanGeomInvalid;

                type UpperLongGate = string | null;
                let upperLongGate: UpperLongGate = null;
                if (chaseBlockedFlag) upperLongGate = "TREND_PROMOTION_BLOCKED_CHASE_BLOCKED";
                else if (retestRequiredFlag) upperLongGate = "TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED";
                else if (supportRecheckFlag) upperLongGate = "TREND_PROMOTION_BLOCKED_SUPPORT_RECHECK_REQUIRED";
                else if (!(riskLongAllow && allowNewLong)) upperLongGate = "TREND_PROMOTION_BLOCKED_LONG_NOT_ALLOWED";
                else if (!paperExecutionReady) upperLongGate = "TREND_PROMOTION_BLOCKED_PAPER_EXECUTION_NOT_READY";
                else if (!signedExecutionReady) upperLongGate = "TREND_PROMOTION_BLOCKED_SIGNED_EXECUTION_NOT_READY";
                else if (hasSameSidePosition || hasOppositeSidePosition) {
                    upperLongGate = "TREND_PROMOTION_BLOCKED_OPEN_POSITION_CONFLICT";
                } else if (hardBlockPresent) upperLongGate = "TREND_PROMOTION_BLOCKED_HARD_BLOCK_PRESENT";
                else if (!trendOk) upperLongGate = "TREND_PROMOTION_BLOCKED_TREND_NOT_CONFIRMED";
                else if (judgment.htf_requires_stronger_confirmation === true && !strongConfirmationOk) {
                    upperLongGate = "TREND_PROMOTION_BLOCKED_HTF_STRONG_CONFIRMATION_REQUIRED";
                } else if (!stopValidLong) upperLongGate = "TREND_PROMOTION_BLOCKED_STOP_PRICE_MISSING";
                else if (!tpValidLong) upperLongGate = "TREND_PROMOTION_BLOCKED_TP_SL_PLAN_INVALID";
                else if (!sideZoneValid && !breakoutWatchOk) {
                    upperLongGate = "TREND_PROMOTION_BLOCKED_SIDE_ZONE_AND_BREAKOUT_WATCH";
                }

                const upperLongContinuationEval = evaluateUpperBreakoutLongConfirmed({
                    ...rangeBoundaryCtx,
                    trendSideCandidate: "long"
                });
                if (upperLongGate == null && !upperLongContinuationEval.confirmed) {
                    upperLongGate =
                        upperLongContinuationEval.holdReason ?? "UPPER_BREAKOUT_CONTINUATION_NOT_CONFIRMED";
                }

                if (upperLongGate != null) {
                    promotionBlockReason = upperLongGate;
                    expectedMissingCondition = upperLongGate;
                    expectedNextAction = "WAIT_FOR_UPPER_LONG_PROBE_GATE";
                    console.info(
                        JSON.stringify({
                            event: "V2_UPPER_LONG_PROBE_GATE_SKIP_PROOF",
                            symbol: String(input.symbol),
                            expected_missing_condition: upperLongGate,
                            promotion_block_reason: upperLongGate,
                            zone,
                            qualityScore,
                            trend_side_candidate: trendSideCandidate,
                            chase_blocked: chaseBlockedFlag,
                            retest_required: retestRequiredFlag,
                            support_recheck_required: supportRecheckFlag,
                            paper_execution_ready: paperExecutionReady,
                            signed_execution_ready: signedExecutionReady,
                            htf_entry_policy: judgment.htf_entry_policy ?? null,
                            htf_requires_stronger_confirmation: judgment.htf_requires_stronger_confirmation ?? false,
                            side_zone_valid: sideZoneValid,
                            breakout_watch_ok: breakoutWatchOk,
                            strong_confirmation_ok: strongConfirmationOk,
                            decision_before_gate: v2DecisionAfterPromotion,
                            boxBreakSide,
                            subtype: st,
                            range_phase: rp
                        })
                    );
                } else {
                    v2DecisionAfterPromotion = "ENTER";
                    v2SideAfterPromotion = "long";
                    v2RejectReasonAfterPromotion = null;
                    promotionApplied = true;
                    promotionReason = "V2_UPPER_LONG_PROBE_PROMOTION";
                    promotionBlockReason = null;
                    promotionMinConditionPassed = true;
                    v2CalculatedInvalidationPx = probeInv;

                    console.info(
                        JSON.stringify({
                            event: "V2_TREND_PROMOTION_TO_ENTER_PROOF",
                            symbol: String(input.symbol),
                            side: "long",
                            zone,
                            qualityScore,
                            htf_entry_policy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
                            htf_size_multiplier:
                                typeof judgment.htf_size_multiplier === "number"
                                    ? judgment.htf_size_multiplier
                                    : null,
                            htf_requires_stronger_confirmation: judgment.htf_requires_stronger_confirmation ?? false,
                            entryPx: lastPriceProbe,
                            stopPrice: probeInv,
                            tp1: probeTp1,
                            tp2: probeTp2,
                            finalDecision: "ENTER",
                            promotion_reason: promotionReason,
                            breakout_watch_ok: breakoutWatchOk,
                            side_zone_valid: sideZoneValid
                        })
                    );
                }
            } else if (
                !promotionApplied &&
                trendSideCandidate === "short" &&
                (zone === "lower" || String(boxBreakSide).toLowerCase() === "lower") &&
                qualityScore >= 70 &&
                (v2DecisionAfterPromotion === "SKIP" ||
                    v2DecisionAfterPromotion === "HOLD" ||
                    v2DecisionAfterPromotion === "REJECT")
            ) {
                const lowerShortContinuationEval = evaluateLowerBreakdownShortConfirmed({
                    ...rangeBoundaryCtx,
                    trendSideCandidate: "short"
                });

                const boxHighS = Number(authoritativeInput.snapshot.boxHigh ?? 0);
                const boxLowS = Number(authoritativeInput.snapshot.boxLow ?? 0);
                const boxMidS = (boxHighS + boxLowS) / 2;
                const atrS = Number(authoritativeInput.snapshot.atr ?? 0);
                const entryPxS = Number(authoritativeInput.snapshot.lastPrice ?? 0);
                const minProfitS = Math.max(atrS * 0.35, entryPxS * 0.001);
                const minStopS = Math.max(atrS * 0.5, entryPxS * 0.0015);
                let stopPxS = Math.max(boxHighS + minStopS, entryPxS + minStopS);
                let tp1S = Math.min(boxMidS, entryPxS - minProfitS);
                if (tp1S >= entryPxS) tp1S = entryPxS - minProfitS;
                let tp2S = Math.min(boxLowS, tp1S - minProfitS);
                if (tp2S >= tp1S) tp2S = tp1S - minProfitS;
                const boxHeightS = boxHighS - boxLowS;
                const boxHeightPctS = boxLowS > 0 ? boxHeightS / boxLowS : 0;
                const shortOrderOkS = tp2S < tp1S && tp1S < entryPxS && entryPxS < stopPxS;
                const planInvalidS =
                    !Number.isFinite(entryPxS) ||
                    entryPxS <= 0 ||
                    !Number.isFinite(tp1S) ||
                    !Number.isFinite(tp2S) ||
                    !Number.isFinite(stopPxS) ||
                    tp1S <= 0 ||
                    tp2S <= 0 ||
                    stopPxS <= 0 ||
                    boxHeightPctS < 0.0008 ||
                    !shortOrderOkS;

                type LowerShortGate = string | null;
                let lowerShortGate: LowerShortGate = null;
                if (!lowerShortContinuationEval.confirmed) {
                    lowerShortGate =
                        lowerShortContinuationEval.holdReason ??
                        "TREND_PROMOTION_BLOCKED_RANGE_ZONE_NOT_BREAKDOWN_CONFIRMED";
                } else if (planInvalidS) {
                    lowerShortGate = "LOWER_SHORT_CONTINUATION_PROBE_BLOCKED_TP_SL_PLAN_INVALID";
                } else if (!(stopPxS > 0 && stopPxS > entryPxS)) {
                    lowerShortGate = "LOWER_SHORT_CONTINUATION_PROBE_BLOCKED_STOP_PRICE_MISSING";
                }

                if (lowerShortGate != null) {
                    promotionBlockReason = lowerShortGate;
                    expectedMissingCondition = lowerShortGate;
                    expectedNextAction = "WAIT_FOR_BREAKDOWN_RETEST_RESISTANCE_CONFIRM";
                    v2DecisionAfterPromotion = "HOLD";
                    v2RejectReasonAfterPromotion = "WAIT_RECHECK";
                    console.info(
                        JSON.stringify({
                            event: "V2_LOWER_SHORT_BREAKDOWN_PROBE_GATE_SKIP_PROOF",
                            symbol: String(input.symbol),
                            expected_missing_condition: lowerShortGate,
                            promotion_block_reason: lowerShortGate,
                            zone,
                            qualityScore,
                            trend_side_candidate: trendSideCandidate,
                            boxBreakSide,
                            continuation_eval: lowerShortContinuationEval.evidence,
                            wick_only_break: lowerShortContinuationEval.wickOnlyBreak,
                            closed_break_confirmed: lowerShortContinuationEval.closedBreakConfirmed,
                            retest_confirmed: lowerShortContinuationEval.retestConfirmed,
                            paper_execution_ready: paperExecutionReady,
                            signed_execution_ready: signedExecutionReady,
                            decision_before_gate: v2DecisionAfterPromotion
                        })
                    );
                } else {
                    v2DecisionAfterPromotion = "ENTER";
                    v2SideAfterPromotion = "short";
                    v2RejectReasonAfterPromotion = null;
                    promotionApplied = true;
                    promotionReason = "V2_LOWER_SHORT_BREAKDOWN_CONTINUATION_PROMOTION";
                    promotionBlockReason = null;
                    promotionMinConditionPassed = true;
                    v2CalculatedInvalidationPx = stopPxS;

                    console.info(
                        JSON.stringify({
                            event: "V2_TREND_PROMOTION_TO_ENTER_PROOF",
                            symbol: String(input.symbol),
                            side: "short",
                            zone,
                            qualityScore,
                            htf_entry_policy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
                            promotion_reason: promotionReason,
                            boxBreakSide,
                            continuation_eval: lowerShortContinuationEval.evidence,
                            entryPx: entryPxS,
                            stopPrice: stopPxS,
                            tp1: tp1S,
                            tp2: tp2S
                        })
                    );
                }
            } else if (
                !promotionApplied &&
                (rangeSideCandidate === "long" || trendSideCandidate === "long") &&
                zone === "lower" &&
                sideZoneValid === true &&
                (judgment.htf_entry_policy === "LONG_ONLY_OR_NONE" || judgment.htf_entry_policy === "ALLOW") &&
                (judgment.macro_source === "actual_candles" || judgment.macro_source === "partial_actual_candles") &&
                qualityScore >= 60 &&
                (v2DecisionAfterPromotion === "SKIP" ||
                    v2DecisionAfterPromotion === "HOLD" ||
                    v2DecisionAfterPromotion === "REJECT")
            ) {
                if (judgment.trendPhase === "DOWN" && !reversalConfirmed) {
                    // reversalConfirmed === false인 WAITING_DUE_TO_DOWN_TREND인 상태는 롱 진입 시도가 아니므로 제외하고 hold/skip 처리 유지
                    v2DecisionAfterPromotion = "HOLD";
                    v2SideAfterPromotion = "none";
                    v2RejectReasonAfterPromotion = "V2_RANGE_LOWER_LONG_WAITING_DUE_TO_DOWN_TREND";
                    expectedMissingCondition = "V2_RANGE_LOWER_LONG_WAITING_DUE_TO_DOWN_TREND";
                    expectedNextAction = "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION";
                } else {
                    const macroSrc = judgment.macro_source ?? "data_not_ready";
                    const htfPol = judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT";
                    const chaseBlockedLower = (execMeta as Record<string, unknown>).late_chase_blocked === true;
                    const retestReqLower = (execMeta as Record<string, unknown>).retest_required === true;
                    const reclaimReqLower = (execMeta as Record<string, unknown>).reclaim_required === true;

                    const boxHighL = Number(authoritativeInput.snapshot.boxHigh ?? 0);
                    const boxLowL = Number(authoritativeInput.snapshot.boxLow ?? 0);
                    const boxMidL = (boxHighL + boxLowL) / 2;
                    const atrL = Number(authoritativeInput.snapshot.atr ?? 0);
                    const entryPxL = Number(authoritativeInput.snapshot.lastPrice ?? 0);
                    const minProfitL = Math.max(atrL * 0.35, entryPxL * 0.001);
                    const minStopL = Math.max(atrL * 0.5, entryPxL * 0.0015);
                    let stopPxL = Math.min(boxLowL - minStopL, entryPxL - minStopL);
                    let tp1L = Math.max(boxMidL, entryPxL + minProfitL);
                    if (tp1L <= entryPxL) tp1L = entryPxL + minProfitL;
                    let tp2L = Math.max(boxHighL, tp1L + minProfitL);
                    if (tp2L <= tp1L) tp2L = tp1L + minProfitL;
                    const boxHeightL = boxHighL - boxLowL;
                    const boxHeightPctL = boxLowL > 0 ? boxHeightL / boxLowL : 0;
                    const longOrderOkL =
                        stopPxL < entryPxL && entryPxL < tp1L && tp1L < tp2L;
                    const planInvalidL =
                        !Number.isFinite(entryPxL) ||
                        entryPxL <= 0 ||
                        !Number.isFinite(tp1L) ||
                        !Number.isFinite(tp2L) ||
                        !Number.isFinite(stopPxL) ||
                        tp1L <= 0 ||
                        tp2L <= 0 ||
                        stopPxL <= 0 ||
                        boxHeightPctL < 0.0008 ||
                        !longOrderOkL;

                    type LowerLongGate = string | null;
                    let lowerLongGate: LowerLongGate = null;
                    if (chaseBlockedLower) lowerLongGate = "LOWER_LONG_REACTION_PROBE_BLOCKED_CHASE_BLOCKED";
                    else if (!(riskLongAllow && allowNewLong)) {
                        lowerLongGate = "LOWER_LONG_REACTION_PROBE_BLOCKED_LONG_NOT_ALLOWED";
                    } else if (!paperExecutionReady || !signedExecutionReady) {
                        lowerLongGate = "LOWER_LONG_REACTION_PROBE_BLOCKED_EXECUTION_READINESS";
                    } else if (hasSameSidePosition || hasOppositeSidePosition) {
                        lowerLongGate = "LOWER_LONG_REACTION_PROBE_BLOCKED_POSITION_CONFLICT";
                    } else if (hardBlockPresent) lowerLongGate = "LOWER_LONG_REACTION_PROBE_BLOCKED_HARD_BLOCK";
                    else if (!(stopPxL > 0 && stopPxL < entryPxL)) {
                        lowerLongGate = "LOWER_LONG_REACTION_PROBE_BLOCKED_STOP_PRICE_MISSING";
                    } else if (planInvalidL) lowerLongGate = "LOWER_LONG_REACTION_PROBE_BLOCKED_TP_SL_PLAN_INVALID";

                    if (lowerLongGate != null) {
                        promotionBlockReason = lowerLongGate;
                        expectedMissingCondition = lowerLongGate;
                        expectedNextAction = "WAIT_FOR_LOWER_LONG_REACTION_PROBE_GATE";
                        console.info(
                            JSON.stringify({
                                event: "V2_LOWER_LONG_REACTION_PROBE_GATE_SKIP_PROOF",
                                symbol: String(input.symbol),
                                gate_reason: lowerLongGate,
                                zone,
                                qualityScore,
                                range_side_candidate: rangeSideCandidate,
                                trend_side_candidate: trendSideCandidate,
                                side_zone_valid: sideZoneValid,
                                htf_entry_policy: htfPol,
                                macro_source: macroSrc,
                                chase_blocked: chaseBlockedLower,
                                retest_required: retestReqLower,
                                reclaim_required: reclaimReqLower,
                                paper_execution_ready: paperExecutionReady,
                                signed_execution_ready: signedExecutionReady,
                                decision_before_gate: v2DecisionAfterPromotion
                            })
                        );
                    } else {
                        v2DecisionAfterPromotion = "ENTER";
                        v2SideAfterPromotion = "long";
                        v2RejectReasonAfterPromotion = null;
                        promotionApplied = true;
                        promotionReason = "V2_LOWER_LONG_REACTION_PROBE_PROMOTION";
                        promotionBlockReason = null;
                        promotionMinConditionPassed = true;
                        v2CalculatedInvalidationPx = stopPxL;

                        console.info(
                            JSON.stringify({
                                event: "V2_TREND_PROMOTION_TO_ENTER_PROOF",
                                symbol: String(input.symbol),
                                side: "long",
                                zone,
                                qualityScore,
                                htf_entry_policy: htfPol,
                                htf_size_multiplier:
                                    typeof judgment.htf_size_multiplier === "number"
                                        ? judgment.htf_size_multiplier
                                        : null,
                                htf_requires_stronger_confirmation: judgment.htf_requires_stronger_confirmation ?? false,
                                entryPx: entryPxL,
                                stopPrice: stopPxL,
                                tp1: tp1L,
                                tp2: tp2L,
                                finalDecision: "ENTER",
                                promotion_reason: promotionReason,
                                macro_source: macroSrc,
                                retest_required: retestReqLower,
                                reclaim_required: reclaimReqLower,
                                micro_probe_cap_forced: retestReqLower || reclaimReqLower,
                                side_zone_valid: sideZoneValid
                            })
                        );
                    }
                }
            } else if (
                !promotionApplied &&
                (trendSideCandidate === "short" || rangeSideCandidate === "short") &&
                (zone === "upper" || (judgment.subtype === "BREAKDOWN_RETEST_FAILED" && zone === "mid")) &&
                (v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "HOLD" || v2DecisionAfterPromotion === "REJECT")
            ) {
                const htfPol = judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT";
                const chaseBlocked = (execMeta as Record<string, unknown>).late_chase_blocked === true;
                const breakdownRetestFailure = judgment.subtype === "BREAKDOWN_RETEST_FAILED" || (judgment.metadata?.retestConfirmed === true);

                const boxHighS = Number(authoritativeInput.snapshot.boxHigh ?? 0);
                const boxLowS = Number(authoritativeInput.snapshot.boxLow ?? 0);
                const boxMidS = (boxHighS + boxLowS) / 2;
                const atrS = Number(authoritativeInput.snapshot.atr ?? 0);
                const entryPxS = Number(authoritativeInput.snapshot.lastPrice ?? 0);
                const minProfitS = Math.max(atrS * 0.35, entryPxS * 0.001);
                const minStopS = Math.max(atrS * 0.5, entryPxS * 0.0015);

                let stopPxS = Math.max(boxHighS + minStopS, entryPxS + minStopS);
                let tp1S = Math.min(boxMidS, entryPxS - minProfitS);
                if (tp1S >= entryPxS) tp1S = entryPxS - minProfitS;
                let tp2S = Math.min(boxLowS, tp1S - minProfitS);
                if (tp2S >= tp1S) tp2S = tp1S - minProfitS;

                const boxHeightS = boxHighS - boxLowS;
                const boxHeightPctS = boxLowS > 0 ? boxHeightS / boxLowS : 0;

                const shortOrderOkS = tp2S < tp1S && tp1S < entryPxS && entryPxS < stopPxS;
                const planInvalidS =
                    !Number.isFinite(entryPxS) || entryPxS <= 0 ||
                    !Number.isFinite(tp1S) || !Number.isFinite(tp2S) || !Number.isFinite(stopPxS) ||
                    tp1S <= 0 || tp2S <= 0 || stopPxS <= 0 ||
                    boxHeightPctS < 0.0008 ||
                    !shortOrderOkS;

                let gate: string | null = null;

                const htfLongOnly = htfPol === "LONG_ONLY_OR_NONE";
                const htfHold = htfPol === "HOLD";
                const isShockReactionDown = judgment.subtype === "SHOCK_REACTION_DOWN";

                let htfBlocked = htfLongOnly;
                if (htfHold) {
                    if (isShockReactionDown && breakdownRetestFailure) {
                        htfBlocked = false;
                    } else {
                        htfBlocked = true;
                    }
                }

                if (htfBlocked) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_HTF_LONG_ONLY";
                else if (chaseBlocked && !breakdownRetestFailure) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_CHASE_NOT_RETESTED";
                else if (qualityScore < 60) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_QUALITY_BELOW_60";
                else if (!(riskShortAllow && allowNewShort)) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_SHORT_NOT_ALLOWED";
                else if (!paperExecutionReady || !signedExecutionReady) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_EXECUTION_NOT_READY";
                else if (hasSameSidePosition || hasOppositeSidePosition) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_OPEN_POSITION_CONFLICT";
                else if (hardBlockPresent) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_HARD_BLOCK_PRESENT";
                else if (!(stopPxS > 0 && stopPxS > entryPxS)) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_STOP_PRICE_MISSING";
                else if (planInvalidS) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_TP_SL_PLAN_INVALID";
                else if (!(zone === "upper" || (breakdownRetestFailure && zone === "mid"))) gate = "UPPER_SHORT_REACTION_PROBE_BLOCKED_ZONE_NOT_VALID";

                if (gate != null) {
                    promotionBlockReason = gate;
                    expectedMissingCondition = gate;
                    expectedNextAction = "WAIT_FOR_UPPER_SHORT_REACTION_PROBE_GATE";
                    console.info(JSON.stringify({
                        event: "V2_UPPER_SHORT_REACTION_PROBE_GATE_SKIP_PROOF",
                        symbol: String(input.symbol),
                        gate_reason: gate,
                        zone,
                        qualityScore,
                        market_subtype: judgment.subtype,
                        htf_entry_policy: htfPol,
                        chase_blocked: chaseBlocked,
                        breakdown_retest_failure: breakdownRetestFailure
                    }));
                } else {
                    v2DecisionAfterPromotion = "ENTER";
                    v2SideAfterPromotion = "short";
                    v2RejectReasonAfterPromotion = null;
                    promotionApplied = true;
                    promotionReason = "V2_UPPER_SHORT_REACTION_PROBE_PROMOTION";
                    promotionBlockReason = null;
                    promotionMinConditionPassed = true;
                    v2CalculatedInvalidationPx = stopPxS;

                    console.info(JSON.stringify({
                        event: "V2_TREND_PROMOTION_TO_ENTER_PROOF",
                        symbol: String(input.symbol),
                        promotion_reason: "V2_UPPER_SHORT_REACTION_PROBE_PROMOTION",
                        side: "short",
                        entryPx: entryPxS,
                        stopPrice: stopPxS,
                        tp1: tp1S,
                        tp2: tp2S,
                        qualityScore,
                        zone,
                        market_subtype: judgment.subtype,
                        htf_entry_policy: htfPol,
                        macro_source: judgment.macro_source ?? "unknown",
                        retest_required: (execMeta as any).retest_required ?? false,
                        breakdown_retest_failure: breakdownRetestFailure,
                        micro_probe_cap_forced: true
                    }));
                }
            } else {
                const isBypassRangeUpperShort =
                    shock === "DOWN" &&
                    (judgment.htf_entry_policy === "SHORT_ONLY_OR_NONE" || judgment.htf_entry_policy === "SHORT_ONLY") &&
                    (riskShortAllow === true || allowNewShort === true) &&
                    zone === "upper" &&
                    (v2SideAfterPromotion === "short" || rangeSideCandidate === "short") &&
                    trendSideCandidate === "short" &&
                    sideZoneValid === true &&
                    hardBlockPresent === false &&
                    qualityScore >= 65 &&
                    (entryQualityGrade === "S" || entryQualityGrade === "A" || entryQualityGrade === "B");

                if (
                    qualityScore < 70 &&
                    !isBypassRangeUpperShort &&
                    !(
                        v2DecisionBeforePromotion === "ENTER" &&
                        v2SideBeforePromotion !== "none"
                    )
                ) {
                    promotionBlockReason = "TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD";
                    expectedNextAction = "WAIT_FOR_QUALITY_IMPROVEMENT";
                    expectedMissingCondition = "TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD";
                } else if (zone === "lower" && trendSideCandidate === "short") {
                    const lowerShortFallbackEval = evaluateLowerBreakdownShortConfirmed({
                        ...rangeBoundaryCtx,
                        trendSideCandidate: "short"
                    });
                    promotionBlockReason =
                        lowerShortFallbackEval.holdReason ??
                        "TREND_PROMOTION_BLOCKED_RANGE_ZONE_NOT_BREAKDOWN_CONFIRMED";
                    expectedNextAction = "WAIT_FOR_BREAKDOWN_RETEST_RESISTANCE_CONFIRM";
                    expectedMissingCondition = promotionBlockReason;
                    // EXECUTOR-ENTER PRESERVATION GUARD: do not demote an already-valid executor ENTER
                    // via recheck-only fallback gates. Only demote if executor itself did not produce ENTER.
                    if (v2DecisionBeforePromotion !== "ENTER") {
                        v2DecisionAfterPromotion = "HOLD";
                        v2RejectReasonAfterPromotion = "WAIT_RECHECK";
                    }
                } else if (
                    zone === "upper" &&
                    trendSideCandidate === "long" &&
                    marketMode === "RANGE"
                ) {
                    const upperLongFallbackEval = evaluateUpperBreakoutLongConfirmed({
                        ...rangeBoundaryCtx,
                        trendSideCandidate: "long"
                    });
                    if (!upperLongFallbackEval.confirmed) {
                        promotionBlockReason =
                            upperLongFallbackEval.holdReason ??
                            "TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED";
                        expectedNextAction = "WAIT_FOR_BREAKOUT_RETEST_SUPPORT_CONFIRM";
                        expectedMissingCondition = promotionBlockReason;
                        // EXECUTOR-ENTER PRESERVATION GUARD: do not demote an already-valid executor ENTER
                        // via recheck-only fallback gates. Only demote if executor itself did not produce ENTER.
                        if (v2DecisionBeforePromotion !== "ENTER") {
                            v2DecisionAfterPromotion = "HOLD";
                            v2RejectReasonAfterPromotion = "WAIT_RECHECK";
                        }
                    }
                } else if (
                    !(
                        v2DecisionBeforePromotion === "ENTER" &&
                        v2SideBeforePromotion !== "none"
                    )
                ) {
                    if (marketMode === "RANGE" && (boxBreakSide === "none" || boxBreakSide === "UNKNOWN")) {
                        promotionBlockReason = "TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED";
                        expectedNextAction = "WAIT_FOR_BREAKOUT_RETEST_SUPPORT_CONFIRM";
                        expectedMissingCondition = "TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED";
                    } else {
                        promotionBlockReason = "TREND_PROMOTION_BLOCKED_SUPPORT_RECHECK_REQUIRED";
                        expectedNextAction = "WAIT_FOR_RECHECK_OR_RETEST";
                        expectedMissingCondition = "TREND_PROMOTION_BLOCKED_SUPPORT_RECHECK_REQUIRED";
                    }
                }
            }
        }

        if (transitionWatchShortConditionsMet) {
            const atr = Number(input.snapshot.atr ?? 0);
            const transitionInvalidationPx = lastPrice + Math.max(lastPrice * 0.002, atr * 0.35);

            let stopPriceValid = transitionInvalidationPx > lastPrice && !isNaN(transitionInvalidationPx);

            if (!stopPriceValid) {
                 console.warn(JSON.stringify({
                    event: "V2_TRANSITION_STOP_PRICE_INVALID_BLOCK_PROOF",
                    symbol: String(input.symbol),
                    side: "short",
                    lastPrice,
                    calculatedInvalidationPx: transitionInvalidationPx
                }));
            } else {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = "short";
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "V2_TRANSITION_WATCH_SHORT_PROBE";
                promotionBlockReason = null;
                shockReactionBlockReason = null;
                v2CalculatedInvalidationPx = transitionInvalidationPx;

                console.info(JSON.stringify({
                    event: "V2_SHOCK_REACTION_PROMOTION_PROOF",
                    symbol: String(input.symbol),
                    shock_state: shock,
                    side: "short",
                    zone,
                    quality_score: qualityScore,
                    promotion_reason: "V2_TRANSITION_WATCH_SHORT_PROBE",
                    invalidationPx: transitionInvalidationPx
                }));
            }
        }

        if (promotionApplied) {
            if (shockReactionPromotionType == null && shock === "DOWN") {
                if (v2SideAfterPromotion === "short" && zone === "upper") shockReactionPromotionType = "upper_failure_short";
                else if (v2SideAfterPromotion === "short" && zone === "lower") shockReactionPromotionType = "lower_breakdown_continuation_short";
                else if (v2SideAfterPromotion === "long" && zone === "lower" && reversalConfirmed) shockReactionPromotionType = "lower_reversal_confirmed_long";
            } else if (shockReactionPromotionType == null && shock === "UP") {
                if (v2SideAfterPromotion === "long" && zone === "lower") shockReactionPromotionType = "lower_support_long";
                else if (v2SideAfterPromotion === "long" && zone === "upper") shockReactionPromotionType = "upper_breakout_continuation_long";
                else if (v2SideAfterPromotion === "short" && zone === "upper" && reversalConfirmed) shockReactionPromotionType = "upper_reversal_confirmed_short";
            }
            if (shockReactionPromotionType != null) {
                const setupEvidence = shockReactionSetupEvidence ?? {
                    boxBreakSide,
                    emaGap,
                    trend_side_candidate: trendSideCandidate,
                    range_side_candidate: rangeSideCandidate,
                    reversal_confirmed: reversalConfirmed,
                    relaxedRangeEntry,
                    shock_recovery_hint: shockRecoveryHint
                };
                console.info(JSON.stringify({
                    event: "SHOCK_REACTION_PROMOTION_PROOF",
                    symbol: String(input.symbol),
                    directional_shock_state: shock,
                    crash_state: crashState || null,
                    pump_state: pumpStateResolved || null,
                    market_mode: marketMode,
                    active_engine_routing: activeEngineRouting,
                    boxPos,
                    zone,
                    side_before: v2SideBeforePromotion,
                    side_after: v2SideAfterPromotion,
                    decision_before: v2DecisionBeforePromotion,
                    decision_after: v2DecisionAfterPromotion,
                    promotion_applied: promotionApplied,
                    promotion_type: shockReactionPromotionType,
                    setup_type: shockReactionPromotionType,
                    setup_evidence: setupEvidence,
                    shock_edge_setup_active_reason: shockEdgeSetupActiveReason.length > 0 ? shockEdgeSetupActiveReason.join("|") : null,
                    boxBreakSide,
                    emaGap,
                    qualityScore,
                    rangeConfidence,
                    boxCohesion01,
                    trendWeaknessScore: trendWeaknessFromMeta,
                    reviewingTicks,
                    trend_side_candidate: trendSideCandidate,
                    range_side_candidate: rangeSideCandidate,
                    promotion_block_reason: promotionBlockReason,
                    promotion_min_condition_passed: promotionMinConditionPassed,
                    reversal_confirmed: reversalConfirmed,
                    relaxedRangeEntry,
                    shock_recovery_hint: shockRecoveryHint,
                    longAllow: riskLongAllow,
                    shortAllow: riskShortAllow,
                    allowed_primary_side: shockReactionAllowedPrimarySide,
                    countertrend_exception_used: countertrendExceptionUsed,
                    range_edge_extreme: rangeEdgeExtreme,
                    side_zone_valid: sideZoneValid,
                    hard_block_present: hardBlockPresent,
                    hard_block_reason: hardBlockReason
                }));
            }
        }
    } else {
        promotionBlockReason = "HARD_CONTROL_NOT_CLEAR";
    }

    // --- V2_RANGE_TREND_CONFLICT_RESOLUTION_PROOF ---
    // Tier 4.8: Conflict Resolution (Range vs Trend)
    const localConflict =
        (activeEngineRouting === "RANGE" || activeEngineRouting === "TRANSITION" || activeEngineRouting === "TREND") &&
        rangeSideCandidate !== "none" && trendSideCandidate !== "none" &&
        rangeSideCandidate !== trendSideCandidate;

    const candlesForStairStep = input.candles ?? input.snapshot.candles;
    const stairStepResult = detectStairStepStructure({
        candles: candlesForStairStep,
        snapshot: input.snapshot,
        judgment
    });

    let conflictResolvedUpperShort = false;
    let conflictResolvedTrendLong = false;
    let conflictResolutionAction = "none";
    let conflictResolutionReason = "no_conflict_or_conditions_unmet";

    // Tier 4.8.1: Structural Reclaim Range-Trend Conflict Micro Probe (0.25x Explicit Micro Probe)
    if (localConflict) {
        const lastEarlyDecay = getLastEarlyDecayReclaim(String(input.symbol));
        const nowMsForReclaim = input.now || Date.now();
        const currentBoxPos = Number(boxPos ?? 0.5);

        const rawShock = (v2State.rawDirectionalShockState ?? input.state.directionalShockState ?? "NONE") as string;
        const isBullishReclaimCandidate =
            lastEarlyDecay != null &&
            !lastEarlyDecay.consumed &&
            lastEarlyDecay.direction === "bullish" &&
            lastEarlyDecay.boxPos <= 0.65 &&
            (nowMsForReclaim - lastEarlyDecay.ts) <= 60000 &&
            shock === "NONE" &&
            rawShock === "NONE" &&
            trendSideCandidate === "long" &&
            currentBoxPos <= 0.65;

        const isBearishReclaimCandidate =
            lastEarlyDecay != null &&
            !lastEarlyDecay.consumed &&
            lastEarlyDecay.direction === "bearish" &&
            lastEarlyDecay.boxPos >= 0.35 &&
            (nowMsForReclaim - lastEarlyDecay.ts) <= 60000 &&
            shock === "NONE" &&
            rawShock === "NONE" &&
            trendSideCandidate === "short" &&
            currentBoxPos >= 0.35;

        const isReclaimProbeCandidate =
            (isBullishReclaimCandidate || isBearishReclaimCandidate) &&
            localConflict &&
            qualityScore >= 64 &&
            (entryQualityGrade === "S" || entryQualityGrade === "A" || entryQualityGrade === "B") &&
            judgment.htf_entry_policy !== "HOLD" &&
            judgment.htf_entry_policy !== "REJECT" &&
            !whipsawShockRecheckActive &&
            hardBlockPresent === false &&
            hardControlClear === true &&
            paperExecutionReady === true &&
            signedExecutionReady === true;

        if (isReclaimProbeCandidate && (v2DecisionAfterPromotion === "HOLD" || v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "REJECT" || !promotionApplied)) {
            const sideToPromote = isBullishReclaimCandidate ? "long" : "short";
            const hasSameSidePos = v2State.currentPositions.some(p => p && p.symbol === input.symbol && String(p.side).toLowerCase() === sideToPromote);
            const hasOppositeSidePos = v2State.currentPositions.some(p => p && p.symbol === input.symbol && String(p.side).toLowerCase() !== sideToPromote);
            const sideAllowed = sideToPromote === "long" ? (riskLongAllow && allowNewLong) : (riskShortAllow && allowNewShort);

            if (!hasSameSidePos && !hasOppositeSidePos && sideAllowed) {
                const trendStops = calculateAuthoritativeTrendStructuralStop(authoritativeInput.snapshot, sideToPromote);
                const candidateStop = trendStops?.stopPrice ?? trendStops?.invalidationPx ?? null;
                const entryPrice = Number(authoritativeInput.snapshot.lastPrice ?? 0);
                const isValidStop = typeof candidateStop === "number" && Number.isFinite(candidateStop) && candidateStop > 0 &&
                    (sideToPromote === "long" ? candidateStop < entryPrice : candidateStop > entryPrice);

                let calculatedStop = isValidStop ? candidateStop : (sideToPromote === "long" ? entryPrice * 0.995 : entryPrice * 1.005);

                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = sideToPromote;
                promotionApplied = true;
                promotionReason = "V2_RANGE_TREND_RECLAIM_MICRO_PROBE";
                v2RejectReasonAfterPromotion = null;
                v2CalculatedInvalidationPx = calculatedStop;
                execution.stopPrice = calculatedStop;
                execution.invalidationPx = calculatedStop;

                execMeta.entryReason = "V2_RANGE_TREND_RECLAIM_MICRO_PROBE";
                execMeta.entry_reason = "V2_RANGE_TREND_RECLAIM_MICRO_PROBE";
                execMeta.range_trend_reclaim_micro_probe = true;

                consumeLastEarlyDecayReclaim(String(input.symbol));

                console.info(JSON.stringify({
                    event: "V2_RANGE_TREND_RECLAIM_MICRO_PROBE_PROOF",
                    symbol: String(input.symbol),
                    side: sideToPromote,
                    entryPrice,
                    stopPrice: calculatedStop,
                    boxPos: currentBoxPos,
                    reclaimBoxPos: lastEarlyDecay!.boxPos,
                    reclaimAgeMs: nowMsForReclaim - lastEarlyDecay!.ts,
                    qualityScore,
                    entryQualityGrade,
                    htfPolicy: judgment.htf_entry_policy,
                    probeMultiplier: 0.25,
                    reason: "V2_RANGE_TREND_RECLAIM_MICRO_PROBE"
                }));
            }
        }
    }

    if (localConflict && zone === "upper") {
        // upper zone short
        if (rangeSideCandidate === "short") {
            const stopPrice = execution.stopPrice;
            const hasValidRangeStop = typeof stopPrice === "number" && Number.isFinite(stopPrice) && stopPrice > 0;

            if (reversalConfirmed === true && qualityScore >= 65) {
                if (!hasValidRangeStop) {
                    conflictResolutionAction = "skip";
                    conflictResolutionReason = "upper_short_stop_price_invalid_or_null";
                    v2DecisionAfterPromotion = "SKIP";
                    v2SideAfterPromotion = "none";
                    v2RejectReasonAfterPromotion = "CONFLICT_STOP_PRICE_NULL";
                    promotionApplied = false;
                    promotionReason = null;
                } else {
                    v2DecisionAfterPromotion = "ENTER";
                    v2SideAfterPromotion = "short";
                    promotionApplied = true;
                    promotionReason = "V2_CONFLICT_RESOLVED_UPPER_SHORT";
                    v2RejectReasonAfterPromotion = null;
                    conflictResolvedUpperShort = true;
                    conflictResolutionAction = "enter_short";
                    conflictResolutionReason = "upper_zone_short_reversal_confirmed";

                    execMeta.entryReason = "V2_CONFLICT_RESOLVED_UPPER_SHORT";
                    v2CalculatedInvalidationPx = stopPrice;
                }
            }
        }

        // trend long
        if (!conflictResolvedUpperShort && trendSideCandidate === "long" && !(stairStepResult.detected && stairStepResult.direction === "UP")) {
            const upperBreakoutHold = judgment.metadata?.box_upper_breakout_hold === true || judgment.metadata?.upper_breakout_hold === true || judgment.diagnostics?.fastTrendShift?.box_upper_breakout_hold === true;
            const reclaimConfirmedVal = judgment.metadata?.reclaimConfirmed === true || judgment.metadata?.reclaim_confirmed === true || judgment.transitionPhase === "RETEST_CONFIRMED" || judgment.diagnostics?.fastTrendShift?.box_mid_reclaimed === true;
            if ((upperBreakoutHold || reclaimConfirmedVal) && qualityScore >= 67 && trendOk === true) {
                const hasSameSidePos = v2State.currentPositions.some(p => p.symbol === input.symbol && String(p.side).toLowerCase() === "long");
                const hasOppositeSidePos = v2State.currentPositions.some(p => p.symbol === input.symbol && String(p.side).toLowerCase() === "short");
                const canPromoteTrendLong =
                    v2DecisionBeforePromotion !== "REJECT" &&
                    hardBlockPresent === false &&
                    hardControlClear === true &&
                    paperExecutionReady === true &&
                    signedExecutionReady === true &&
                    hasSameSidePos === false &&
                    hasOppositeSidePos === false &&
                    riskLongAllow === true &&
                    allowNewLong === true;

                if (canPromoteTrendLong) {
                    const trendStops = calculateAuthoritativeTrendStructuralStop(authoritativeInput.snapshot, "long");
                    const candidateStop = trendStops?.stopPrice ?? trendStops?.invalidationPx ?? null;
                    const entryPrice = Number(authoritativeInput.snapshot.lastPrice ?? 0);
                    const isValidTrendStop =
                        typeof candidateStop === "number" &&
                        Number.isFinite(candidateStop) &&
                        candidateStop > 0 &&
                        entryPrice > 0 &&
                        candidateStop < entryPrice;

                    if (!isValidTrendStop) {
                        conflictResolutionAction = "skip";
                        conflictResolutionReason = "authoritative_trend_stop_invalid_or_missing";
                        v2DecisionAfterPromotion = "SKIP";
                        v2SideAfterPromotion = "none";
                        v2RejectReasonAfterPromotion = "CONFLICT_TREND_STOP_INVALID";
                        promotionApplied = false;
                        promotionReason = null;
                    } else {
                        v2DecisionAfterPromotion = "ENTER";
                        v2SideAfterPromotion = "long";
                        promotionApplied = true;
                        promotionReason = "V2_CONFLICT_RESOLVED_TREND_LONG";
                        v2RejectReasonAfterPromotion = null;
                        conflictResolvedTrendLong = true;
                        conflictResolutionAction = "enter_long_probe";
                        conflictResolutionReason = "trend_long_breakout_hold_or_reclaim_confirmed";
                        v2CalculatedInvalidationPx = candidateStop;

                        execMeta.entryReason = "V2_CONFLICT_RESOLVED_TREND_LONG";
                    }
                }
            }
        }

        // 단순 upper/mid chase long 금지. Confirmed RANGE boundary continuation must not be undone.
        const continuationPromotionProtected =
            promotionApplied === true &&
            (promotionReason === "V2_UPPER_LONG_PROBE_PROMOTION" ||
             promotionReason === "V2_RANGE_TREND_RECLAIM_MICRO_PROBE");
        const ftsUpperLongStructuralForConflict = evaluateFastTrendShiftUpperLongZoneConfirmed({
            fastTrendShift: judgment.diagnostics?.fastTrendShift ?? null,
            zone,
            trendOk: trendOk === true,
            qualityScore,
            htfEntryPolicy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
            htfRequiresStrongerConfirmation: judgment.htf_requires_stronger_confirmation === true,
            counterTrendRisk: judgment.counter_trend_risk === true,
            lateChaseBlocked: (execMeta as Record<string, unknown>).late_chase_blocked === true,
            hardBlockPresent,
            whipsawShockRecheckActive,
            riskLongAllow,
            allowNewLong,
            hasSameSidePosition: v2State.currentPositions.some(
                (p) => p.symbol === input.symbol && String(p.side).toLowerCase() === "long"
            ),
            hasOppositeSidePosition: v2State.currentPositions.some(
                (p) => p.symbol === input.symbol && String(p.side).toLowerCase() === "short"
            ),
            paperExecutionReady,
            signedExecutionReady,
            boxMid:
                typeof authoritativeInput.snapshot.boxHigh === "number" &&
                typeof authoritativeInput.snapshot.boxLow === "number"
                    ? (Number(authoritativeInput.snapshot.boxHigh) + Number(authoritativeInput.snapshot.boxLow)) / 2
                    : null,
            lastPrice: Number(authoritativeInput.snapshot.lastPrice ?? 0)
        }).confirmed;
        if (
            !conflictResolvedUpperShort &&
            !conflictResolvedTrendLong &&
            !ftsUpperLongStructuralForConflict &&
            trendSideCandidate === "long" &&
            !continuationPromotionProtected
        ) {
            conflictResolutionAction = "skip";
            conflictResolutionReason = "chase_long_disallowed_in_upper_zone";
            v2DecisionAfterPromotion = "SKIP";
            v2SideAfterPromotion = "none";
            v2RejectReasonAfterPromotion = "CHASE_LONG_DISALLOWED_UPPER";
            promotionApplied = false;
            promotionReason = null;
        }

        console.info(JSON.stringify({
            event: "V2_RANGE_TREND_CONFLICT_RESOLUTION_PROOF",
            symbol: String(input.symbol),
            range_side_candidate: rangeSideCandidate,
            trend_side_candidate: trendSideCandidate,
            zone,
            reversal_confirmed: reversalConfirmed,
            upper_breakout_hold: judgment.metadata?.box_upper_breakout_hold === true || judgment.metadata?.upper_breakout_hold === true || judgment.diagnostics?.fastTrendShift?.box_upper_breakout_hold === true,
            reclaim_confirmed: judgment.metadata?.reclaimConfirmed === true,
            quality_score: qualityScore,
            trend_ok: trendOk,
            action: conflictResolutionAction,
            reason: conflictResolutionReason
        }));
    } else if (localConflict && zone === "lower") {
        let conflictResolvedLowerLong = false;
        let conflictResolvedTrendShort = false;

        // lower zone long
        if (rangeSideCandidate === "long") {
            const stopPrice = execution.stopPrice;
            const hasValidRangeStop = typeof stopPrice === "number" && Number.isFinite(stopPrice) && stopPrice > 0;

            if (reversalConfirmed === true && qualityScore >= 65) {
                if (!hasValidRangeStop) {
                    conflictResolutionAction = "skip";
                    conflictResolutionReason = "lower_long_stop_price_invalid_or_null";
                    v2DecisionAfterPromotion = "SKIP";
                    v2SideAfterPromotion = "none";
                    v2RejectReasonAfterPromotion = "CONFLICT_STOP_PRICE_NULL";
                    promotionApplied = false;
                    promotionReason = null;
                } else {
                    v2DecisionAfterPromotion = "ENTER";
                    v2SideAfterPromotion = "long";
                    promotionApplied = true;
                    promotionReason = "V2_CONFLICT_RESOLVED_LOWER_LONG";
                    v2RejectReasonAfterPromotion = null;
                    conflictResolvedLowerLong = true;
                    conflictResolutionAction = "enter_long";
                    conflictResolutionReason = "lower_zone_long_reversal_confirmed";

                    execMeta.entryReason = "V2_CONFLICT_RESOLVED_LOWER_LONG";
                    v2CalculatedInvalidationPx = stopPrice;
                }
            }
        }

        // trend short
        if (!conflictResolvedLowerLong && trendSideCandidate === "short" && !(stairStepResult.detected && stairStepResult.direction === "DOWN")) {
            const lowerBreakdownHold = judgment.metadata?.box_lower_breakdown_hold === true || judgment.metadata?.lower_breakdown_hold === true || judgment.diagnostics?.fastTrendShift?.box_lower_breakdown_hold === true;
            const reclaimLostVal = judgment.metadata?.reclaimLost === true || judgment.metadata?.reclaim_lost === true || judgment.transitionPhase === "RETEST_CONFIRMED" || judgment.diagnostics?.fastTrendShift?.box_mid_lost === true;
            if ((lowerBreakdownHold || reclaimLostVal) && qualityScore >= 67 && trendOk === true) {
                const hasSameSidePos = v2State.currentPositions.some(p => p.symbol === input.symbol && String(p.side).toLowerCase() === "short");
                const hasOppositeSidePos = v2State.currentPositions.some(p => p.symbol === input.symbol && String(p.side).toLowerCase() === "long");
                const canPromoteTrendShort =
                    v2DecisionBeforePromotion !== "REJECT" &&
                    hardBlockPresent === false &&
                    hardControlClear === true &&
                    paperExecutionReady === true &&
                    signedExecutionReady === true &&
                    hasSameSidePos === false &&
                    hasOppositeSidePos === false &&
                    riskShortAllow === true &&
                    allowNewShort === true;

                if (canPromoteTrendShort) {
                    const trendStops = calculateAuthoritativeTrendStructuralStop(authoritativeInput.snapshot, "short");
                    const candidateStop = trendStops?.stopPrice ?? trendStops?.invalidationPx ?? null;
                    const entryPrice = Number(authoritativeInput.snapshot.lastPrice ?? 0);
                    const isValidTrendStop =
                        typeof candidateStop === "number" &&
                        Number.isFinite(candidateStop) &&
                        candidateStop > 0 &&
                        entryPrice > 0 &&
                        candidateStop > entryPrice;

                    if (!isValidTrendStop) {
                        conflictResolutionAction = "skip";
                        conflictResolutionReason = "authoritative_trend_stop_invalid_or_missing";
                        v2DecisionAfterPromotion = "SKIP";
                        v2SideAfterPromotion = "none";
                        v2RejectReasonAfterPromotion = "CONFLICT_TREND_STOP_INVALID";
                        promotionApplied = false;
                        promotionReason = null;
                    } else {
                        v2DecisionAfterPromotion = "ENTER";
                        v2SideAfterPromotion = "short";
                        promotionApplied = true;
                        promotionReason = "V2_CONFLICT_RESOLVED_TREND_SHORT";
                        v2RejectReasonAfterPromotion = null;
                        conflictResolvedTrendShort = true;
                        conflictResolutionAction = "enter_short_probe";
                        conflictResolutionReason = "trend_short_breakdown_hold_or_loss_confirmed";
                        v2CalculatedInvalidationPx = candidateStop;

                        execMeta.entryReason = "V2_CONFLICT_RESOLVED_TREND_SHORT";
                    }
                }
            }
        }

        // 단순 lower/mid chase short 금지. Confirmed RANGE boundary continuation must not be undone.
        const continuationPromotionProtected =
            promotionApplied === true &&
            (promotionReason === "V2_LOWER_SHORT_PROBE_PROMOTION" ||
             promotionReason === "V2_RANGE_TREND_RECLAIM_MICRO_PROBE");
        const ftsLowerShortStructuralForConflict = evaluateFastTrendShiftLowerShortZoneConfirmed({
            fastTrendShift: judgment.diagnostics?.fastTrendShift ?? null,
            zone,
            trendOk: trendOk === true,
            qualityScore,
            htfEntryPolicy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
            htfRequiresStrongerConfirmation: judgment.htf_requires_stronger_confirmation === true,
            counterTrendRisk: judgment.counter_trend_risk === true,
            lateChaseBlocked: (execMeta as Record<string, unknown>).late_chase_blocked === true,
            hardBlockPresent,
            whipsawShockRecheckActive,
            riskShortAllow,
            allowNewShort,
            hasSameSidePosition: v2State.currentPositions.some(
                (p) => p.symbol === input.symbol && String(p.side).toLowerCase() === "short"
            ),
            hasOppositeSidePosition: v2State.currentPositions.some(
                (p) => p.symbol === input.symbol && String(p.side).toLowerCase() === "long"
            ),
            paperExecutionReady,
            signedExecutionReady,
            boxMid:
                typeof authoritativeInput.snapshot.boxHigh === "number" &&
                typeof authoritativeInput.snapshot.boxLow === "number"
                    ? (Number(authoritativeInput.snapshot.boxHigh) + Number(authoritativeInput.snapshot.boxLow)) / 2
                    : null,
            lastPrice: Number(authoritativeInput.snapshot.lastPrice ?? 0)
        }).confirmed;
        if (
            !conflictResolvedLowerLong &&
            !conflictResolvedTrendShort &&
            !ftsLowerShortStructuralForConflict &&
            trendSideCandidate === "short" &&
            !continuationPromotionProtected
        ) {
            conflictResolutionAction = "skip";
            conflictResolutionReason = "chase_short_disallowed_in_lower_zone";
            v2DecisionAfterPromotion = "SKIP";
            v2SideAfterPromotion = "none";
            v2RejectReasonAfterPromotion = "CHASE_SHORT_DISALLOWED_LOWER";
            promotionApplied = false;
            promotionReason = null;
        }

        console.info(JSON.stringify({
            event: "V2_RANGE_TREND_CONFLICT_RESOLUTION_PROOF",
            symbol: String(input.symbol),
            range_side_candidate: rangeSideCandidate,
            trend_side_candidate: trendSideCandidate,
            zone,
            reversal_confirmed: reversalConfirmed,
            lower_breakdown_hold: judgment.metadata?.box_lower_breakdown_hold === true || judgment.metadata?.lower_breakdown_hold === true || judgment.diagnostics?.fastTrendShift?.box_lower_breakdown_hold === true,
            reclaim_lost: judgment.metadata?.reclaimLost === true || judgment.diagnostics?.fastTrendShift?.box_mid_lost === true,
            quality_score: qualityScore,
            trend_ok: trendOk,
            action: conflictResolutionAction,
            reason: conflictResolutionReason
        }));
    }

    // -------------------------------------------------------------------------
    // Tier 4.9: STAIR-STEP CONTINUATION PROMOTION (Symmetric UP / DOWN)
    // -------------------------------------------------------------------------

    let stairStepPromoted = false;
    let stairStepPromotionReason: string | null = null;

    const isRangeFamily =
        activeEngineRouting === "RANGE" ||
        judgment.regime === "RANGE" ||
        String(judgment.subtype).startsWith("RANGE") ||
        judgment.subtype === "ASCENDING_CHANNEL" ||
        judgment.subtype === "DESCENDING_CHANNEL";

    if (
        !promotionApplied &&
        isRangeFamily &&
        v2DecisionBeforePromotion !== "REJECT" &&
        qualityScore >= 70 &&
        (v2DecisionAfterPromotion === "SKIP" || v2DecisionAfterPromotion === "HOLD") &&
        stairStepResult.detected === true &&
        stairStepResult.confidence >= 0.7 &&
        stairStepResult.reclaim_or_rejection_confirmed === true
    ) {
        const macroPolarity = judgment.macroPolarity ?? "NEUTRAL";
        const htfPolicy = judgment.htf_entry_policy ?? "ALLOW";
        const htfHardBlock = judgment.htf_hard_block_reason ?? "";
        const entryPx = Number(authoritativeInput.snapshot.lastPrice ?? 0);
        const atrVal = Number(authoritativeInput.snapshot.atr ?? 0);
        const candleArr = candlesForStairStep ?? [];

        // UP Evaluation
        if (stairStepResult.direction === "UP") {
            const htfVetoLong = htfPolicy === "SHORT_ONLY_OR_NONE" || (htfPolicy === "HOLD" && htfHardBlock === "STRONG_BEARISH_HTF_ALIGNMENT") || macroPolarity === "BEARISH";
            if (!htfVetoLong && entryPx > 0) {
                const stopDist = Math.max(atrVal * 1.5, entryPx * 0.005);
                let stopPx = entryPx - stopDist;

                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = "long";
                promotionApplied = true;
                promotionReason = "V2_STAIR_STEP_CONTINUATION_PROMOTION";
                v2CalculatedInvalidationPx = stopPx;
                v2RejectReasonAfterPromotion = null;
                stairStepPromoted = true;
                stairStepPromotionReason = "STAIR_STEP_UP_RECLAIM_CONFIRMED";
                execMeta.entryReason = "V2_STAIR_STEP_CONTINUATION_PROMOTION";
                execMeta.stair_step_promoted = true;

                console.info(JSON.stringify({
                    event: "V2_STAIR_STEP_PROMOTION_PROOF",
                    symbol: String(input.symbol),
                    direction: "UP",
                    side: "long",
                    entryPx,
                    stopPx,
                    htfPolicy,
                    macroPolarity,
                    confidence: stairStepResult.confidence,
                    decision: "ENTER",
                    promotion_reason: promotionReason
                }));
            }
        }
        // DOWN Evaluation (Exact Symmetric Inverse)
        else if (stairStepResult.direction === "DOWN") {
            const htfVetoShort = htfPolicy === "LONG_ONLY_OR_NONE" || (htfPolicy === "HOLD" && htfHardBlock === "STRONG_BULLISH_HTF_ALIGNMENT") || macroPolarity === "BULLISH";
            if (!htfVetoShort && entryPx > 0) {
                const stopDist = Math.max(atrVal * 1.5, entryPx * 0.005);
                let stopPx = entryPx + stopDist;

                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = "short";
                promotionApplied = true;
                promotionReason = "V2_STAIR_STEP_CONTINUATION_PROMOTION";
                v2CalculatedInvalidationPx = stopPx;
                v2RejectReasonAfterPromotion = null;
                stairStepPromoted = true;
                stairStepPromotionReason = "STAIR_STEP_DOWN_REJECTION_CONFIRMED";
                execMeta.entryReason = "V2_STAIR_STEP_CONTINUATION_PROMOTION";
                execMeta.stair_step_promoted = true;

                console.info(JSON.stringify({
                    event: "V2_STAIR_STEP_PROMOTION_PROOF",
                    symbol: String(input.symbol),
                    direction: "DOWN",
                    side: "short",
                    entryPx,
                    stopPx,
                    htfPolicy,
                    macroPolarity,
                    confidence: stairStepResult.confidence,
                    decision: "ENTER",
                    promotion_reason: promotionReason
                }));
            }
        }
    }

    // -------------------------------------------------------------------------
    // Tier 4.95: DEDICATED TREND CONTINUATION REVALIDATION (Symmetric UP / DOWN)
    // -------------------------------------------------------------------------
    let isTrendContinuationRevalidated = false;

    const isAuthoritativeTrendRegime =
        judgment.regime === "TREND" &&
        judgment.regime_final === "TREND" &&
        authoritativeInput.snapshot.canonicalRegime === "TREND" &&
        activeEngineRouting === "TREND";

    const isTrendContinuationSubtype =
        judgment.subtype === "TREND_UP_CONTINUATION" ||
        judgment.subtype === "TREND_DOWN_CONTINUATION";

    const hasSameSidePos = v2State.currentPositions.some(p => p && p.symbol === input.symbol && String(p.side).toLowerCase() === trendSideCandidate);
    const hasOppositeSidePos = v2State.currentPositions.some(p => p && p.symbol === input.symbol && String(p.side).toLowerCase() !== trendSideCandidate);

    const trendContinuationCommonEligible =
        (!promotionApplied || promotionReason === "V2_TREND_QUALIFIED_FINAL_PROMOTION" || promotionReason === "V2_WAIT_RECHECK_QUALIFIED_PROMOTION" || promotionReason === "V2_CONTAMINATION_SOFTENED_FOR_HIGH_QUALITY_AUTHORITY") &&
        isAuthoritativeTrendRegime &&
        isTrendContinuationSubtype &&
        v2DecisionBeforePromotion !== "REJECT" &&
        v2DecisionBeforePromotion !== "ENTER" &&
        trendOk === true &&
        qualityScore >= 70 &&
        hardBlockPresent === false &&
        hardControlClear === true &&
        paperExecutionReady === true &&
        signedExecutionReady === true &&
        !hasSameSidePos &&
        !hasOppositeSidePos &&
        (riskSizing.diagnostics as any)?.contamination_hard_reject !== true &&
        (riskSizing as any)?.isContaminated !== true;

    if (trendContinuationCommonEligible) {
        const macroPolarity = String(judgment.macroPolarity ?? "NEUTRAL").toUpperCase();
        const htfPolicy = String(judgment.htf_entry_policy ?? "ALLOW").toUpperCase();
        const shock = v2State.directionalShockState ?? (judgment.shockPhase === "DOWN_SHOCK" ? "DOWN" : judgment.shockPhase === "UP_SHOCK" ? "UP" : "NONE");
        const entryPx = Number(authoritativeInput.snapshot.lastPrice ?? 0);

        // UP Evaluation (LONG)
        if (
            judgment.subtype === "TREND_UP_CONTINUATION" &&
            trendSideCandidate === "long" &&
            riskLongAllow === true &&
            allowNewLong === true &&
            (htfPolicy === "ALLOW" || htfPolicy === "LONG_ONLY_OR_NONE") &&
            macroPolarity !== "BEARISH" &&
            shock !== "DOWN" &&
            entryPx > 0
        ) {
            const stopPx = execution.stopPrice;
            const invPx = execution.invalidationPx ?? stopPx;

            const stopValid =
                stopPx != null && invPx != null &&
                !isNaN(stopPx) && !isNaN(invPx) &&
                stopPx > 0 && stopPx < entryPx &&
                invPx > 0 && invPx < entryPx;

            if (stopValid) {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = "long";
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "V2_TREND_CONTINUATION_REVALIDATED";
                isTrendContinuationRevalidated = true;
                v2CalculatedInvalidationPx = invPx;
                execution.stopPrice = stopPx;
                execution.invalidationPx = invPx;
                promotionBlockReason = null;
                promotionMinConditionPassed = true;
                execMeta.entryReason = "V2_TREND_CONTINUATION_REVALIDATED";
                execMeta.trend_continuation_revalidated = true;

                console.info(JSON.stringify({
                    event: "V2_TREND_CONTINUATION_REVALIDATION_PROOF",
                    symbol: String(input.symbol),
                    direction: "UP",
                    side: "long",
                    entryPx,
                    stopPx,
                    invPx,
                    qualityScore,
                    htfPolicy,
                    macroPolarity,
                    directionalShock: shock,
                    decision: "ENTER",
                    promotion_reason: promotionReason
                }));
            }
        }
        // DOWN Evaluation (SHORT) - Exact symmetric inverse
        else if (
            judgment.subtype === "TREND_DOWN_CONTINUATION" &&
            trendSideCandidate === "short" &&
            riskShortAllow === true &&
            allowNewShort === true &&
            (htfPolicy === "ALLOW" || htfPolicy === "SHORT_ONLY_OR_NONE") &&
            macroPolarity !== "BULLISH" &&
            shock !== "UP" &&
            entryPx > 0
        ) {
            const stopPx = execution.stopPrice;
            const invPx = execution.invalidationPx ?? stopPx;

            const stopValid =
                stopPx != null && invPx != null &&
                !isNaN(stopPx) && !isNaN(invPx) &&
                stopPx > 0 && stopPx > entryPx &&
                invPx > 0 && invPx > entryPx;

            if (stopValid) {
                v2DecisionAfterPromotion = "ENTER";
                v2SideAfterPromotion = "short";
                v2RejectReasonAfterPromotion = null;
                promotionApplied = true;
                promotionReason = "V2_TREND_CONTINUATION_REVALIDATED";
                isTrendContinuationRevalidated = true;
                v2CalculatedInvalidationPx = invPx;
                execution.stopPrice = stopPx;
                execution.invalidationPx = invPx;
                promotionBlockReason = null;
                promotionMinConditionPassed = true;
                execMeta.entryReason = "V2_TREND_CONTINUATION_REVALIDATED";
                execMeta.trend_continuation_revalidated = true;

                console.info(JSON.stringify({
                    event: "V2_TREND_CONTINUATION_REVALIDATION_PROOF",
                    symbol: String(input.symbol),
                    direction: "DOWN",
                    side: "short",
                    entryPx,
                    stopPx,
                    invPx,
                    qualityScore,
                    htfPolicy,
                    macroPolarity,
                    directionalShock: shock,
                    decision: "ENTER",
                    promotion_reason: promotionReason
                }));
            }
        }
    }

    // Tier 5+: Side Consistency Enforcer (Authoritative)
    const sideCandidateBeforeVetoEnforced = v2SideAfterPromotion;

    const selectedSideFinalRaw: EngineV2Side =
        activeEngineRouting === "RANGE" ? rangeSideCandidate :
        activeEngineRouting === "TREND" ? trendSideCandidate :
        v2SideAfterPromotion;

    // --- V2 Side Selection Sanitization (V2_SIDE_SELECTION_SANITIZE_PROOF) ---
    // selected side 산정 직전, 상위 정책 및 shock state를 바탕으로 side 오염을 정화한다.
    const selected_side_before_sanitize: EngineV2Side = v2SideAfterPromotion;
    let selected_side_after_sanitize = selected_side_before_sanitize;
    let selected_side_final_after_sanitize = selectedSideFinalRaw;
    let sanitize_reason: string | null = null;
    let sanitizeTriggered = false;

    const directionalShockState = v2State.directionalShockState ?? "NONE";
    const htf_entry_policy = judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT";
    const longAllow = v2State.longAllow;
    const shortAllow = v2State.shortAllow;

    // 롱 진입 확인 여부 검증 (충분히 강한지)
    const isLongQualified = 
        trendSideCandidate === "long" && 
        longAllow === true && 
        trendOk === true && 
        qualityScore >= 70;

    const sanitizeCandidateSide = (side: EngineV2Side): { side: EngineV2Side; reason: string | null } => {
        if (side === "short") {
            // 원칙 1: directionalShockState=UP이면 short 후보 제거
            if (directionalShockState === "UP") {
                // 원칙 3: trend_side_candidate=long 이고 longAllow=true 이면 long 또는 none
                if (trendSideCandidate === "long" && longAllow) {
                    if (isLongQualified) {
                        return { side: "long", reason: "SHOCK_UP_SAN_LONG_QUALIFIED" };
                    } else {
                        return { side: "none", reason: "SHOCK_UP_TREND_CONFIRMATION_WEAK" };
                    }
                }
                return { side: "none", reason: "SHOCK_UP_EXCLUDES_SHORT" };
            }

            // 원칙 2: htf_entry_policy=LONG_ONLY_OR_NONE이면 short selected side를 none 또는 long 후보로 재해석
            if (htf_entry_policy === "LONG_ONLY_OR_NONE") {
                if (trendSideCandidate === "long" && longAllow) {
                    if (isLongQualified) {
                        return { side: "long", reason: "LONG_ONLY_POLICY_SAN_LONG_QUALIFIED" };
                    } else {
                        return { side: "none", reason: "WAIT_FOR_TREND_CONFIRMATION" };
                    }
                }
                return { side: "none", reason: "LONG_ONLY_POLICY_EXCLUDES_SHORT" };
            }

            // risk shortAllow=false 이면 당연히 short 배제
            if (!shortAllow) {
                if (trendSideCandidate === "long" && longAllow) {
                    if (isLongQualified) {
                        return { side: "long", reason: "SHORT_DISALLOWED_SAN_LONG_QUALIFIED" };
                    } else {
                        return { side: "none", reason: "WAIT_FOR_TREND_CONFIRMATION" };
                    }
                }
                return { side: "none", reason: "SHORT_DISALLOWED_EXCLUDES_SHORT" };
            }
        }
        return { side, reason: null };
    };

    const resSan1 = sanitizeCandidateSide(selected_side_before_sanitize);
    if (resSan1.reason) {
        selected_side_after_sanitize = resSan1.side;
        sanitize_reason = resSan1.reason;
        sanitizeTriggered = true;
    }

    const resSan2 = sanitizeCandidateSide(selectedSideFinalRaw);
    if (resSan2.reason) {
        selected_side_final_after_sanitize = resSan2.side;
        if (!sanitize_reason) {
            sanitize_reason = resSan2.reason;
        }
        sanitizeTriggered = true;
    }

    if (sanitizeTriggered) {
        v2SideAfterPromotion = selected_side_after_sanitize;
        
        if (v2SideAfterPromotion === "none" && v2DecisionAfterPromotion === "ENTER") {
            v2DecisionAfterPromotion = "HOLD";
            v2RejectReasonAfterPromotion = sanitize_reason ?? "WAIT_RECHECK";
        }
        if (v2SideAfterPromotion === "long" && v2DecisionAfterPromotion === "ENTER" && !longAllow) {
            v2DecisionAfterPromotion = "HOLD";
            v2RejectReasonAfterPromotion = "LONG_NOT_ALLOWED";
        }

        console.info(JSON.stringify({
            event: "V2_SIDE_SELECTION_SANITIZE_PROOF",
            symbol: String(input.symbol),
            directionalShockState,
            htf_entry_policy,
            longAllow,
            shortAllow,
            range_side_candidate: rangeSideCandidate,
            trend_side_candidate: trendSideCandidate,
            selected_side_before_sanitize,
            selected_side_after_sanitize,
            sanitize_reason
        }));
    }

    const selectedSideFinal: EngineV2Side = selected_side_final_after_sanitize;

    const promotionAppliedAtNativeAuthorityEval = promotionApplied;
    const nativeExecutorDecisionSource = v2DecisionBeforePromotion;
    const nativeExecutorSideSource = v2SideBeforePromotion;
    // Executor-native ENTER must survive paper-lane downgrade even when a later
    // same-side shock/promotion overlay re-affirms ENTER (promotionApplied=true).
    // Distinct promotion-generated ENTER (SKIP/HOLD -> ENTER) keeps promotion authority.
    const nativeExecutorEnterAuthority =
        v2DecisionBeforePromotion === "ENTER" &&
        v2SideBeforePromotion !== "none" &&
        (promotionAppliedAtNativeAuthorityEval === false ||
            v2SideAfterPromotion === v2SideBeforePromotion);

    const execMetaRecordForReconcile = execMeta as Record<string, unknown>;
    const nativeExecutorFastTrendShiftLowerShortPreserve =
        nativeExecutorEnterAuthority &&
        v2SideBeforePromotion === "short" &&
        activeEngineRouting === "RANGE" &&
        zone === "lower" &&
        (judgment.subtype === "FAST_TREND_SHIFT" || execMetaRecordForReconcile.fast_trend_shift === true);

    if (v2DecisionAfterPromotion === "ENTER") {
        if (promotionApplied && (v2SideAfterPromotion === "long" || v2SideAfterPromotion === "short")) {
            // Preserve the side assigned by the promotion logic
        } else if (nativeExecutorFastTrendShiftLowerShortPreserve) {
            v2SideAfterPromotion = v2SideBeforePromotion;
        } else if (
            nativeExecutorEnterAuthority &&
            (selectedSideFinal === "none" || selectedSideFinal === v2SideBeforePromotion)
        ) {
            v2SideAfterPromotion = v2SideBeforePromotion;
        } else {
            v2SideAfterPromotion = selectedSideFinal;
        }
    }

    const finalDecisionBeforeVeto = v2DecisionAfterPromotion;
    const sideCandidateBeforeVeto = v2SideAfterPromotion;
    let vetoReason: string | null = null;
    const rangeLowerShortMismatchByReason = signalGateBlockedReason === "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT";
    const rangeUpperLongMismatchByReason = signalGateBlockedReason === "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG";
    const isRangeRouting = activeEngineRouting === "RANGE";
    const isMicroProbePromotion = promotionReason === "CONTINUATION_MICRO_PROBE";
    const isStairStepPromotion = promotionReason === "V2_STAIR_STEP_CONTINUATION_PROMOTION";
    const isTrendContinuationRevalidatedPromotion = promotionReason === "V2_TREND_CONTINUATION_REVALIDATED";
    const isConflictResolvedTrendLongPromotion = promotionReason === "V2_CONFLICT_RESOLVED_TREND_LONG";
    const isConflictResolvedTrendShortPromotion = promotionReason === "V2_CONFLICT_RESOLVED_TREND_SHORT";
    const isRangeTrendReclaimProbePromotion = promotionReason === "V2_RANGE_TREND_RECLAIM_MICRO_PROBE";
    const isTrendQualifiedFinalPromotion =
        promotionReason === "V2_TREND_QUALIFIED_FINAL_PROMOTION" ||
        (isTrendAuthorityCandidate && promotionApplied === true);
    const rangeZoneVetoExempt =
        isMicroProbePromotion ||
        isRangeTrendReclaimProbePromotion ||
        isStairStepPromotion ||
        isTrendContinuationRevalidatedPromotion ||
        isTrendQualifiedFinalPromotion;
    const execMetaRecord = execMeta as Record<string, unknown>;
    const nativeExecutorFastProbeCoverage =
        nativeExecutorEnterAuthority &&
        (judgment.subtype === "FAST_TREND_SHIFT" ||
            judgment.subtype === "EARLY_LONG_PROBE" ||
            judgment.subtype === "EARLY_SHORT_PROBE" ||
            execMetaRecord.fast_trend_shift === true ||
            execMetaRecord.early_probe === true);
    const rangeLowerShortMismatchBeforeExemption =
        isRangeRouting &&
        !rangeZoneVetoExempt &&
        !isTrendAuthorityCandidate &&
        !isConflictResolvedTrendShortPromotion &&
        sideCandidateBeforeVeto === "short" &&
        (rangeLowerShortMismatchByReason || (boxPos ?? 0.5) <= rangeLowerThreshold);
    const nativeFtsLowerShortDeferZoneVeto =
        nativeExecutorEnterAuthority === true &&
        nativeExecutorFastProbeCoverage === true &&
        judgment.subtype === "FAST_TREND_SHIFT" &&
        v2SideBeforePromotion === "short" &&
        zone === "lower" &&
        isRangeRouting;
    const rangeLowerShortMismatch =
        rangeLowerShortMismatchBeforeExemption && !nativeFtsLowerShortDeferZoneVeto;
    const judgmentMetaForNativeUpper = (judgment.metadata ?? {}) as Record<string, unknown>;
    const continuationStateForNativeUpper = rangeContinuationStateMap.get(String(input.symbol));
    const hasSameSidePositionForNativeUpper = v2State.currentPositions.some(
        (p) => p.symbol === input.symbol && String(p.side).toLowerCase() === "long"
    );
    const hasOppositeSidePositionForNativeUpper = v2State.currentPositions.some(
        (p) => p.symbol === input.symbol && String(p.side).toLowerCase() === "short"
    );
    const nativeUpperBreakoutEvalCtx: RangeBoundaryContinuationContext = {
        trendSideCandidate: "long",
        zone,
        boxBreakSide,
        boxLow: Number(authoritativeInput.snapshot.boxLow ?? 0),
        boxHigh: Number(authoritativeInput.snapshot.boxHigh ?? 0),
        closedClose:
            typeof authoritativeInput.snapshot.closedClose === "number"
                ? authoritativeInput.snapshot.closedClose
                : null,
        lastPrice: Number(authoritativeInput.snapshot.lastPrice ?? 0),
        previousConfirmedBoxLow: continuationStateForNativeUpper?.previousConfirmedBoxLow ?? null,
        previousConfirmedBoxHigh: continuationStateForNativeUpper?.previousConfirmedBoxHigh ?? null,
        emaGap,
        htfEntryPolicy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
        htfRequiresStrongerConfirmation: judgment.htf_requires_stronger_confirmation === true,
        counterTrendRisk: judgment.counter_trend_risk === true,
        riskLongAllow,
        riskShortAllow,
        allowNewLong,
        allowNewShort,
        whipsawShockRecheckActive,
        hardBlockPresent,
        paperExecutionReady,
        signedExecutionReady,
        hasSameSidePosition: hasSameSidePositionForNativeUpper,
        hasOppositeSidePosition: hasOppositeSidePositionForNativeUpper,
        judgmentSubtype: String(judgment.subtype ?? ""),
        rangePhase: judgment.rangePhase ?? null,
        transitionPhase: judgment.transitionPhase ?? null,
        continuationDirection:
            typeof execMetaRecord.continuationDirection === "string"
                ? String(execMetaRecord.continuationDirection)
                : continuationStateForNativeUpper?.direction ?? null,
        continuationPhase:
            typeof execMetaRecord.continuationPhase === "string"
                ? String(execMetaRecord.continuationPhase)
                : continuationStateForNativeUpper?.phase ?? null,
        retestConfirmed:
            execMetaRecord.retest_confirmed === true || judgmentMetaForNativeUpper.retestConfirmed === true,
        retestTouched:
            execMetaRecord.retestTouched === true || judgmentMetaForNativeUpper.retestTouched === true,
        retestRejected:
            execMetaRecord.retestRejected === true || judgmentMetaForNativeUpper.retestRejected === true,
        reversalConfirmed,
        execReason: typeof execution.reason === "string" ? execution.reason : null,
        lateChaseBlocked: execMetaRecord.late_chase_blocked === true,
        retestRequired: execMetaRecord.retest_required === true
    };
    const nativeUpperBreakoutContinuationEval = evaluateUpperBreakoutLongConfirmed(nativeUpperBreakoutEvalCtx);
    const fastTrendShiftDiagForUpper = judgment.diagnostics?.fastTrendShift ?? null;
    const boxMidForFtsUpper =
        typeof authoritativeInput.snapshot.boxHigh === "number" &&
        typeof authoritativeInput.snapshot.boxLow === "number"
            ? (Number(authoritativeInput.snapshot.boxHigh) + Number(authoritativeInput.snapshot.boxLow)) / 2
            : null;
    const nativeFastTrendShiftUpperLongEval = evaluateFastTrendShiftUpperLongZoneConfirmed({
        fastTrendShift: fastTrendShiftDiagForUpper,
        zone,
        trendOk: trendOk === true,
        qualityScore,
        htfEntryPolicy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
        htfRequiresStrongerConfirmation: judgment.htf_requires_stronger_confirmation === true,
        counterTrendRisk: judgment.counter_trend_risk === true,
        lateChaseBlocked: execMetaRecord.late_chase_blocked === true,
        hardBlockPresent,
        whipsawShockRecheckActive,
        riskLongAllow,
        allowNewLong,
        hasSameSidePosition: hasSameSidePositionForNativeUpper,
        hasOppositeSidePosition: hasOppositeSidePositionForNativeUpper,
        paperExecutionReady,
        signedExecutionReady,
        boxMid: boxMidForFtsUpper,
        lastPrice: Number(authoritativeInput.snapshot.lastPrice ?? 0)
    });
    const nativeExecutorUpperBreakoutConfirmed =
        nativeExecutorEnterAuthority === true &&
        nativeExecutorFastProbeCoverage === true &&
        v2SideBeforePromotion === "long" &&
        isRangeRouting &&
        zone === "upper" &&
        (nativeUpperBreakoutContinuationEval.confirmed === true ||
            nativeFastTrendShiftUpperLongEval.confirmed === true);
    const nativeExecutorUpperBreakoutConfirmationSource =
        nativeExecutorUpperBreakoutConfirmed
            ? nativeFastTrendShiftUpperLongEval.confirmed
                ? "evaluateFastTrendShiftUpperLongZoneConfirmed"
                : "evaluateUpperBreakoutLongConfirmed"
            : nativeFastTrendShiftUpperLongEval.holdReason ??
              nativeUpperBreakoutContinuationEval.holdReason ??
              null;
    const rangeUpperLongMismatchBeforeExemption =
        isRangeRouting &&
        !rangeZoneVetoExempt &&
        !isTrendAuthorityCandidate &&
        !isConflictResolvedTrendLongPromotion &&
        sideCandidateBeforeVeto === "long" &&
        (rangeUpperLongMismatchByReason || (boxPos ?? 0.5) >= rangeUpperThreshold);
    const rangeUpperLongMismatch =
        rangeUpperLongMismatchBeforeExemption && !nativeExecutorUpperBreakoutConfirmed;
    // PROBE_ONLY + polarityProbeEligible exemption: an executor ENTER under HTF PROBE_ONLY
    // with confirmed polarity probe eligibility must not be blocked by a range signal downgrade.
    // The HTF probe authority already accounts for the reduced sizing (htf_size_multiplier).
    const probeOnlyPolarityEligibleEnter =
        v2DecisionBeforePromotion === "ENTER" &&
        judgment.htf_entry_policy === "PROBE_ONLY" &&
        judgment.polarityProbeEligible === true;
    const rangeDowngradedHardBlock =
        rangeSignalDowngraded &&
        !rangeSignalKeptByRelax &&
        !probeOnlyPolarityEligibleEnter &&
        !nativeExecutorEnterAuthority;
    const entryCandidateHardBlock =
        !entryCandidate && !promotionApplied && !nativeExecutorEnterAuthority;
    const trendPromotionHardBlock = activeEngineRouting === "TREND" && trendOk !== true && sideCandidateBeforeVeto !== "none";
    const rangeMidConservativeBlock =
        rangeContextActive &&
        zone === "mid" &&
        sideCandidateBeforeVeto !== "none" &&
        !reversalConfirmed &&
        !relaxedRangeEntry &&
        !rangeEdgeExtreme &&
        !shockRecoveryHint &&
        !rangeZoneVetoExempt &&
        !isTrendAuthorityCandidate &&
        !nativeExecutorFastProbeCoverage;

    if (v2DecisionAfterPromotion === "ENTER") {
        if (rangeLowerShortMismatch && !execMeta.sideOverrideApplied) {
            vetoReason = "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT";
        } else if (rangeUpperLongMismatch && !execMeta.sideOverrideApplied) {
            vetoReason = "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG";
        } else if (rangeDowngradedHardBlock) {
            vetoReason = "RANGE_SIGNAL_DOWNGRADED_NOT_RELAXED";
        } else if (entryCandidateHardBlock) {
            vetoReason = "ENTRY_CANDIDATE_FALSE_VETO";
        } else if (trendPromotionHardBlock) {
            vetoReason = "TREND_PROMOTION_BLOCKED_TREND_NOT_OK";
        } else if (rangeMidConservativeBlock && !execMeta.sideOverrideApplied) {
            vetoReason = "RANGE_MID_CONSERVATIVE_VETO";
        }
    }

    console.info(JSON.stringify({
        event: "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF",
        symbol: String(input.symbol),
        market_subtype: judgment.subtype,
        native_executor_enter_authority: nativeExecutorEnterAuthority,
        native_executor_decision_source: nativeExecutorDecisionSource,
        native_executor_side_source: nativeExecutorSideSource,
        promotion_applied_at_native_authority_eval: promotionAppliedAtNativeAuthorityEval,
        promotion_reason_at_native_authority_eval: promotionReason,
        side_after_promotion_at_native_authority_eval: v2SideAfterPromotion,
        range_signal_downgraded: rangeSignalDowngraded,
        entry_candidate: entryCandidate,
        range_downgraded_hard_block: rangeDowngradedHardBlock,
        entry_candidate_hard_block: entryCandidateHardBlock,
        native_fast_probe_coverage: nativeExecutorFastProbeCoverage,
        native_executor_upper_breakout_confirmed: nativeExecutorUpperBreakoutConfirmed,
        native_executor_upper_breakout_confirmation_source: nativeExecutorUpperBreakoutConfirmationSource,
        native_fast_trend_shift_upper_long_confirmed: nativeFastTrendShiftUpperLongEval.confirmed,
        native_fast_trend_shift_upper_long_hold_reason: nativeFastTrendShiftUpperLongEval.holdReason,
        native_fts_lower_short_zone_veto_deferred: nativeFtsLowerShortDeferZoneVeto,
        native_fts_lower_short_defer_reason: nativeFtsLowerShortDeferZoneVeto
            ? "FAST_TREND_SHIFT_LOWER_SHORT_TIER55_DEFERRAL"
            : null,
        range_lower_short_mismatch_before_deferral: rangeLowerShortMismatchBeforeExemption,
        range_lower_short_mismatch_after_deferral: rangeLowerShortMismatch,
        range_upper_long_mismatch_before_exemption: rangeUpperLongMismatchBeforeExemption,
        range_upper_long_mismatch_after_exemption: rangeUpperLongMismatch,
        range_mid_conservative_block: rangeMidConservativeBlock,
        veto_reason_pre_apply: vetoReason,
        veto_mutation_stage: "pre_veto_apply"
    }));

    const isBypassRangeVeto =
        vetoReason != null &&
        shock === "DOWN" &&
        (judgment.htf_entry_policy === "SHORT_ONLY_OR_NONE" || judgment.htf_entry_policy === "SHORT_ONLY") &&
        (shockReactionAllowedPrimarySide === "short" || riskShortAllow === true) &&
        shockReactionPromotionType === "lower_breakdown_continuation_short" &&
        promotionApplied === true &&
        finalDecisionBeforeVeto === "ENTER" &&
        (sideCandidateBeforeVeto === "short" || v2SideAfterPromotion === "short") &&
        hardBlockPresent === false;

    const isBypassRangeUpperShort =
        vetoReason != null &&
        shock === "DOWN" &&
        (judgment.htf_entry_policy === "SHORT_ONLY_OR_NONE" || judgment.htf_entry_policy === "SHORT_ONLY") &&
        (riskShortAllow === true || allowNewShort === true) &&
        zone === "upper" &&
        (v2SideAfterPromotion === "short" || rangeSideCandidate === "short" || sideCandidateBeforeVeto === "short") &&
        trendSideCandidate === "short" &&
        sideZoneValid === true &&
        hardBlockPresent === false &&
        qualityScore >= 65 &&
        (entryQualityGrade === "S" || entryQualityGrade === "A" || entryQualityGrade === "B");

    const isBypassWhipsawSoftWatchDownMidShortRetest =
        vetoReason != null &&
        judgment.subtype === "WHIPSAW_SOFT_WATCH" &&
        shock === "DOWN" &&
        zone === "mid" &&
        (sideCandidateBeforeVeto === "short" || v2SideAfterPromotion === "short") &&
        hardBlockPresent === false;

    if (vetoReason != null) {
        if (isBypassRangeVeto) {
            v2DecisionAfterPromotion = finalDecisionBeforeVeto; // "ENTER"
            v2SideAfterPromotion = "short";
            v2RejectReasonAfterPromotion = null;

            // stopPrice: prefer verified FTS canonical structural authority when present in-cycle
            const entryPrice = Number(authoritativeInput.snapshot.lastPrice ?? 0);
            const atrVal = Number(authoritativeInput.snapshot.atr ?? 0);
            const closedCandlesForBypass = getClosedCandlesForStructuralStop(
                authoritativeInput.snapshot.candles || []
            );
            const boxHighVal = Number(authoritativeInput.snapshot.boxHigh ?? 0);
            const boxLowVal = Number(authoritativeInput.snapshot.boxLow ?? 0);
            const boxMidVal = boxHighVal > 0 && boxLowVal > 0 ? (boxHighVal + boxLowVal) / 2 : 0;

            const ftsInherited = tryInheritFastTrendShiftStructuralStopFromDiag({
                side: "short",
                entryPrice,
                fastTrendShiftDiag: judgment.diagnostics?.fastTrendShift ?? null,
                resolverCrossCheck:
                    closedCandlesForBypass.length > 0 && atrVal > 0
                        ? {
                              lastPrice: entryPrice,
                              atr: atrVal,
                              closedCandles: closedCandlesForBypass,
                              boxMid: boxMidVal > 0 ? boxMidVal : null,
                              previousConfirmedBoxHigh: boxHighVal > 0 ? boxHighVal : null,
                              previousConfirmedBoxLow: boxLowVal > 0 ? boxLowVal : null
                          }
                        : null
            });

            let calculatedStopPrice: number;
            let stopBasisLabel: string;

            if (ftsInherited != null) {
                calculatedStopPrice = ftsInherited.stopPrice;
                stopBasisLabel = FTS_STRUCTURAL_STOP_BASIS;
                execution.metadata = {
                    ...execution.metadata,
                    ...buildFtsStructuralStopExecMetadata(ftsInherited),
                    shock_reaction_stop_inheritance: "fast_trend_shift_structural"
                };
            } else {
                const candles = authoritativeInput.snapshot.candles;
                let swingHighVal = 0;
                if (Array.isArray(candles) && candles.length > 0) {
                    const recentHighs = candles.slice(-20).map(c => Number(c.high ?? (c as any).h ?? 0));
                    swingHighVal = Math.max(...recentHighs);
                }

                const minStopDist = Math.max(atrVal * 0.5, entryPrice * 0.0015);
                const atrStopCandidate = entryPrice + Math.max(atrVal * 1.5, entryPrice * 0.005);

                const candidates = [
                    swingHighVal,
                    boxHighVal,
                    boxMidVal,
                    atrStopCandidate
                ].filter(v => Number.isFinite(v) && v > entryPrice + minStopDist);

                calculatedStopPrice = candidates.length > 0 ? Math.max(...candidates) : (entryPrice + minStopDist);
                if (!Number.isFinite(calculatedStopPrice) || calculatedStopPrice <= entryPrice) {
                    calculatedStopPrice = entryPrice + minStopDist;
                }
                stopBasisLabel =
                    calculatedStopPrice === swingHighVal ? "swingHigh" :
                    calculatedStopPrice === boxHighVal ? "boxHigh" :
                    calculatedStopPrice === boxMidVal ? "boxMid" :
                    calculatedStopPrice === atrStopCandidate ? "atrBuffer" : "fallback";
            }

            execution.stopPrice = calculatedStopPrice;
            execution.invalidationPx = calculatedStopPrice;

            console.info(JSON.stringify({
                event: "V2_RANGE_SIDE_ZONE_VETO_BYPASS_PROOF",
                symbol: String(input.symbol),
                regime: marketMode,
                market_subtype: judgment.subtype,
                directional_shock_state: shock,
                htf_policy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
                rangeZone: zone,
                promotion_type: shockReactionPromotionType,
                promotion_reason: promotionReason,
                selected_side_before_veto: sideCandidateBeforeVeto,
                selected_side_after_veto: v2SideAfterPromotion,
                finalDecisionBeforeVeto,
                finalDecisionAfterVeto: v2DecisionAfterPromotion,
                bypass_reason: "SHOCK_REACTION_PROMOTION_BYPASS_RANGE_SIDE_VETO",
                hard_block_present: hardBlockPresent,
                hard_block_reason: hardBlockReason
            }));

            console.info(JSON.stringify({
                event: "V2_SHOCK_REACTION_RISK_PLAN_PROOF",
                symbol: String(input.symbol),
                side: "short",
                entryPrice,
                stopPrice: calculatedStopPrice,
                stopBasis: stopBasisLabel,
                fts_structural_inherited: ftsInherited != null,
                atr: atrVal,
                riskDistance: calculatedStopPrice - entryPrice,
                validStop: calculatedStopPrice > entryPrice,
                reason: ftsInherited != null
                    ? "shock_reaction_fts_structural_stop_inherited"
                    : "shock_reaction_continuation_short_stop_plan"
            }));
        } else if (isBypassRangeUpperShort) {
            v2DecisionAfterPromotion = finalDecisionBeforeVeto; // "ENTER"
            v2SideAfterPromotion = "short";
            v2RejectReasonAfterPromotion = null;

            // stopPrice 보수적 계산
            const entryPrice = Number(authoritativeInput.snapshot.lastPrice ?? 0);
            const atrVal = Number(authoritativeInput.snapshot.atr ?? 0);
            
            const candles = authoritativeInput.snapshot.candles;
            let swingHighVal = 0;
            if (Array.isArray(candles) && candles.length > 0) {
                const recentHighs = candles.slice(-20).map(c => Number(c.high ?? (c as any).h ?? 0));
                swingHighVal = Math.max(...recentHighs);
            }

            const boxHighVal = Number(authoritativeInput.snapshot.boxHigh ?? 0);
            const boxLowVal = Number(authoritativeInput.snapshot.boxLow ?? 0);
            const boxMidVal = boxHighVal > 0 && boxLowVal > 0 ? (boxHighVal + boxLowVal) / 2 : 0;
            
            const minStopDist = Math.max(atrVal * 0.5, entryPrice * 0.0015);
            const atrStopCandidate = entryPrice + Math.max(atrVal * 1.5, entryPrice * 0.005);
            
            const candidates = [
                swingHighVal,
                boxHighVal,
                boxMidVal,
                atrStopCandidate
            ].filter(v => Number.isFinite(v) && v > entryPrice + minStopDist);
            
            let calculatedStopPrice = candidates.length > 0 ? Math.max(...candidates) : (entryPrice + minStopDist);
            if (!Number.isFinite(calculatedStopPrice) || calculatedStopPrice <= entryPrice) {
                calculatedStopPrice = entryPrice + minStopDist;
            }

            execution.stopPrice = calculatedStopPrice;
            execution.invalidationPx = calculatedStopPrice;
            
            const riskDistance = calculatedStopPrice - entryPrice;
            const validStop = calculatedStopPrice > entryPrice;

            console.info(JSON.stringify({
                event: "V2_RANGE_UPPER_SHORT_BYPASS_PROOF",
                symbol: String(input.symbol),
                rangeZone: zone,
                selected_side_before_veto: sideCandidateBeforeVeto,
                selected_side_after_veto: v2SideAfterPromotion,
                range_side_candidate: rangeSideCandidate,
                trend_side_candidate: trendSideCandidate,
                side_zone_valid: sideZoneValid,
                quality_score: qualityScore,
                entry_quality_grade: entryQualityGrade,
                htf_entry_policy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
                directional_shock_state: shock,
                finalDecisionBeforeVeto,
                finalDecisionAfterVeto: v2DecisionAfterPromotion,
                bypass_reason: "RANGE_UPPER_SHORT_HTF_ALIGNED_BYPASS"
            }));

            console.info(JSON.stringify({
                event: "V2_RANGE_UPPER_SHORT_RISK_PLAN_PROOF",
                symbol: String(input.symbol),
                side: "short",
                entryPrice,
                stopPrice: calculatedStopPrice,
                stopBasis: calculatedStopPrice === swingHighVal ? "swingHigh" :
                           calculatedStopPrice === boxHighVal ? "boxHigh" :
                           calculatedStopPrice === boxMidVal ? "boxMid" :
                           calculatedStopPrice === atrStopCandidate ? "atrBuffer" : "fallback",
                atr: atrVal,
                swingHigh: swingHighVal,
                boxHigh: boxHighVal,
                riskDistance,
                validStop,
                reason: "range_upper_short_stop_plan"
            }));
        } else if (isBypassWhipsawSoftWatchDownMidShortRetest) {
            v2DecisionAfterPromotion = finalDecisionBeforeVeto; // "ENTER"
            v2SideAfterPromotion = "short";
            v2RejectReasonAfterPromotion = null;

            const stopPriceVal = execution.stopPrice;
            if (stopPriceVal == null || isNaN(stopPriceVal)) {
                v2DecisionAfterPromotion = "SKIP";
                v2SideAfterPromotion = "none";
                v2RejectReasonAfterPromotion = "STOP_PRICE_NULL_HOLD";
            } else {
                execution.stopPrice = stopPriceVal;
                execution.invalidationPx = stopPriceVal;
                v2CalculatedInvalidationPx = stopPriceVal;
            }

            console.info(JSON.stringify({
                event: "V2_WHIPSAW_SOFT_WATCH_DOWN_MID_SHORT_RETEST_BYPASS_PROOF",
                symbol: String(input.symbol),
                rangeZone: zone,
                selected_side_before_veto: sideCandidateBeforeVeto,
                selected_side_after_veto: v2SideAfterPromotion,
                range_side_candidate: rangeSideCandidate,
                trend_side_candidate: trendSideCandidate,
                side_zone_valid: sideZoneValid,
                quality_score: qualityScore,
                entry_quality_grade: entryQualityGrade,
                htf_entry_policy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
                directional_shock_state: shock,
                finalDecisionBeforeVeto,
                finalDecisionAfterVeto: v2DecisionAfterPromotion,
                stopPrice: stopPriceVal,
                bypass_reason: "WHIPSAW_SOFT_WATCH_DOWN_MID_SHORT_RETEST_BYPASS"
            }));
        } else {
            v2DecisionAfterPromotion = "SKIP";
            v2SideAfterPromotion = "none";
            v2RejectReasonAfterPromotion = vetoReason;
            promotionApplied = false;
            promotionReason = null;
            console.info(JSON.stringify({
                event: "V2_RANGE_SIDE_ZONE_VETO_PROOF",
                symbol: String(input.symbol),
                regime: marketMode,
                boxPos,
                rangeZone: zone,
                sideCandidate: sideCandidateBeforeVeto,
                signalGateBlockedReason,
                rangeSignalDowngraded,
                rangeSignalKeptByRelax,
                entryCandidate,
                trendOk,
                long_allow: allowNewLong,
                short_allow: allowNewShort,
                finalDecisionBeforeVeto,
                finalDecisionAfterVeto: v2DecisionAfterPromotion,
                vetoReason,
                veto_mutation_stage: "post_veto_apply",
                native_executor_enter_authority: nativeExecutorEnterAuthority,
                promotion_applied_at_native_authority_eval: promotionAppliedAtNativeAuthorityEval
            }));
        }
    }

    // Tier 5+: Selected Side Consistency Log
    console.info(JSON.stringify({
        event: "V2_SELECTED_SIDE_CONSISTENCY_PROOF",
        symbol: String(input.symbol),
        active_engine_routing: activeEngineRouting,
        v2_router_executor: activeEngineRouting,
        market_subtype: judgment.subtype,
        range_zone: zone,
        range_side_candidate: rangeSideCandidate,
        trend_side_candidate: trendSideCandidate,
        aligned_signal: alignedSignal,
        selected_side_before_veto: sideCandidateBeforeVetoEnforced,
        selected_side_after_veto: v2SideAfterPromotion,
        side_zone_valid: sideZoneValid,
        entryCandidate: entryCandidate,
        vetoReason: vetoReason,
        finalDecisionBeforeVeto: finalDecisionBeforeVeto,
        finalDecisionAfterVeto: v2DecisionAfterPromotion
    }));

    console.info(JSON.stringify({
        event: "V2_ENTRY_CANDIDATE_PROMOTION_PROOF",
        symbol: String(input.symbol),
        judgment_regime: judgment.regime,
        judgment_subtype: judgment.subtype,
        range_phase: judgment.rangePhase,
        range_side_candidate: rangeSideCandidate,
        trend_side_candidate: trendSideCandidate,
        selected_side_before_veto: sideCandidateBeforeVetoEnforced,
        selected_side_after_veto: v2SideAfterPromotion,
        promotion_applied: promotionApplied,
        promotion_reason: promotionReason,
        final_decision: v2DecisionAfterPromotion,
        side_override_applied: !!execMeta.sideOverrideApplied
    }));

    // Side Veto Detail Calculation (Diagnostic)
    const rangeTrendConflict =
        rangeSideCandidate && trendSideCandidate &&
        rangeSideCandidate !== "none" && trendSideCandidate !== "none" &&
        rangeSideCandidate !== trendSideCandidate;

    let sideVetoDetail: string | null = null;
    if (isBypassRangeVeto) {
        sideVetoDetail = "SHOCK_REACTION_PROMOTION_BYPASS_RANGE_SIDE_VETO";
    } else if (isBypassRangeUpperShort) {
        sideVetoDetail = "RANGE_UPPER_SHORT_HTF_ALIGNED_BYPASS";
    } else if (promotionReason === "V2_RANGE_TREND_RECLAIM_MICRO_PROBE") {
        sideVetoDetail = "RANGE_TREND_RECLAIM_PROBE_APPLIED";
    } else if (judgment.subtype === "WHIPSAW_SHOCK_RECHECK") {
        sideVetoDetail = "WHIPSAW_SHOCK_RECHECK_ACTIVE";
    } else if (v2SideAfterPromotion === "none" || v2DecisionAfterPromotion === "HOLD" || v2DecisionAfterPromotion === "SKIP") {
        if (judgment.subtype === "SHOCK_REACTION_UP" && trendSideCandidate === "long") {
            if (zone === "mid") sideVetoDetail = "SHOCK_UP_MID_RETEST_REQUIRED";
            else if (trendOk === false) sideVetoDetail = "SHOCK_UP_TREND_CONFIRMATION_WEAK";
            else if (reversalConfirmed === false) sideVetoDetail = "SHOCK_UP_RECLAIM_NOT_CONFIRMED";
        } else if (judgment.subtype === "SHOCK_REACTION_DOWN" && trendSideCandidate === "short") {
            if (zone === "mid") sideVetoDetail = "SHOCK_DOWN_MID_RETEST_REQUIRED";
            else if (trendOk === false) sideVetoDetail = "SHOCK_DOWN_TREND_CONFIRMATION_WEAK";
            else if (reversalConfirmed === false) sideVetoDetail = "SHOCK_DOWN_BREAKDOWN_RETEST_NOT_CONFIRMED";
        } else if (rangeTrendConflict) {
            sideVetoDetail = "RANGE_TREND_SIDE_CONFLICT";
        } else if ((!rangeSideCandidate || rangeSideCandidate === "none") && trendSideCandidate && trendSideCandidate !== "none" && promotionApplied === false) {
            sideVetoDetail = promotionBlockReason || "TREND_PROMOTION_VETOED";
        }
    }

    // Polarity Check V2: Strict suppression for HTF mismatch with dedicated reversal micro-probe exception
    if (judgment.polarityMismatch) {
        const macroPol = judgment.macroPolarity;
        const candidateSide = trendSideCandidate !== "none" ? trendSideCandidate : v2SideAfterPromotion;

        const isAuthoritativeTrend =
            judgment.regime === "TREND" &&
            judgment.regime_final === "TREND" &&
            authoritativeInput.snapshot.canonicalRegime === "TREND" &&
            activeEngineRouting === "TREND";

        const htf5m = (judgment.htf_bias?.m5 && judgment.htf_bias.m5 !== "DATA_NOT_READY") ? judgment.htf_bias.m5 : (judgment.m5_bias_actual ?? judgment.htf_bias?.m5 ?? "DATA_NOT_READY");
        const htf15m = (judgment.htf_bias?.m15 && judgment.htf_bias.m15 !== "DATA_NOT_READY") ? judgment.htf_bias.m15 : (judgment.m15_bias_actual ?? judgment.htf_bias?.m15 ?? "DATA_NOT_READY");
        const entryPx = Number(authoritativeInput.snapshot.lastPrice ?? 0);
        const emaGapVal = Number(authoritativeInput.snapshot.emaGap ?? 0);
        const currentShock = v2State.directionalShockState ?? (judgment.shockPhase === "DOWN_SHOCK" ? "DOWN" : judgment.shockPhase === "UP_SHOCK" ? "UP" : "NONE");

        const hasSameSidePos = v2State.currentPositions.some(p => p && p.symbol === input.symbol && String(p.side).toLowerCase() === candidateSide);
        const hasOppositeSidePos = v2State.currentPositions.some(p => p && p.symbol === input.symbol && String(p.side).toLowerCase() !== candidateSide);

        const stopPx = execution.stopPrice;
        const invPx = execution.invalidationPx ?? stopPx;

        const isShortProbeHtfValid = (bias: string | null | undefined): boolean =>
            bias === "BEARISH" || bias === "RANGE" || bias === "CONFLICT";

        const isLongProbeHtfValid = (bias: string | null | undefined): boolean =>
            bias === "BULLISH" || bias === "RANGE" || bias === "CONFLICT";

        const isShortReversalMicroProbeEligible =
            v2DecisionBeforePromotion === "ENTER" &&
            v2SideBeforePromotion === candidateSide &&
            macroPol === "BULLISH" &&
            candidateSide === "short" &&
            isAuthoritativeTrend &&
            currentShock === "DOWN" &&
            trendSideCandidate === "short" &&
            trendOk === true &&
            qualityScore >= 70 &&
            emaGapVal <= -0.002 &&
            isShortProbeHtfValid(htf5m) &&
            isShortProbeHtfValid(htf15m) &&
            riskShortAllow === true &&
            allowNewShort === true &&
            hardBlockPresent === false &&
            hardControlClear === true &&
            !whipsawShockRecheckActive &&
            judgment.subtype !== "WHIPSAW_SHOCK_RECHECK" &&
            paperExecutionReady === true &&
            signedExecutionReady === true &&
            !hasSameSidePos &&
            !hasOppositeSidePos &&
            (riskSizing.diagnostics as any)?.contamination_hard_reject !== true &&
            (riskSizing as any)?.isContaminated !== true &&
            stopPx != null && invPx != null &&
            !isNaN(stopPx) && !isNaN(invPx) &&
            stopPx > entryPx && invPx > entryPx &&
            entryPx > 0;

        const isLongReversalMicroProbeEligible =
            v2DecisionBeforePromotion === "ENTER" &&
            v2SideBeforePromotion === candidateSide &&
            macroPol === "BEARISH" &&
            candidateSide === "long" &&
            isAuthoritativeTrend &&
            currentShock === "UP" &&
            trendSideCandidate === "long" &&
            trendOk === true &&
            qualityScore >= 70 &&
            emaGapVal >= 0.002 &&
            isLongProbeHtfValid(htf5m) &&
            isLongProbeHtfValid(htf15m) &&
            riskLongAllow === true &&
            allowNewLong === true &&
            hardBlockPresent === false &&
            hardControlClear === true &&
            !whipsawShockRecheckActive &&
            judgment.subtype !== "WHIPSAW_SHOCK_RECHECK" &&
            paperExecutionReady === true &&
            signedExecutionReady === true &&
            !hasSameSidePos &&
            !hasOppositeSidePos &&
            (riskSizing.diagnostics as any)?.contamination_hard_reject !== true &&
            (riskSizing as any)?.isContaminated !== true &&
            stopPx != null && invPx != null &&
            !isNaN(stopPx) && !isNaN(invPx) &&
            stopPx < entryPx && invPx < entryPx &&
            entryPx > 0;

        if (isShortReversalMicroProbeEligible) {
            v2DecisionAfterPromotion = "ENTER";
            v2SideAfterPromotion = "short";
            v2RejectReasonAfterPromotion = null;
            promotionApplied = true;
            promotionReason = "V2_POLARITY_REVERSAL_MICRO_PROBE";
            promotionBlockReason = null;
            promotionMinConditionPassed = true;
            execMeta.entryReason = "V2_POLARITY_REVERSAL_MICRO_PROBE";
            execMeta.entry_reason = "V2_POLARITY_REVERSAL_MICRO_PROBE";
            execMeta.polarity_reversal_micro_probe = true;
            v2CalculatedInvalidationPx = invPx;
            execution.stopPrice = stopPx;
            execution.invalidationPx = invPx;

            console.info(JSON.stringify({
                event: "V2_POLARITY_REVERSAL_MICRO_PROBE_PROOF",
                symbol: String(input.symbol),
                direction: "DOWN",
                side: "short",
                entryPx,
                stopPx,
                invPx,
                qualityScore,
                macroPolarity: macroPol,
                directionalShock: currentShock,
                emaGap: emaGapVal,
                htf5m,
                htf15m,
                decision: "ENTER",
                promotion_reason: promotionReason
            }));
        } else if (isLongReversalMicroProbeEligible) {
            v2DecisionAfterPromotion = "ENTER";
            v2SideAfterPromotion = "long";
            v2RejectReasonAfterPromotion = null;
            promotionApplied = true;
            promotionReason = "V2_POLARITY_REVERSAL_MICRO_PROBE";
            promotionBlockReason = null;
            promotionMinConditionPassed = true;
            execMeta.entryReason = "V2_POLARITY_REVERSAL_MICRO_PROBE";
            execMeta.entry_reason = "V2_POLARITY_REVERSAL_MICRO_PROBE";
            execMeta.polarity_reversal_micro_probe = true;
            v2CalculatedInvalidationPx = invPx;
            execution.stopPrice = stopPx;
            execution.invalidationPx = invPx;

            console.info(JSON.stringify({
                event: "V2_POLARITY_REVERSAL_MICRO_PROBE_PROOF",
                symbol: String(input.symbol),
                direction: "UP",
                side: "long",
                entryPx,
                stopPx,
                invPx,
                qualityScore,
                macroPolarity: macroPol,
                directionalShock: currentShock,
                emaGap: emaGapVal,
                htf5m,
                htf15m,
                decision: "ENTER",
                promotion_reason: promotionReason
            }));
        } else if (v2DecisionAfterPromotion === "ENTER" || promotionApplied) {
            const detectorPolarityProbePreserved =
                judgment.polarityProbeEligible === true &&
                judgment.htf_entry_policy === "PROBE_ONLY" &&
                macroPol === "BULLISH" &&
                candidateSide === "short" &&
                !whipsawShockRecheckActive &&
                judgment.subtype !== "WHIPSAW_SHOCK_RECHECK";
            if (!detectorPolarityProbePreserved) {
                if (macroPol === "BULLISH" && candidateSide === "short") {
                    v2DecisionAfterPromotion = "HOLD";
                    v2SideAfterPromotion = "none";
                    v2RejectReasonAfterPromotion = "HTF_POLICY_POLARITY_MISMATCH";
                    promotionApplied = false;
                    promotionBlockReason = "HTF_POLICY_POLARITY_MISMATCH";
                    expectedMissingCondition = "HTF_POLICY_POLARITY_MISMATCH";
                    expectedNextAction = "WAIT_FOR_MACRO_ALIGNMENT_OR_STABILIZATION";
                } else if (macroPol === "BEARISH" && candidateSide === "long") {
                    v2DecisionAfterPromotion = "HOLD";
                    v2SideAfterPromotion = "none";
                    v2RejectReasonAfterPromotion = "HTF_POLICY_POLARITY_MISMATCH";
                    promotionApplied = false;
                    promotionBlockReason = "HTF_POLICY_POLARITY_MISMATCH";
                    expectedMissingCondition = "HTF_POLICY_POLARITY_MISMATCH";
                    expectedNextAction = "WAIT_FOR_MACRO_ALIGNMENT_OR_STABILIZATION";
                }
            }
        }
    }

    // Strong HTF stack counter-trend RANGE entries require explicit reversal / failure evidence.
    if (v2DecisionAfterPromotion === "ENTER" && judgment.regime_final === "RANGE") {
        const sideFinal = v2SideAfterPromotion;
        const htfBiases = [
            String((judgment as { htf_1h_bias?: string }).htf_1h_bias ?? "").toUpperCase(),
            String((judgment as { htf_4h_bias?: string }).htf_4h_bias ?? "").toUpperCase(),
            String((judgment as { htf_1d_bias?: string }).htf_1d_bias ?? "").toUpperCase()
        ];
        const bullishHtfCount = htfBiases.filter((b) => b === "BULLISH").length;
        const bearishHtfCount = htfBiases.filter((b) => b === "BEARISH").length;
        const failedBreakoutReclaim =
            judgment.metadata?.failed_breakdown_reclaim === true ||
            judgment.metadata?.failed_breakout_reclaim === true ||
            judgment.metadata?.breakdown_retest_failed === true ||
            judgment.subtype === "BREAKDOWN_RETEST_FAILED";
        const upperFailureShortEvidence =
            sideFinal === "short" &&
            zone === "upper" &&
            (reversalConfirmed === true ||
                judgment.subtype === "BREAKDOWN_RETEST_FAILED" ||
                judgment.metadata?.retestRejected === true ||
                judgment.metadata?.box_upper_breakout_hold === false ||
                judgment.metadata?.upper_failure_short === true ||
                shockReactionPromotionType === "upper_failure_short" ||
                shockReactionPromotionType === "upper_reversal_confirmed_short");
        const lowerReversalLongEvidence =
            sideFinal === "long" &&
            zone === "lower" &&
            (reversalConfirmed === true ||
                judgment.metadata?.reclaimConfirmed === true ||
                judgment.metadata?.reclaim_confirmed === true ||
                judgment.metadata?.box_lower_breakdown_hold === false ||
                judgment.metadata?.lower_reversal_confirmed === true ||
                shockReactionPromotionType === "lower_reversal_confirmed_long");
        const hasExplicitReversalEvidence =
            sideFinal === "short" ? upperFailureShortEvidence : sideFinal === "long" ? lowerReversalLongEvidence : false;

        if (
            sideFinal === "short" &&
            zone === "upper" &&
            bullishHtfCount >= 2 &&
            !hasExplicitReversalEvidence
        ) {
            v2DecisionAfterPromotion = "HOLD";
            v2SideAfterPromotion = "none";
            v2RejectReasonAfterPromotion = "HTF_COUNTER_TREND_RANGE_NO_REVERSAL";
            promotionApplied = false;
            promotionBlockReason = "HTF_COUNTER_TREND_RANGE_NO_REVERSAL";
            expectedMissingCondition = "HTF_COUNTER_TREND_RANGE_NO_REVERSAL";
            expectedNextAction = "WAIT_FOR_CONFIRMED_REVERSAL_OR_FAILED_BREAKOUT";
        } else if (
            sideFinal === "long" &&
            zone === "lower" &&
            bearishHtfCount >= 2 &&
            !hasExplicitReversalEvidence
        ) {
            v2DecisionAfterPromotion = "HOLD";
            v2SideAfterPromotion = "none";
            v2RejectReasonAfterPromotion = "HTF_COUNTER_TREND_RANGE_NO_REVERSAL";
            promotionApplied = false;
            promotionBlockReason = "HTF_COUNTER_TREND_RANGE_NO_REVERSAL";
            expectedMissingCondition = "HTF_COUNTER_TREND_RANGE_NO_REVERSAL";
            expectedNextAction = "WAIT_FOR_CONFIRMED_REVERSAL_OR_FAILED_BREAKOUT";
        }
    }

    // Tier 5.5: Side-Zone Mismatch Hard Guard (V2 Hard Protection)
    if (v2DecisionAfterPromotion === "ENTER") {
        const sideFinal = v2SideAfterPromotion;
        const htfPol = judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT";
        const htfHardBlockReason = judgment.htf_hard_block_reason ?? "";

        const boxBreakSideFinal =
            typeof authoritativeInput.snapshot?.boxBreakSide === "string"
                ? String(authoritativeInput.snapshot.boxBreakSide)
                : "none";

        const isShockReactionDown = judgment.subtype === "SHOCK_REACTION_DOWN" || judgment.shockPhase === "DOWN_SHOCK";
        const isShockReactionUp = judgment.subtype === "SHOCK_REACTION_UP" || judgment.shockPhase === "UP_SHOCK";

        const breakdownRetestFailure =
            judgment.subtype === "BREAKDOWN_RETEST_FAILED" ||
            judgment.metadata?.breakdownRetestFailure === true ||
            judgment.metadata?.breakdown_retest_failure === true ||
            (judgment.metadata?.retestRejected === true && judgment.metadata?.retestConfirmed === true && sideFinal === "short");

        const breakoutRetestConfirmation =
            judgment.subtype === "BREAKOUT_RETEST_CONFIRMED" ||
            judgment.subtype === "BREAKOUT_RETEST_CONFIRMED_VOLUME" ||
            judgment.metadata?.breakoutRetestConfirmed === true ||
            judgment.metadata?.breakout_retest_confirmed === true ||
            (judgment.metadata?.retestRejected === false && judgment.metadata?.retestConfirmed === true && sideFinal === "long");

        let mismatchReason: string | null = null;
        const isStairStepPromotion = promotionReason === "V2_STAIR_STEP_CONTINUATION_PROMOTION";
        const isTrendContinuationRevalidatedPromotion = promotionReason === "V2_TREND_CONTINUATION_REVALIDATED";
        const isPolarityReversalMicroProbePromotion = promotionReason === "V2_POLARITY_REVERSAL_MICRO_PROBE";
        const isConflictResolvedTrendLongPromotion = promotionReason === "V2_CONFLICT_RESOLVED_TREND_LONG";
        const isRangeTrendReclaimProbePromotion = promotionReason === "V2_RANGE_TREND_RECLAIM_MICRO_PROBE";
        if (sideFinal === "short" && zone === "lower") {
            const isFastTrendShiftLowerShort =
                judgment.subtype === "FAST_TREND_SHIFT" &&
                judgment.diagnostics?.fastTrendShift?.direction === "short";
            let fastTrendShiftLowerBreakdownConfirmed = false;
            if (isFastTrendShiftLowerShort) {
                const continuationStateTier55 = rangeContinuationStateMap.get(String(input.symbol));
                const judgmentMetaTier55 = (judgment.metadata ?? {}) as Record<string, unknown>;
                const execMetaTier55 = execMeta as Record<string, unknown>;
                const authSnapTier55 = authoritativeInput.snapshot as unknown as Record<string, unknown>;
                const inputSnapTier55 = input.snapshot as unknown as Record<string, unknown>;
                const hasSameSidePosTier55 = v2State.currentPositions.some(
                    (p) => p.symbol === input.symbol && String(p.side).toLowerCase() === "short"
                );
                const hasOppositeSidePosTier55 = v2State.currentPositions.some(
                    (p) => p.symbol === input.symbol && String(p.side).toLowerCase() === "long"
                );
                const tier55ClosedClose =
                    typeof authSnapTier55.closedClose === "number"
                        ? authSnapTier55.closedClose
                        : (typeof inputSnapTier55.closedClose === "number"
                            ? inputSnapTier55.closedClose
                            : null);
                const tier55BoxMidLower =
                    typeof authSnapTier55.boxHigh === "number" && typeof authSnapTier55.boxLow === "number"
                        ? (Number(authSnapTier55.boxHigh) + Number(authSnapTier55.boxLow)) / 2
                        : null;
                const lowerBreakdownEval = evaluateLowerBreakdownShortConfirmed({
                    trendSideCandidate: "short",
                    zone,
                    boxBreakSide,
                    boxLow: Number(authSnapTier55.boxLow ?? inputSnapTier55.boxLow ?? 0),
                    boxHigh: Number(authSnapTier55.boxHigh ?? inputSnapTier55.boxHigh ?? 0),
                    closedClose: tier55ClosedClose,
                    lastPrice: Number(authSnapTier55.lastPrice ?? inputSnapTier55.lastPrice ?? 0),
                    previousConfirmedBoxLow: continuationStateTier55?.previousConfirmedBoxLow ?? null,
                    previousConfirmedBoxHigh: continuationStateTier55?.previousConfirmedBoxHigh ?? null,
                    emaGap,
                    htfEntryPolicy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
                    htfRequiresStrongerConfirmation: judgment.htf_requires_stronger_confirmation === true,
                    counterTrendRisk: judgment.counter_trend_risk === true,
                    riskLongAllow,
                    riskShortAllow,
                    allowNewLong,
                    allowNewShort,
                    whipsawShockRecheckActive,
                    hardBlockPresent,
                    paperExecutionReady,
                    signedExecutionReady,
                    hasSameSidePosition: hasSameSidePosTier55,
                    hasOppositeSidePosition: hasOppositeSidePosTier55,
                    judgmentSubtype: String(judgment.subtype ?? ""),
                    rangePhase: judgment.rangePhase ?? null,
                    transitionPhase: judgment.transitionPhase ?? null,
                    continuationDirection:
                        typeof execMetaTier55.continuationDirection === "string"
                            ? String(execMetaTier55.continuationDirection)
                            : continuationStateTier55?.direction ?? null,
                    continuationPhase:
                        typeof execMetaTier55.continuationPhase === "string"
                            ? String(execMetaTier55.continuationPhase)
                            : continuationStateTier55?.phase ?? null,
                    retestConfirmed:
                        execMetaTier55.retest_confirmed === true ||
                        judgmentMetaTier55.retestConfirmed === true ||
                        authSnapTier55.retestConfirmed === true ||
                        inputSnapTier55.retestConfirmed === true,
                    retestTouched:
                        execMetaTier55.retestTouched === true ||
                        judgmentMetaTier55.retestTouched === true ||
                        authSnapTier55.retestTouched === true ||
                        inputSnapTier55.retestTouched === true,
                    retestRejected:
                        execMetaTier55.retestRejected === true ||
                        judgmentMetaTier55.retestRejected === true ||
                        authSnapTier55.retestRejected === true ||
                        inputSnapTier55.retestRejected === true,
                    reversalConfirmed,
                    execReason: typeof execution.reason === "string" ? execution.reason : null,
                    lateChaseBlocked: execMetaTier55.late_chase_blocked === true,
                    retestRequired: execMetaTier55.retest_required === true
                });
                const fastTrendShiftLowerStructuralConfirmed = evaluateFastTrendShiftLowerShortZoneConfirmed({
                    fastTrendShift: judgment.diagnostics?.fastTrendShift ?? null,
                    zone,
                    trendOk: trendOk === true,
                    qualityScore,
                    htfEntryPolicy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
                    htfRequiresStrongerConfirmation: judgment.htf_requires_stronger_confirmation === true,
                    counterTrendRisk: judgment.counter_trend_risk === true,
                    lateChaseBlocked: execMetaTier55.late_chase_blocked === true,
                    hardBlockPresent,
                    whipsawShockRecheckActive,
                    riskShortAllow,
                    allowNewShort,
                    hasSameSidePosition: hasSameSidePosTier55,
                    hasOppositeSidePosition: hasOppositeSidePosTier55,
                    paperExecutionReady,
                    signedExecutionReady,
                    boxMid: tier55BoxMidLower,
                    lastPrice: Number(authSnapTier55.lastPrice ?? inputSnapTier55.lastPrice ?? 0)
                }).confirmed;
                fastTrendShiftLowerBreakdownConfirmed =
                    fastTrendShiftLowerStructuralConfirmed || lowerBreakdownEval.confirmed;
            }
            const shockDownBlanketException = shock === "DOWN" && !isFastTrendShiftLowerShort;
            const shortException = isFastTrendShiftLowerShort
                ? fastTrendShiftLowerBreakdownConfirmed
                : (
                    breakdownRetestFailure ||
                    boxBreakSideFinal === "lower" ||
                    isShockReactionDown ||
                    shockDownBlanketException ||
                    (isTrendQualifiedFinalPromotion && sideFinal === trendSideCandidate) ||
                    (isStairStepPromotion && sideFinal === "short") ||
                    (isTrendContinuationRevalidatedPromotion && sideFinal === "short") ||
                    (isPolarityReversalMicroProbePromotion && sideFinal === "short") ||
                    (isConflictResolvedTrendShortPromotion && sideFinal === "short") ||
                    (isRangeTrendReclaimProbePromotion && sideFinal === "short")
                );
            const htfStrongBullish = htfHardBlockReason === "STRONG_BULLISH_HTF_ALIGNMENT";

            if (!shortException || (htfStrongBullish && !isPolarityReversalMicroProbePromotion && !isConflictResolvedTrendShortPromotion && !isRangeTrendReclaimProbePromotion)) {
                mismatchReason = "SIDE_ZONE_MISMATCH_LOWER_SHORT";
            }
        } else if (sideFinal === "long" && zone === "upper") {
            const isFastTrendShiftUpperLong =
                judgment.subtype === "FAST_TREND_SHIFT" &&
                judgment.diagnostics?.fastTrendShift?.direction === "long";
            let fastTrendShiftUpperLongConfirmed = false;
            if (isFastTrendShiftUpperLong) {
                const execMetaTier55Upper = execMeta as Record<string, unknown>;
                const authSnapTier55Upper = authoritativeInput.snapshot as unknown as Record<string, unknown>;
                const inputSnapTier55Upper = input.snapshot as unknown as Record<string, unknown>;
                const hasSameSidePosTier55Upper = v2State.currentPositions.some(
                    (p) => p.symbol === input.symbol && String(p.side).toLowerCase() === "long"
                );
                const hasOppositeSidePosTier55Upper = v2State.currentPositions.some(
                    (p) => p.symbol === input.symbol && String(p.side).toLowerCase() === "short"
                );
                const tier55BoxMidUpper =
                    typeof authSnapTier55Upper.boxHigh === "number" && typeof authSnapTier55Upper.boxLow === "number"
                        ? (Number(authSnapTier55Upper.boxHigh) + Number(authSnapTier55Upper.boxLow)) / 2
                        : null;
                fastTrendShiftUpperLongConfirmed = evaluateFastTrendShiftUpperLongZoneConfirmed({
                    fastTrendShift: judgment.diagnostics?.fastTrendShift ?? null,
                    zone,
                    trendOk: trendOk === true,
                    qualityScore,
                    htfEntryPolicy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
                    htfRequiresStrongerConfirmation: judgment.htf_requires_stronger_confirmation === true,
                    counterTrendRisk: judgment.counter_trend_risk === true,
                    lateChaseBlocked: execMetaTier55Upper.late_chase_blocked === true,
                    hardBlockPresent,
                    whipsawShockRecheckActive,
                    riskLongAllow,
                    allowNewLong,
                    hasSameSidePosition: hasSameSidePosTier55Upper,
                    hasOppositeSidePosition: hasOppositeSidePosTier55Upper,
                    paperExecutionReady,
                    signedExecutionReady,
                    boxMid: tier55BoxMidUpper,
                    lastPrice: Number(authSnapTier55Upper.lastPrice ?? inputSnapTier55Upper.lastPrice ?? 0)
                }).confirmed;
            }
            const longException =
                breakoutRetestConfirmation ||
                boxBreakSideFinal === "upper" ||
                isShockReactionUp ||
                shock === "UP" ||
                (isTrendQualifiedFinalPromotion && sideFinal === trendSideCandidate) ||
                (isStairStepPromotion && sideFinal === "long") ||
                (isTrendContinuationRevalidatedPromotion && sideFinal === "long") ||
                (isPolarityReversalMicroProbePromotion && sideFinal === "long") ||
                (isConflictResolvedTrendLongPromotion && sideFinal === "long") ||
                (isRangeTrendReclaimProbePromotion && sideFinal === "long") ||
                (isFastTrendShiftUpperLong && fastTrendShiftUpperLongConfirmed);
            const htfStrongBearish = htfHardBlockReason === "STRONG_BEARISH_HTF_ALIGNMENT";

            if (!longException || (htfStrongBearish && !isPolarityReversalMicroProbePromotion && !isConflictResolvedTrendLongPromotion && !isRangeTrendReclaimProbePromotion)) {
                mismatchReason = "SIDE_ZONE_MISMATCH_UPPER_LONG";
            }
        }

        if (mismatchReason != null) {
            const decisionBeforeMismatchBlock = v2DecisionAfterPromotion;
            v2DecisionAfterPromotion = "HOLD";
            v2SideAfterPromotion = "none";
            v2RejectReasonAfterPromotion = mismatchReason;
            promotionApplied = false;
            promotionReason = null;
            expectedMissingCondition = mismatchReason;
            expectedNextAction = sideFinal === "short"
                ? "WAIT_FOR_UPPER_REJECTION_OR_BREAKDOWN_RETEST"
                : "WAIT_FOR_LOWER_REJECTION_OR_BREAKOUT_RETEST";

            console.info(JSON.stringify({
                event: "V2_SIDE_ZONE_MISMATCH_BLOCK_PROOF",
                symbol: String(input.symbol),
                side: sideFinal,
                zone,
                boxPos,
                boxBreakSide: boxBreakSideFinal,
                market_subtype: judgment.subtype,
                shockPhase: judgment.shockPhase,
                htf_entry_policy: htfPol,
                htf_hard_block_reason: htfHardBlockReason,
                macro_source: judgment.macro_source ?? "unknown",
                qualityScore,
                finalDecisionBefore: decisionBeforeMismatchBlock,
                finalDecisionAfter: v2DecisionAfterPromotion,
                reason: mismatchReason
            }));
        }
    }

    // Tier 5.55: Same-Side Loss Re-entry Hysteresis & Fresh Setup Guard
    if (v2DecisionAfterPromotion === "ENTER" && (v2SideAfterPromotion === "long" || v2SideAfterPromotion === "short")) {
        const terminalCtx = resolveTerminalBarrierContext({
            bridgeOpenPositions: (input as any).bridgeState?.openPositions,
            positionStateReady: v2State.positionStateReady,
            symbolPositionsCount: v2State.symbolPositions.length
        });
        const terminalBarrier = evaluateTerminalReentryBarrier({
            symbol: String(input.symbol),
            requestedSide: v2SideAfterPromotion,
            openPositions: terminalCtx.openPositions,
            openPositionsSourceAvailable: terminalCtx.openPositionsSourceAvailable
        });
        if (terminalBarrier.blocked) {
            console.warn(JSON.stringify(buildTerminalReentryBarrierProof({
                symbol: String(input.symbol),
                requestedSide: v2SideAfterPromotion,
                blocked: true,
                reason: terminalBarrier.reason,
                closePending: terminalBarrier.closePending,
                finalizePending: terminalBarrier.finalizePending,
                actualPositionExists: terminalBarrier.actualPositionExists,
                terminalFillConfirmed: terminalBarrier.terminalFillConfirmed,
                lossStateCommitted: terminalBarrier.lossStateCommitted,
                positionCycleId: terminalBarrier.positionCycleId,
                now: input.now
            })));
            v2DecisionAfterPromotion = "HOLD";
            v2SideAfterPromotion = "none";
            v2RejectReasonAfterPromotion = terminalBarrier.reason;
            promotionApplied = false;
            promotionReason = null;
            expectedMissingCondition = terminalBarrier.reason;
            expectedNextAction = "WAIT_FOR_TERMINAL_CYCLE_FINALIZE";
        }
    }

    if (v2DecisionAfterPromotion === "ENTER" && (v2SideAfterPromotion === "long" || v2SideAfterPromotion === "short")) {
        const lossGateResult = evaluateSameSideLossReentryGate({
            symbol: String(input.symbol),
            requestedSide: v2SideAfterPromotion,
            currentPrice: Number(authoritativeInput.snapshot.lastPrice ?? 0),
            now: input.now,
            lastLossState: v2State.lastLossReentryState,
            candles: authoritativeInput.snapshot.candles,
            atr: Number(authoritativeInput.snapshot.atr ?? 0),
            feeBreakEvenPct: (riskSizing as any)?.feeBreakEvenPct ?? (riskSizing.diagnostics as any)?.fee_break_even_pct ?? 0.002,
            rangeBoxHigh: Number(authoritativeInput.snapshot.boxHigh ?? 0),
            rangeBoxLow: Number(authoritativeInput.snapshot.boxLow ?? 0),
            rangeBoxMid: Number(
                authoritativeInput.snapshot.boxHigh && authoritativeInput.snapshot.boxLow
                    ? (authoritativeInput.snapshot.boxHigh + authoritativeInput.snapshot.boxLow) / 2
                    : 0
            ),
            regime: judgment.regime,
            subtype: judgment.subtype,
            zone,
            rangeCycleCount: typeof (authoritativeInput.snapshot as any).rangeCycleCount === "number" ? (authoritativeInput.snapshot as any).rangeCycleCount : null,
            reversalConfirmed,
            trendOk,
            qualityScore,
            htfEntryPolicy: judgment.htf_entry_policy ?? null,
            macroPolarity: judgment.macroPolarity ?? null,
            directionalShockState: v2State.directionalShockState ?? null
        });

        if (!lossGateResult.allowed) {
            const decisionBeforeLossBlock = v2DecisionAfterPromotion;
            v2DecisionAfterPromotion = "HOLD";
            v2SideAfterPromotion = "none";
            v2RejectReasonAfterPromotion = lossGateResult.reason;
            promotionApplied = false;
            promotionReason = null;
            expectedMissingCondition = lossGateResult.reason;
            expectedNextAction = "WAIT_FOR_MEANINGFUL_DISPLACEMENT_OR_FRESH_SETUP";
        }
    }

    finalDecision = v2DecisionAfterPromotion;
    blockReason = v2RejectReasonAfterPromotion;

    const decisionAfterReadiness: EngineV2FinalDecision = finalDecision;

    // V2_NO_ENTER_DEADLOCK_RESOLVER
    let deadlockDetected = false;
    let promotedDecision: EngineV2FinalDecision | null = null;
    let promotedSide: EngineV2Side = "none";
    let isDeadlockProbe = false;
    let deadlockBlockReason: string | null = null;
    let repeatedCandidateSide: EngineV2Side = "none";
    let deadlockMetrics: ReturnType<typeof aggregateDeadlockMetrics> | null = null;

    const auditEnabled = String(process.env.V2_DEADLOCK_RESOLVER_AUDIT_ENABLED ?? "true").toLowerCase() === "true";
    const promotionEnabled = String(process.env.V2_DEADLOCK_PROBE_PROMOTION_ENABLED ?? "false").toLowerCase() === "true";

    let blockedBeforeDetectionReason: string | null = null;

    if (auditEnabled) {
        deadlockMetrics = aggregateDeadlockMetrics(String(input.symbol), input.now);
        const hasActivePosition = v2State.currentPositions.some(p => p.symbol === input.symbol);
        const isControlClearForDeadlock =
            v2State.serverTradeEnabled === true &&
            v2State.closeOnlyMode !== true &&
            v2State.killSwitch !== true &&
            v2State.reconcileSafeMode !== true &&
            String(v2State.riskMode ?? "").toUpperCase() !== "HALT" &&
            v2State.dailyLossGuardTriggered !== true;

        // deadlock 후보 판정
        repeatedCandidateSide = deadlockMetrics.repeatedCandidateSide as EngineV2Side;
        const sameSidePersistence = deadlockMetrics.sameDirectionPersistence;
        const repeatedCount = deadlockMetrics.repeatedCandidateCount;
        const qualityAvg = deadlockMetrics.qualityScoreAvg;

        const symbolStr = String(input.symbol);
        const lastPositionOpenedAtVal = symbolLastPositionOpenedAtMap.get(symbolStr) ?? null;
        const isLastPositionOpenedAtUnknown = lastPositionOpenedAtVal === null;

        if (
            !hasActivePosition &&
            isControlClearForDeadlock &&
            !hardBlockPresent &&
            !isNaN(deadlockMetrics.minutesSinceLastPositionOpened) &&
            deadlockMetrics.minutesSinceLastPositionOpened >= 600 &&
            repeatedCandidateSide !== "none" &&
            repeatedCount >= 10 &&
            (qualityAvg >= 65 || entryQualityGrade === "B" || entryQualityGrade === "A" || entryQualityGrade === "S")
        ) {
            deadlockDetected = true;
        }

        // 데드락 조건 미달 사유 연산
        if (!deadlockDetected) {
            if (hasActivePosition) {
                blockedBeforeDetectionReason = "HAS_ACTIVE_POSITION";
            } else if (!isControlClearForDeadlock) {
                blockedBeforeDetectionReason = "CONTROL_NOT_CLEAR";
            } else if (hardBlockPresent) {
                blockedBeforeDetectionReason = "HARD_BLOCK_PRESENT";
            } else if (isLastPositionOpenedAtUnknown) {
                blockedBeforeDetectionReason = "LAST_POSITION_OPENED_AT_UNKNOWN";
            } else if (deadlockMetrics.historyCount < 10) {
                blockedBeforeDetectionReason = "HISTORY_NOT_ENOUGH";
            } else if (deadlockMetrics.minutesSinceLastPositionOpened < 600) {
                blockedBeforeDetectionReason = "MINUTES_SINCE_LAST_ENTER_LT_600";
            } else if (repeatedCandidateSide === "none") {
                blockedBeforeDetectionReason = "REPEATED_CANDIDATE_SIDE_NONE";
            } else if (repeatedCount < 10) {
                blockedBeforeDetectionReason = "REPEATED_CANDIDATE_COUNT_LT_10";
            } else if (
                qualityAvg < 65 &&
                entryQualityGrade !== "B" &&
                entryQualityGrade !== "A" &&
                entryQualityGrade !== "S"
            ) {
                blockedBeforeDetectionReason = "QUALITY_AVG_BELOW_THRESHOLD";
            } else {
                blockedBeforeDetectionReason = "UNKNOWN_BLOCKED";
            }
        }

        // 주기적 audit proof 로그 출력 (deadlockDetected === true 이거나 마지막 로깅 시각 대비 1분 경과 또는 N사이클 경과 시)
        const lastLoggedAt = symbolLastDeadlockAuditLoggedAtMap.get(symbolStr) ?? 0;
        const currentCycles = symbolDeadlockAuditCycleMap.get(symbolStr) ?? 0;
        const nextCycles = currentCycles + 1;
        symbolDeadlockAuditCycleMap.set(symbolStr, nextCycles);

        const isTimeElapsed = input.now - lastLoggedAt >= 60 * 1000;
        const isCycleElapsed = nextCycles >= 100; // 매 100사이클마다 출력

        const shouldLogAudit = deadlockDetected || isTimeElapsed || isCycleElapsed;

        if (shouldLogAudit) {
            symbolLastDeadlockAuditLoggedAtMap.set(symbolStr, input.now);
            symbolDeadlockAuditCycleMap.set(symbolStr, 0); // 사이클 카운트 초기화

            // --- promotionWouldBlockReason dry-run (읽기 전용 시뮬레이션) ---
            // promotionEnabled 여부와 무관하게 promotion 체인 전체를 시뮬레이션하여
            // 최초 blocking reason을 계산한다. 실제 상태를 변경하지 않는다.
            let _dryBlockReason: string = "PROMOTION_WOULD_PASS";

            // 1. promotionEnabled env 검사
            if (!promotionEnabled) {
                _dryBlockReason = "PROMOTION_ENV_DISABLED";
            }
            // 2. deadlock 미탐지 시: 조건 미충족 상태
            else if (!deadlockDetected) {
                _dryBlockReason = `DEADLOCK_NOT_DETECTED|${blockedBeforeDetectionReason ?? "UNKNOWN"}`;
            }
            // 3. lastPositionOpenedAt 복원 불가
            else if (isLastPositionOpenedAtUnknown) {
                _dryBlockReason = "LAST_POSITION_OPENED_AT_UNKNOWN";
            }
            // 4. execution readiness
            else if (!paperExecutionReady || !signedExecutionReady) {
                _dryBlockReason = "EXECUTION_NOT_READY";
            }
            // 5. mid-zone probe 금지
            else if (zone === "mid" && shock === "NONE") {
                _dryBlockReason = "MID_ZONE_PROBE_EXCLUDED";
            }
            // 6. POLARITY_MISMATCH
            else if (judgment.polarityMismatch === true) {
                _dryBlockReason = "POLARITY_MISMATCH";
            }
            // 7. SIDE_NOT_ALLOWED
            else if (
                (repeatedCandidateSide === "long" && (!allowNewLong || !riskLongAllow)) ||
                (repeatedCandidateSide === "short" && (!allowNewShort || !riskShortAllow))
            ) {
                _dryBlockReason = "SIDE_NOT_ALLOWED";
            }
            // 8. position conflict
            else if (hasActivePosition || v2State.hasSameSidePosition === true || v2State.hasOppositeSidePosition === true) {
                _dryBlockReason = "POSITION_CONFLICT";
            }
            // 9. hard block / control 검사
            else if (!isControlClearForDeadlock || hardBlockPresent) {
                _dryBlockReason = hardBlockReason || "HARD_BLOCK_ACTIVE";
            }
            // 10. 6시간 재probe 제한
            else if ((() => {
                const lastProbeAt = symbolLastProbeAtMap.get(symbolStr) ?? 0;
                return (input.now - lastProbeAt) < 6 * 3600 * 1000;
            })()) {
                _dryBlockReason = "PROBE_COOLDOWN_ACTIVE";
            }
            // 11. 동일 방향 reprobe 품질/구조 개선 없음
            else if ((() => {
                const lastProbeSide = symbolLastProbeSideMap.get(symbolStr);
                if (lastProbeSide === repeatedCandidateSide) {
                    const lastProbeQuality = symbolLastProbeQualityMap.get(symbolStr) ?? 0;
                    const lastProbeStructure = symbolLastProbeStructureMap.get(symbolStr) ?? "";
                    const currentStructure = `${judgment.regime}|${judgment.subtype}|${zone}`;
                    return !( qualityScore > lastProbeQuality || currentStructure !== lastProbeStructure );
                }
                return false;
            })()) {
                _dryBlockReason = "SAME_DIRECTION_REPROBE_FORBIDDEN_NO_IMPROVEMENT";
            }
            // 12. 허용 구조 검사 (lower+long, upper+short, DOWN shock+short, UP shock+long w/ HTF)
            else if ((() => {
                if (zone === "lower" && repeatedCandidateSide === "long") return false;
                if (zone === "upper" && repeatedCandidateSide === "short") return false;
                if (shock === "DOWN" && repeatedCandidateSide === "short") return false;
                if (shock === "UP" && repeatedCandidateSide === "long" &&
                    (judgment.htf_entry_policy === "ALLOW" || judgment.htf_entry_policy === "LONG_ONLY_OR_NONE")) return false;
                return true; // 허용 구조 없음 → 블록
            })()) {
                // 구체적인 사유 세분화
                if (zone === "lower" && repeatedCandidateSide === "short") {
                    _dryBlockReason = "STRUCTURE_NOT_ALLOWED_LOWER_SHORT";
                } else if (zone === "upper" && repeatedCandidateSide === "long") {
                    _dryBlockReason = "STRUCTURE_NOT_ALLOWED_UPPER_LONG";
                } else {
                    _dryBlockReason = "STRUCTURE_NOT_ALLOWED";
                }
            }
            // 13. range/trend side conflict (repeatedCandidateSide 기준 보조 검사)
            else if ((() => {
                const rangeSide = deadlockMetrics?.repeatedCandidateSide ?? "none";
                const trendSideCand = (judgment as any).trend_side_candidate ?? (judgment as any).trendSide ?? null;
                return trendSideCand && trendSideCand !== "none" && trendSideCand !== rangeSide && rangeSide !== "none";
            })()) {
                _dryBlockReason = "RANGE_TREND_SIDE_CONFLICT";
            }
            // 14. stopPlan 유효성 검사 (dry-run, 패치 불포함)
            else if (execution.stopPrice == null || isNaN(execution.stopPrice as number)) {
                _dryBlockReason = "STOP_PLAN_INVALID";
            }
            // 15. margin / exposure 검사 (dry-run)
            else if ((() => {
                let baseMargin = riskSizing.baseStageMarginKrw;
                if (!baseMargin || baseMargin <= 0) {
                    baseMargin = input.config.baseSizeUsd ? input.config.baseSizeUsd * 1400 : 140000;
                } else if (baseMargin < 1000) {
                    baseMargin = baseMargin * 1400;
                }
                const stageMarginKrwAfterTemp = Math.round(baseMargin * 0.25);
                const minProbeMarginKrw = 14000;
                const maxUsable = v2State.maxUsableMarginKrw ?? 0;
                if (stageMarginKrwAfterTemp <= 0) { _dryBlockReason = "STAGE_MARGIN_ZERO"; return true; }
                if (stageMarginKrwAfterTemp < minProbeMarginKrw) { _dryBlockReason = "MIN_ORDER_SIZE_UNDERFLOW"; return true; }
                if (stageMarginKrwAfterTemp > maxUsable) { _dryBlockReason = "INSUFFICIENT_MARGIN"; return true; }
                const orderNotionalKrw = stageMarginKrwAfterTemp * 10;
                const exposureCap = v2State.exposureNotionalCapKrw ?? 0;
                const symbolExposureCap = v2State.symbolExposureNotionalCapKrw ?? 0;
                const currentGlobalNotionalKrw = v2State.ledgerExposureNotionalKrw ?? 0;
                const currentSymbolNotionalKrw = v2State.symbolLedgerExposureNotionalKrw ?? 0;
                if (exposureCap > 0 && (currentGlobalNotionalKrw + orderNotionalKrw > exposureCap)) { _dryBlockReason = "EXPOSURE_CAP_EXCEEDED"; return true; }
                if (symbolExposureCap > 0 && (currentSymbolNotionalKrw + orderNotionalKrw > symbolExposureCap)) { _dryBlockReason = "EXPOSURE_CAP_EXCEEDED"; return true; }
                return false;
            })()) {
                // _dryBlockReason은 내부 IIFE에서 이미 세팅됨
            }
            // --- dry-run 종료 ---

            console.info(JSON.stringify({
                event: "V2_NO_ENTER_DEADLOCK_AUDIT_PROOF",
                symbol: symbolStr,
                auditEnabled,
                promotionEnabled,
                deadlockDetected,
                blockedBeforeDetectionReason: blockedBeforeDetectionReason ?? "NONE",
                minutesSinceLastPositionOpened: deadlockMetrics.minutesSinceLastPositionOpened,
                lastPositionOpenedAt: deadlockMetrics.lastPositionOpenedAt,
                lastV2EnterDecisionAt: deadlockMetrics.lastV2EnterDecisionAt,
                repeatedCandidateSide,
                repeatedCandidateCount: repeatedCount,
                sameDirectionPersistence: sameSidePersistence,
                qualityScoreAvg: qualityAvg,
                qualityScoreMax: deadlockMetrics.qualityScoreMax,
                latestQualityScore: qualityScore,
                zone,
                sideZoneValid,
                htfPolicy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
                hardBlockPresent,
                readinessOk: paperExecutionReady && signedExecutionReady,
                stopPlanValid: execution.stopPrice != null && !isNaN(execution.stopPrice as number),
                promotionWouldBlockReason: _dryBlockReason
            }));
        }

        if (deadlockDetected && finalDecision !== "ENTER") {
            // Promotion 시도
            let blockProbe = false;
            let blockedReason = "";

            const symbolStr = String(input.symbol);
            const lastPositionOpenedAt = symbolLastPositionOpenedAtMap.get(symbolStr) ?? null;
            const isLastPositionOpenedAtUnknown = lastPositionOpenedAt === null;

            // 1. promotionEnabled env 검사
            if (!promotionEnabled) {
                blockProbe = true;
                blockedReason = "PROMOTION_ENV_DISABLED";
            }
            // 2. lastPositionOpenedAt 복원 여부 검사 (복원 불가 시 unknown 상태로 promotion 금지)
            else if (isLastPositionOpenedAtUnknown) {
                blockProbe = true;
                blockedReason = "LAST_POSITION_OPENED_AT_UNKNOWN";
            }
            // 3. execution readiness 검사
            else if (!paperExecutionReady || !signedExecutionReady) {
                blockProbe = true;
                blockedReason = "EXECUTION_NOT_READY";
            }
            // 4. mid-zone probe 금지 검사
            else if (zone === "mid" && shock === "NONE") {
                blockProbe = true;
                blockedReason = "MID_ZONE_PROBE_EXCLUDED";
            }
            // 5. POLARITY_MISMATCH 검사
            else if (judgment.polarityMismatch === true || (judgment.htf_entry_policy === "HOLD" && judgment.polarityMismatch)) {
                blockProbe = true;
                blockedReason = "POLARITY_MISMATCH";
            }
            // 6. SIDE_NOT_ALLOWED 검사
            else if ((repeatedCandidateSide === "long" && (!allowNewLong || !riskLongAllow)) ||
                     (repeatedCandidateSide === "short" && (!allowNewShort || !riskShortAllow))) {
                blockProbe = true;
                blockedReason = "SIDE_NOT_ALLOWED";
            }
            // 7. position conflict 검사
            else if (hasActivePosition || v2State.hasSameSidePosition === true || v2State.hasOppositeSidePosition === true) {
                blockProbe = true;
                blockedReason = "POSITION_CONFLICT";
            }
            // 8. hard block 관련 환경/제어 검사 (serverTradeEnabled, closeOnlyMode, killSwitch, reconcileSafeMode 등)
            else if (!isControlClearForDeadlock || hardBlockPresent) {
                blockProbe = true;
                blockedReason = hardBlockReason || "HARD_BLOCK_ACTIVE";
            }

            // 6시간 재probe 제한 검사
            if (!blockProbe) {
                const lastProbeAt = symbolLastProbeAtMap.get(String(input.symbol)) ?? 0;
                if (input.now - lastProbeAt < 6 * 3600 * 1000) {
                    blockProbe = true;
                    blockedReason = "PROBE_COOLDOWN_ACTIVE";
                    console.info(JSON.stringify({
                        event: "V2_DEADLOCK_PROBE_COOLDOWN_PROOF",
                        symbol: String(input.symbol),
                        candidateSide: repeatedCandidateSide,
                        lastProbeAt,
                        cooldownRemainingMs: 6 * 3600 * 1000 - (input.now - lastProbeAt),
                        lastV2EnterDecisionAt: deadlockMetrics.lastV2EnterDecisionAt,
                        lastPositionOpenedAt: deadlockMetrics.lastPositionOpenedAt
                    }));
                }
            }

            // 동일 방향 재probe 품질 개선/구조 변화 검사
            if (!blockProbe) {
                const lastProbeSide = symbolLastProbeSideMap.get(String(input.symbol));
                if (lastProbeSide === repeatedCandidateSide) {
                    const lastProbeQuality = symbolLastProbeQualityMap.get(String(input.symbol)) ?? 0;
                    const lastProbeStructure = symbolLastProbeStructureMap.get(String(input.symbol)) ?? "";
                    const currentStructure = `${judgment.regime}|${judgment.subtype}|${zone}`;
                    
                    const qualityImproved = qualityScore > lastProbeQuality;
                    const structureChanged = currentStructure !== lastProbeStructure;

                    if (!qualityImproved && !structureChanged) {
                        blockProbe = true;
                        blockedReason = "SAME_DIRECTION_REPROBE_FORBIDDEN_NO_IMPROVEMENT";
                    }
                }
            }

            // 허용 구조 검사
            if (!blockProbe) {
                let structureAllowed = false;
                if (zone === "lower" && repeatedCandidateSide === "long") {
                    structureAllowed = true;
                } else if (zone === "upper" && repeatedCandidateSide === "short") {
                    structureAllowed = true;
                } else if (shock === "DOWN" && repeatedCandidateSide === "short") {
                    structureAllowed = true;
                } else if (shock === "UP" && repeatedCandidateSide === "long") {
                    if (judgment.htf_entry_policy === "ALLOW" || judgment.htf_entry_policy === "LONG_ONLY_OR_NONE") {
                        structureAllowed = true;
                    }
                }

                if (!structureAllowed) {
                    blockProbe = true;
                    blockedReason = "STRUCTURE_NOT_ALLOWED";
                }
            }

            // stopPrice 보장 및 패치
            let targetStopPrice = execution.stopPrice;
            let targetInvalidationPx = execution.invalidationPx;
            if (!blockProbe) {
                const entryPrice = Number(authoritativeInput.snapshot.lastPrice ?? 0);
                const lastPrice = entryPrice;
                const atrVal = Number(authoritativeInput.snapshot.atr ?? 0);
                const minStopDist = Math.max(atrVal * 0.5, lastPrice * 0.0015);

                if (repeatedCandidateSide === "short") {
                    if (targetStopPrice == null || isNaN(targetStopPrice) || targetStopPrice <= lastPrice) {
                        // 패치 시도
                        const candles = authoritativeInput.snapshot.candles;
                        let swingHighVal = 0;
                        if (Array.isArray(candles) && candles.length > 0) {
                            const recentHighs = candles.slice(-20).map(c => Number(c.high ?? (c as any).h ?? 0));
                            swingHighVal = Math.max(...recentHighs);
                        }
                        const boxHighVal = Number(authoritativeInput.snapshot.boxHigh ?? 0);
                        const boxLowVal = Number(authoritativeInput.snapshot.boxLow ?? 0);
                        const boxMidVal = boxHighVal > 0 && boxLowVal > 0 ? (boxHighVal + boxLowVal) / 2 : 0;
                        const atrStopCandidate = lastPrice + Math.max(atrVal * 1.5, lastPrice * 0.005);

                        const candidates = [
                            swingHighVal,
                            boxHighVal,
                            boxMidVal,
                            atrStopCandidate
                        ].filter(v => Number.isFinite(v) && v > lastPrice + minStopDist);

                        let calculatedStopPrice = candidates.length > 0 ? Math.max(...candidates) : (lastPrice + minStopDist);
                        if (!Number.isFinite(calculatedStopPrice) || calculatedStopPrice <= lastPrice) {
                            calculatedStopPrice = lastPrice + minStopDist;
                        }
                        targetStopPrice = calculatedStopPrice;
                    }

                    if (targetStopPrice == null || isNaN(targetStopPrice) || targetStopPrice <= lastPrice) {
                        blockProbe = true;
                        blockedReason = "STOP_PRICE_MISSING_OR_INVALID";
                    }
                } else if (repeatedCandidateSide === "long") {
                    if (targetStopPrice == null || isNaN(targetStopPrice) || targetStopPrice >= lastPrice) {
                        // 패치 시도
                        const candles = authoritativeInput.snapshot.candles;
                        let swingLowVal = 0;
                        if (Array.isArray(candles) && candles.length > 0) {
                            const recentLows = candles.slice(-20).map(c => Number(c.low ?? (c as any).l ?? 0));
                            swingLowVal = Math.min(...recentLows);
                        }
                        const boxHighVal = Number(authoritativeInput.snapshot.boxHigh ?? 0);
                        const boxLowVal = Number(authoritativeInput.snapshot.boxLow ?? 0);
                        const boxMidVal = boxHighVal > 0 && boxLowVal > 0 ? (boxHighVal + boxLowVal) / 2 : 0;
                        const atrStopCandidate = lastPrice - Math.max(atrVal * 1.5, lastPrice * 0.005);

                        const candidates = [
                            swingLowVal,
                            boxLowVal,
                            boxMidVal,
                            atrStopCandidate
                        ].filter(v => Number.isFinite(v) && v < lastPrice - minStopDist);

                        let calculatedStopPrice = candidates.length > 0 ? Math.min(...candidates) : (lastPrice - minStopDist);
                        if (!Number.isFinite(calculatedStopPrice) || calculatedStopPrice >= lastPrice) {
                            calculatedStopPrice = lastPrice - minStopDist;
                        }
                        targetStopPrice = calculatedStopPrice;
                    }

                    if (targetStopPrice == null || isNaN(targetStopPrice) || targetStopPrice >= lastPrice) {
                        blockProbe = true;
                        blockedReason = "STOP_PRICE_MISSING_OR_INVALID";
                    }
                }

                if (!blockProbe) {
                    targetInvalidationPx = targetStopPrice;
                    if (targetInvalidationPx == null || isNaN(targetInvalidationPx)) {
                        blockProbe = true;
                        blockedReason = "STOP_PRICE_MISSING_OR_INVALID";
                    }
                }
            }

            // stageMarginKrwAfterTemp 계산 및 min order size / margin / exposure cap 검사
            if (!blockProbe) {
                let baseMargin = riskSizing.baseStageMarginKrw;
                if (!baseMargin || baseMargin <= 0) {
                    baseMargin = input.config.baseSizeUsd ? input.config.baseSizeUsd * 1400 : 140000;
                } else if (baseMargin < 1000) {
                    baseMargin = baseMargin * 1400;
                }
                const stageMarginKrwAfterTemp = Math.round(baseMargin * 0.25);
                const minProbeMarginKrw = 14000;

                const maxUsable = v2State.maxUsableMarginKrw ?? 0;
                const exposureCap = v2State.exposureNotionalCapKrw ?? 0;
                const symbolExposureCap = v2State.symbolExposureNotionalCapKrw ?? 0;
                
                const currentGlobalNotionalKrw = v2State.ledgerExposureNotionalKrw ?? 0;
                const currentSymbolNotionalKrw = v2State.symbolLedgerExposureNotionalKrw ?? 0;
                
                const orderNotionalKrw = stageMarginKrwAfterTemp * 10;

                if (stageMarginKrwAfterTemp <= 0) {
                    blockProbe = true;
                    blockedReason = "STAGE_MARGIN_ZERO";
                } else if (stageMarginKrwAfterTemp < minProbeMarginKrw) {
                    blockProbe = true;
                    blockedReason = "MIN_ORDER_SIZE_UNDERFLOW";
                } else if (stageMarginKrwAfterTemp > maxUsable) {
                    blockProbe = true;
                    blockedReason = "INSUFFICIENT_MARGIN";
                } else if (exposureCap > 0 && (currentGlobalNotionalKrw + orderNotionalKrw > exposureCap)) {
                    blockProbe = true;
                    blockedReason = "EXPOSURE_CAP_EXCEEDED";
                } else if (symbolExposureCap > 0 && (currentSymbolNotionalKrw + orderNotionalKrw > symbolExposureCap)) {
                    blockProbe = true;
                    blockedReason = "EXPOSURE_CAP_EXCEEDED";
                }
            }

            if (blockProbe) {
                deadlockBlockReason = blockedReason;
                console.warn(JSON.stringify({
                    event: "V2_DEADLOCK_PROBE_BLOCKED_PROOF",
                    symbol: String(input.symbol),
                    candidateSide: repeatedCandidateSide,
                    blockedReason,
                    htfPolicy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
                    hardBlockReason: blockedReason,
                    stopPrice: targetStopPrice,
                    qualityScore,
                    sideZoneValid,
                    lastV2EnterDecisionAt: deadlockMetrics.lastV2EnterDecisionAt,
                    lastPositionOpenedAt: deadlockMetrics.lastPositionOpenedAt
                }));
            } else {
                // 승격 수행
                promotedDecision = "ENTER";
                promotedSide = repeatedCandidateSide;
                isDeadlockProbe = true;

                finalDecision = "ENTER";
                v2SideAfterPromotion = promotedSide;
                v2DecisionAfterPromotion = "ENTER";
                v2RejectReasonAfterPromotion = null;
                blockReason = null;

                execution.signal = promotedSide === "long" ? "LONG_CANDIDATE" : "SHORT_CANDIDATE";
                execution.side = promotedSide;
                execution.stopPrice = targetStopPrice;
                execution.invalidationPx = targetStopPrice;
                v2CalculatedInvalidationPx = targetStopPrice;

                // metadata 주입
                if (!execution.metadata) execution.metadata = {};
                execution.metadata.maxHoldBars5m = 12;
                execution.metadata.timeStop = true;
                execution.metadata.entryReason = "V2_DEADLOCK_SMALL_PROBE";
                execution.metadata.probeTp = true;

                console.info(JSON.stringify({
                    event: "V2_DEADLOCK_PROBE_PROMOTION_PROOF",
                    symbol: String(input.symbol),
                    side: promotedSide,
                    previousDecision: decisionAfterReadiness,
                    promotedDecision: "ENTER",
                    sizeMultiplier: 0.25,
                    entryReason: "V2_DEADLOCK_SMALL_PROBE",
                    stopPrice: targetStopPrice,
                    invalidationPx: targetStopPrice,
                    qualityScore,
                    reason: "V2_NO_ENTER_DEADLOCK_RESOLVER_PROMOTION",
                    lastV2EnterDecisionAt: deadlockMetrics.lastV2EnterDecisionAt,
                    lastPositionOpenedAt: deadlockMetrics.lastPositionOpenedAt
                }));
            }
        }
    }

    // Live order size authority: fixed 10x leverage + strict env notional cap.
    const stageMarginKrwBefore = riskSizing.stageMarginKrw;
    let stageMarginKrwAfter = stageMarginKrwBefore;
    if (isDeadlockProbe || promotionReason === "CONTINUATION_MICRO_PROBE" || promotionReason === "V2_STAIR_STEP_CONTINUATION_PROMOTION" || promotionReason === "V2_TREND_CONTINUATION_REVALIDATED" || promotionReason === "V2_POLARITY_REVERSAL_MICRO_PROBE" || promotionReason === "V2_CONFLICT_RESOLVED_TREND_LONG" || promotionReason === "V2_RANGE_TREND_RECLAIM_MICRO_PROBE" || promotionReason === "WHIPSAW_SOFT_WATCH_DOWN_MID_SHORT_RETEST" || execution.reason === "WHIPSAW_SOFT_WATCH_DOWN_MID_SHORT_RETEST") {
        let baseMargin = riskSizing.baseStageMarginKrw;
        if (promotionReason === "V2_POLARITY_REVERSAL_MICRO_PROBE") {
            baseMargin = stageMarginKrwBefore > 0 ? stageMarginKrwBefore : riskSizing.baseStageMarginKrw;
        }
        if (!baseMargin || baseMargin <= 0) {
            baseMargin = input.config.baseSizeUsd ? input.config.baseSizeUsd * 1400 : 140000;
        } else if (baseMargin < 1000) {
            baseMargin = baseMargin * 1400;
        }
        
        let multiplier = 0.25;
        if (promotionReason === "CONTINUATION_MICRO_PROBE" && microProbeSizeCap != null) {
            multiplier = microProbeSizeCap;
        } else if (promotionReason === "V2_POLARITY_REVERSAL_MICRO_PROBE") {
            multiplier = 0.20;
        }
        
        stageMarginKrwAfter = Math.round(baseMargin * multiplier);
    }
    let cap_applied = false;
    let cap_reason: string | null = null;
    let cap_kind: string | null = null;
    let min_order_check_passed = true;
    let min_order_block_reason: string | null = null;
    let equityAdaptiveSizingAuthority: ReturnType<typeof evaluateEquityAdaptiveSizing> | null = null;
    const minProbeMarginKrw = 14000;
    const appliedLeverage = 10;
    const leverageSource = "v2_fixed";
    const leverageReason = "v2_fixed_10x";
    const rawEnvLiveMaxNotionalUsdt = process.env.OKX_LIVE_MAX_ORDER_NOTIONAL_USDT ?? null;
    const liveMaxNotionalSource = "process.env.OKX_LIVE_MAX_ORDER_NOTIONAL_USDT";

    // Read live limit envs strictly without implicit fallback defaults (no 500 default)
    const maxOrderNotionalUsdt = input.config.okxLiveMaxOrderNotionalUsdt ?? ((v2State as any).liveMaxOrderNotionalUsdt != null ? Number((v2State as any).liveMaxOrderNotionalUsdt) : null);
    const maxAddonNotionalUsdt = input.config.okxLiveMaxAddonNotionalUsdt ?? ((v2State as any).liveMaxAddonNotionalUsdt != null ? Number((v2State as any).liveMaxAddonNotionalUsdt) : null);
    const maxSymbolNotionalUsdt = input.config.okxLiveMaxSymbolNotionalUsdt ?? ((v2State as any).liveMaxSymbolNotionalUsdt != null ? Number((v2State as any).liveMaxSymbolNotionalUsdt) : null);
    const maxAccountNotionalUsdt = input.config.okxLiveMaxAccountNotionalUsdt ?? ((v2State as any).liveMaxAccountNotionalUsdt != null ? Number((v2State as any).liveMaxAccountNotionalUsdt) : null);
    const maxAddonCount = input.config.okxLiveMaxAddonCount ?? ((v2State as any).liveMaxAddonCount != null ? Number((v2State as any).liveMaxAddonCount) : null);

    // Live balance and OKX actual position state (No 69 USDT fallbacks)
    const rawAccountEquity = (v2State as any).accountEquityUsdt ?? (input.state as any).accountEquityUsdt;
    const rawAvailableBalance = (v2State as any).availableBalanceUsdt ?? (input.state as any).availableBalanceUsdt;
    const accountEquityUsdt = typeof rawAccountEquity === "number" && Number.isFinite(rawAccountEquity) ? rawAccountEquity : null;
    const availableBalanceUsdt = typeof rawAvailableBalance === "number" && Number.isFinite(rawAvailableBalance) ? rawAvailableBalance : null;

    // OKX actual positions & pending orders readiness
    const liveBalanceReady = (v2State as any).liveBalanceReady === true || (input.state as any).liveBalanceReady === true;
    const okxActualPositionsReady = (v2State as any).okxActualPositionsReady === true || (input.state as any).okxActualPositionsReady === true;
    const actualAccountNotionalUsdtReady = (v2State as any).actualAccountNotionalUsdtReady === true || (input.state as any).actualAccountNotionalUsdtReady === true;
    const okxPendingOrdersReady = (v2State as any).okxPendingOrdersReady === true || (input.state as any).okxPendingOrdersReady === true;

    // Raw payloads
    const okxActualPositionsRaw = (v2State as any).okxActualPositions ?? (input.state as any).okxActualPositions;
    const pendingOrdersNotionalRaw = (v2State as any).okxPendingOrdersNotionalUsdt ?? (input.state as any).okxPendingOrdersNotionalUsdt;
    const pendingSymbolNotionalRaw = (v2State as any).okxPendingSymbolNotionalUsdt ?? (input.state as any).okxPendingSymbolNotionalUsdt;

    // Timestamps
    const balanceFetchedAt = (v2State as any).balanceFetchedAt ?? (input.state as any).balanceFetchedAt;
    const positionsFetchedAt = (v2State as any).positionsFetchedAt ?? (input.state as any).positionsFetchedAt;
    const pendingOrdersFetchedAt = (v2State as any).pendingOrdersFetchedAt ?? (input.state as any).pendingOrdersFetchedAt;

    // Timestamp & freshness validation
    const maxDataAgeMs = 30000;
    const maxDataSkewMs = 10000;
    const nowMs = input.now ?? Date.now();

    const balanceAge = nowMs - balanceFetchedAt;
    const positionsAge = nowMs - positionsFetchedAt;
    const pendingOrdersAge = nowMs - pendingOrdersFetchedAt;

    const timestampsPresent =
        typeof balanceFetchedAt === "number" && Number.isFinite(balanceFetchedAt) && balanceFetchedAt > 0 &&
        typeof positionsFetchedAt === "number" && Number.isFinite(positionsFetchedAt) && positionsFetchedAt > 0 &&
        typeof pendingOrdersFetchedAt === "number" && Number.isFinite(pendingOrdersFetchedAt) && pendingOrdersFetchedAt > 0;

    const dataFresh =
        timestampsPresent &&
        balanceAge >= 0 && balanceAge <= maxDataAgeMs &&
        positionsAge >= 0 && positionsAge <= maxDataAgeMs &&
        pendingOrdersAge >= 0 && pendingOrdersAge <= maxDataAgeMs;

    const dataSynced =
        timestampsPresent &&
        (Math.max(balanceFetchedAt, positionsFetchedAt, pendingOrdersFetchedAt) -
         Math.min(balanceFetchedAt, positionsFetchedAt, pendingOrdersFetchedAt)) <= maxDataSkewMs;

    // Validate OKX actual positions payload array structure and content
    let okxPositionsValid = okxActualPositionsReady && Array.isArray(okxActualPositionsRaw);
    const validPositionsList: Array<{ symbol: string; sizeUsd: number; side: string }> = [];

    if (okxPositionsValid) {
        for (const p of okxActualPositionsRaw) {
            if (!p || typeof p.symbol !== "string" || !p.symbol) {
                okxPositionsValid = false;
                break;
            }
            const rawNotional = p.sizeUsd ?? p.notionalUsd ?? (p as any).notionalUSDT;
            if (typeof rawNotional !== "number" || !Number.isFinite(rawNotional) || rawNotional < 0) {
                okxPositionsValid = false;
                break;
            }
            const notional = Math.abs(rawNotional);
            const rawSide = String(p.side ?? "").toUpperCase();
            const normalizedSide = rawSide === "BUY" ? "LONG" : rawSide === "SELL" ? "SHORT" : rawSide;

            if (notional > 0) {
                if (normalizedSide !== "LONG" && normalizedSide !== "SHORT") {
                    okxPositionsValid = false;
                    break;
                }
            } else {
                if (normalizedSide !== "LONG" && normalizedSide !== "SHORT" && normalizedSide !== "NONE") {
                    okxPositionsValid = false;
                    break;
                }
            }

            if (notional > 0) {
                validPositionsList.push({
                    symbol: p.symbol,
                    sizeUsd: notional,
                    side: normalizedSide
                });
            }
        }
    }

    const pendingOrdersValid =
        okxPendingOrdersReady === true &&
        typeof pendingOrdersNotionalRaw === "number" &&
        Number.isFinite(pendingOrdersNotionalRaw) &&
        pendingOrdersNotionalRaw >= 0 &&
        typeof pendingSymbolNotionalRaw === "number" &&
        Number.isFinite(pendingSymbolNotionalRaw) &&
        pendingSymbolNotionalRaw >= 0 &&
        (v2State as any).hasUnknownPendingNotional !== true &&
        (input.state as any).hasUnknownPendingNotional !== true;

    // Ledger vs OKX Actual Position Matching (Add-on Authority)
    const normSide = (s?: string) => {
        const u = String(s ?? "").toUpperCase();
        return u === "BUY" ? "LONG" : u === "SELL" ? "SHORT" : u;
    };
    const currentPositions = Array.isArray(v2State.currentPositions) ? v2State.currentPositions : [];
    const ledgerPos = currentPositions.find((p) => p && p.symbol === input.symbol) ?? null;

    // Inspect ALL OKX actual positions for input.symbol
    const symbolActualPositions = validPositionsList.filter((p) => p.symbol === input.symbol);
    const hasLongActual = symbolActualPositions.some((p) => p.side === "LONG");
    const hasShortActual = symbolActualPositions.some((p) => p.side === "SHORT");

    let isAddOn = false;
    let positionMismatch = false;

    if (hasLongActual && hasShortActual) {
        // Dual LONG and SHORT positions exist for symbol -> MISMATCH
        positionMismatch = true;
    } else if (ledgerPos != null) {
        const ledgerSide = normSide(ledgerPos.side);
        if (symbolActualPositions.length === 0) {
            positionMismatch = true;
        } else {
            const anyMismatch = symbolActualPositions.some((p) => p.side !== ledgerSide);
            if (anyMismatch) {
                positionMismatch = true;
            } else {
                isAddOn = true;
            }
        }
    } else {
        if (symbolActualPositions.length > 0) {
            const actualSide = symbolActualPositions[0]?.side;
            const enterSide = v2SideAfterPromotion === "long" || v2SideAfterPromotion === "short" ? v2SideAfterPromotion : null;
            const enterSideNorm = enterSide != null ? normSide(enterSide) : null;
            if (enterSideNorm != null && actualSide === enterSideNorm) {
                isAddOn = true;
            }
            positionMismatch = false;
        } else {
            isAddOn = false;
        }
    }

    const sameSymbolPos = ledgerPos;
    const currentAddonCount = isAddOn ? ((sameSymbolPos as any).addonCount ?? Math.max(0, (((sameSymbolPos as any).entryStage ?? 1) - 1))) : 0;

    let requestedOrderNotionalUsdt = 0;
    let finalOrderNotionalUsdt = 0;
    let existingAccountNotionalUsdt = 0;
    let existingSymbolNotionalUsdt = 0;

    const okxLiveEnabled = (v2State as any).okxLiveEnabled === true || input.state.okxLiveEnabled === true;
    const okxAuthMode = (v2State as any).okxAuthMode ?? input.state.okxAuthMode;
    const okxExchangeAuthOptIn = (v2State as any).okxExchangeAuthOptIn === true || input.state.okxExchangeAuthOptIn === true;

    let executionAction: import("./types").EngineV2ExecutionAction =
        finalDecision === "ENTER"
            ? (isAddOn ? "ADDON" : "ENTER")
            : "NONE";

    const isLiveSignedOrderAttempt =
        okxAuthMode === "live" &&
        okxExchangeAuthOptIn === true &&
        okxLiveEnabled === true &&
        (executionAction === "ENTER" || executionAction === "ADDON");

    console.log(JSON.stringify({
        event: "DEBUG_LIVE_ORDER_VARS",
        okxAuthMode,
        okxExchangeAuthOptIn,
        okxLiveEnabled,
        executionAction,
        isLiveSignedOrderAttempt
    }));

    const isMicroProbe =
        promotionReason === "V2_RANGE_MID_MICRO_PROBE_CONFIRMED" ||
        promotionReason === "CONTINUATION_MICRO_PROBE" ||
        promotionReason === "V2_STAIR_STEP_CONTINUATION_PROMOTION" ||
        promotionReason === "V2_TREND_CONTINUATION_REVALIDATED" ||
        promotionReason === "V2_POLARITY_REVERSAL_MICRO_PROBE" ||
        promotionReason === "V2_PROBE_ENTRY_CONFIRMED" ||
        promotionReason === "V2_WAIT_RECHECK_QUALIFIED_PROMOTION" ||
        promotionReason === "SHOCK_REACTION_DOWN_MID_MOMENTUM_CONFIRMED" ||
        promotionReason === "V2_TRANSITION_WATCH_SHORT_PROBE" ||
        promotionReason === "V2_UPPER_LONG_PROBE_PROMOTION" ||
        promotionReason === "V2_LOWER_LONG_REACTION_PROBE_PROMOTION" ||
        promotionReason === "V2_UPPER_SHORT_REACTION_PROBE_PROMOTION" ||
        promotionReason === "V2_CONFLICT_RESOLVED_TREND_LONG" ||
        promotionReason === "V2_RANGE_TREND_RECLAIM_MICRO_PROBE" ||
        promotionReason === "WHIPSAW_SOFT_WATCH_DOWN_MID_SHORT_RETEST" ||
        execution.reason === "WHIPSAW_SOFT_WATCH_DOWN_MID_SHORT_RETEST";

    // Tier 5.6: Mandatory Risk Plan Audit (STOP_PRICE_MISSING Hard Block)
    let liveReadinessPassed = true;

    if (
        finalDecision === "ENTER" &&
        exitPolicy.shouldExit === true &&
        exitPolicy.action === "FULL_EXIT" &&
        exitPolicy.positionSide !== "none" &&
        v2SideAfterPromotion !== "none" &&
        v2SideAfterPromotion !== exitPolicy.positionSide
    ) {
        finalDecision = "HOLD";
        v2DecisionAfterPromotion = "HOLD";
        v2SideAfterPromotion = "none";
        v2RejectReasonAfterPromotion = "SAME_CYCLE_REVERSE_BLOCKED";
        execution = {
            ...execution,
            signal: "WAIT_RECHECK" as const,
            side: "none" as const,
            reason: "SAME_CYCLE_REVERSE_BLOCKED"
        };
    }

    if (finalDecision === "ENTER") {
        const lastPrice = Number(authoritativeInput.snapshot.lastPrice ?? 0);
        const sideFinal = v2SideAfterPromotion;

        const auditBlockReason = ensurePromotedEntryRiskPlan(
            execution,
            finalDecision,
            sideFinal,
            v2CalculatedInvalidationPx,
            authoritativeInput.snapshot,
            judgment as any,
            promotionReason,
            microProbeFixedBoundary
        );
        
        if (execution.invalidationPx != null) {
            v2CalculatedInvalidationPx = execution.invalidationPx;
        }

        const structuralStopPx = execution.stopPrice;
        const structuralInvalidationPx = execution.invalidationPx;

        let riskAuditFailed = false;
        let riskAuditReason: string | null = null;

        if (auditBlockReason) {
            riskAuditFailed = true;
            riskAuditReason = auditBlockReason;
        } else if (sideFinal === "long" || sideFinal === "short") {
            if (structuralStopPx == null || structuralInvalidationPx == null || isNaN(structuralStopPx) || isNaN(structuralInvalidationPx)) {
                riskAuditFailed = true;
                riskAuditReason = "STOP_PRICE_MISSING";
            }
        }

        if (!riskAuditFailed && (sideFinal === "long" || sideFinal === "short")) {
            const stopPxVal = structuralStopPx!;
            const invPxVal = structuralInvalidationPx!;
            // Directional Safety Check
            if (sideFinal === "long" && (invPxVal >= lastPrice || (stopPxVal >= lastPrice && Math.abs(stopPxVal - lastPrice) > 0.00000001))) {
                riskAuditFailed = true;
                riskAuditReason = "LONG_INVALIDATION_ABOVE_ENTRY";
            } else if (sideFinal === "short" && (invPxVal <= lastPrice || (stopPxVal <= lastPrice && Math.abs(stopPxVal - lastPrice) > 0.00000001))) {
                riskAuditFailed = true;
                riskAuditReason = "SHORT_INVALIDATION_BELOW_ENTRY";
            }
        }

        if (riskAuditFailed) {
            console.error(JSON.stringify({
                event: "V2_ENTRY_PLAN_RISK_PROOF",
                symbol: String(input.symbol),
                side: sideFinal,
                lastPrice,
                stopPrice: structuralStopPx,
                invalidationPx: structuralInvalidationPx,
                audit_passed: false,
                fail_reason: riskAuditReason,
                action: "HARD_BLOCK_ENTRY"
            }));

            finalDecision = "REJECT";
            v2DecisionAfterPromotion = "REJECT";
            v2SideAfterPromotion = "none";
            execution.side = "none";
            execution.stopPrice = null;
            execution.invalidationPx = null;
            blockReason = riskAuditReason;
            stageMarginKrwAfter = 0;
            expectedMissingCondition = riskAuditReason;
            expectedNextAction = "FIX_EXECUTOR_RISK_PLAN";
        } else {
             console.info(JSON.stringify({
                event: "V2_ENTRY_PLAN_RISK_PROOF",
                symbol: String(input.symbol),
                side: sideFinal,
                lastPrice,
                stopPrice: structuralStopPx,
                invalidationPx: structuralInvalidationPx,
                audit_passed: true,
                action: "ALLOW_ENTRY"
            }));
        }
    }
    if (riskSizing.isBlocked || finalDecision === "ENTER") {
        riskSizing.appliedLeverage = appliedLeverage;
        riskSizing.leverageReason = leverageReason;

        const effectiveMaxAddonCount = maxAddonCount ?? 1;

        const equitySource =
            (v2State as any).equitySource ??
            (input.state as any).equitySource ??
            "okx_total_eq";
        const equityAgeMs =
            typeof balanceFetchedAt === "number" ? nowMs - balanceFetchedAt : null;
        const equityFresh = dataFresh;
        const okxAuthReady =
            (v2State as any).okxAuthReady === true ||
            (input.state as any).okxAuthReady === true;

        const equityAuthority = evaluateEquitySizingAuthority({
            symbol: String(input.symbol),
            accountEquityUsdt,
            availableBalanceUsdt,
            liveBalanceReady,
            okxAuthReady,
            equityFresh,
            equitySource,
            equityAgeMs
        });

        if (isLiveSignedOrderAttempt && input.evaluationMode !== "diagnostic") {
            console.info(JSON.stringify(buildEquitySizingAuthorityProof({
                symbol: String(input.symbol),
                account_equity_usdt: accountEquityUsdt,
                available_balance_usdt: availableBalanceUsdt,
                equity_source: equitySource,
                equity_age_ms: equityAgeMs,
                equity_fresh: equityFresh,
                sizing_authority_ready: equityAuthority.sizingAuthorityReady,
                block_reason: equityAuthority.blockReason
            })));
        }

        liveReadinessPassed =
            liveBalanceReady &&
            accountEquityUsdt !== null && accountEquityUsdt > 0 &&
            availableBalanceUsdt !== null && availableBalanceUsdt >= 0 &&
            okxActualPositionsReady &&
            actualAccountNotionalUsdtReady &&
            okxPendingOrdersReady &&
            okxPositionsValid &&
            pendingOrdersValid &&
            timestampsPresent &&
            dataFresh &&
            dataSynced &&
            !positionMismatch;

        const liveReadinessFailureReasons: string[] = [];

        if (!liveBalanceReady)
            liveReadinessFailureReasons.push("LIVE_BALANCE_NOT_READY");

        if (!(accountEquityUsdt !== null && accountEquityUsdt > 0))
            liveReadinessFailureReasons.push("ACCOUNT_EQUITY_INVALID");

        if (!(availableBalanceUsdt !== null && availableBalanceUsdt >= 0))
            liveReadinessFailureReasons.push("AVAILABLE_BALANCE_INVALID");

        if (!okxActualPositionsReady)
            liveReadinessFailureReasons.push("POSITIONS_NOT_READY");

        if (!actualAccountNotionalUsdtReady)
            liveReadinessFailureReasons.push("ACCOUNT_NOTIONAL_NOT_READY");

        if (!okxPendingOrdersReady)
            liveReadinessFailureReasons.push("PENDING_ORDERS_NOT_READY");

        if (!okxPositionsValid)
            liveReadinessFailureReasons.push("POSITIONS_PAYLOAD_INVALID");

        if (!pendingOrdersValid)
            liveReadinessFailureReasons.push("PENDING_ORDERS_PAYLOAD_INVALID");

        if (!timestampsPresent)
            liveReadinessFailureReasons.push("TIMESTAMPS_MISSING");

        if (!dataFresh)
            liveReadinessFailureReasons.push("DATA_STALE");

        if (!dataSynced)
            liveReadinessFailureReasons.push("DATA_SKEW_TOO_WIDE");

        if (positionMismatch)
            liveReadinessFailureReasons.push("POSITION_AUTHORITY_MISMATCH");

        if (isLiveSignedOrderAttempt) {
            console.info(JSON.stringify({
                event: "V2_LIVE_ACCOUNT_AUTHORITY_BREAKDOWN_PROOF",
                symbol: String(input.symbol),

                isLiveSignedOrderAttempt,
                liveReadinessPassed,

                liveBalanceReady,
                accountEquityUsdt,
                availableBalanceUsdt,

                okxActualPositionsReady,
                actualAccountNotionalUsdtReady,
                okxPendingOrdersReady,

                okxPositionsValid,
                pendingOrdersValid,

                timestampsPresent,
                dataFresh,
                dataSynced,

                positionMismatch,

                balanceFetchedAt: balanceFetchedAt ?? null,
                positionsFetchedAt: positionsFetchedAt ?? null,
                pendingOrdersFetchedAt: pendingOrdersFetchedAt ?? null,

                balanceAgeMs: typeof balanceFetchedAt === "number" ? nowMs - balanceFetchedAt : null,
                positionsAgeMs: typeof positionsFetchedAt === "number" ? nowMs - positionsFetchedAt : null,
                pendingOrdersAgeMs: typeof pendingOrdersFetchedAt === "number" ? nowMs - pendingOrdersFetchedAt : null,

                maxDataAgeMs,
                maxDataSkewMs,

                okxActualPositionsIsArray: Array.isArray(okxActualPositionsRaw),
                okxActualPositionsCount: Array.isArray(okxActualPositionsRaw) ? okxActualPositionsRaw.length : null,

                pendingOrdersNotionalUsdt: pendingOrdersNotionalRaw ?? null,
                pendingSymbolNotionalUsdt: pendingSymbolNotionalRaw ?? null,

                failureReasons: liveReadinessFailureReasons
            }));
        }



        if (isLiveSignedOrderAttempt && !equityAuthority.sizingAuthorityReady) {
            min_order_check_passed = false;
            min_order_block_reason = "LIVE_ACCOUNT_EQUITY_NOT_READY";
        } else if (isLiveSignedOrderAttempt && positionMismatch) {
            min_order_check_passed = false;
            min_order_block_reason = "POSITION_AUTHORITY_MISMATCH";
        } else if (isLiveSignedOrderAttempt && !liveReadinessPassed) {
            min_order_check_passed = false;
            min_order_block_reason = "LIVE_ACCOUNT_AUTHORITY_NOT_READY";
        } else if (isLiveSignedOrderAttempt && ((v2State as any).hasSymbolPendingEntry === true || (input.state as any).hasSymbolPendingEntry === true)) {
            min_order_check_passed = false;
            min_order_block_reason = "PENDING_ORDER_EXISTS";
        } else if (riskSizing.isBlocked) {
            min_order_check_passed = false;
            min_order_block_reason = riskSizing.blockReason ?? "RISK_SIZING_BLOCKED";
        } else if (isLiveSignedOrderAttempt) {
            // Validate required order parameters without fallback (Requirement 2)
            const stopPriceVal = (riskSizing as any).stopPrice ?? (riskSizing as any).stop_price ?? (execution as any).stopPrice ?? (v2State as any).stopPrice;
            const invalidationPxVal = (riskSizing as any).invalidationPx ?? (execution as any).invalidationPx ?? stopPriceVal;
            const lastPx = input.snapshot.lastPrice;
            const sideCand = v2SideAfterPromotion;

            const levOk = typeof appliedLeverage === "number" && Number.isFinite(appliedLeverage) && appliedLeverage >= 1 && appliedLeverage <= 125;
            const stopOk = typeof stopPriceVal === "number" && Number.isFinite(stopPriceVal) && stopPriceVal > 0 &&
                (sideCand === "long" ? stopPriceVal < lastPx : stopPriceVal > lastPx);
            const invalidationOk = typeof invalidationPxVal === "number" && Number.isFinite(invalidationPxVal) && invalidationPxVal > 0 &&
                (sideCand === "long" ? invalidationPxVal < lastPx : invalidationPxVal > lastPx);

            if (!levOk || !stopOk || !invalidationOk) {
                min_order_check_passed = false;
                min_order_block_reason = "ORDER_BUILD_FAIL";
            }

            // Live Signed Order Attempt: exposure authority from OKX actual (+ pending), paper diagnostic only
            const pendingOrdersNotionalUsdt = (pendingOrdersNotionalRaw ?? 0) as number;
            const pendingSymbolNotionalUsdt = (pendingSymbolNotionalRaw ?? 0) as number;

            const exposureAuthority = resolveLiveExposureAuthority({
                symbol: String(input.symbol),
                okxPositions: validPositionsList,
                paperPositions: currentPositions,
                okxActualPositions: okxPositionsValid ? validPositionsList : null,
                pendingSymbolNotionalUsdt,
                pendingOrdersNotionalUsdt,
                isLiveAuthority: true
            });

            existingAccountNotionalUsdt = exposureAuthority.strategy_account_notional_usdt;
            existingSymbolNotionalUsdt = exposureAuthority.strategy_symbol_notional_usdt;

            const addOnPolicyMode =
                (v2State as any).addOnPolicyMode ??
                addOnPolicy?.addonMode ??
                "NONE";
            const isAdverseAddon = addOnPolicyMode === "CONFIRMED_ADVERSE_ADDON";
            const orderKind = !isAddOn
                ? "ENTRY"
                : isAdverseAddon
                  ? "ADVERSE_ADDON"
                  : "PYRAMIDING_ADDON";

            const effectiveStopPrice = stopOk
                ? stopPriceVal
                : invalidationOk
                  ? invalidationPxVal
                  : null;

            if (isAddOn) {
                if (currentAddonCount >= effectiveMaxAddonCount) {
                    min_order_check_passed = false;
                    min_order_block_reason = "MAX_ADDON_COUNT_EXCEEDED";
                } else if ((v2State as any).addOnPolicyAllowed === false) {
                    min_order_check_passed = false;
                    min_order_block_reason = (v2State as any).addOnPolicyReason ?? "ADDON_POLICY_FORBIDDEN";
                }
            }
            
            if (!Number.isFinite(existingSymbolNotionalUsdt) || !Number.isFinite(existingAccountNotionalUsdt)) {
                min_order_check_passed = false;
                min_order_block_reason = "EXPOSURE_CALCULATION_FAILED_NAN";
            }

            if (min_order_check_passed && accountEquityUsdt != null && availableBalanceUsdt != null) {
                const emergencyAbsoluteCapUsdt =
                    input.config.okxLiveEmergencyMaxOrderNotionalUsdt ?? null;
                const marginReserveRatio =
                    input.config.okxLiveMarginReserveRatio ?? 0.2;
                const instrumentSizing =
                    (v2State as any).okxInstrumentSizing ??
                    (input.state as any).okxInstrumentSizing ??
                    null;
                // V2 ENTRY: policyRequestedNotionalUsdt is null for non-addon entries.
                // Probe multiplier is evaluated and passed via entryProbeSizeMultiplier into evaluateEquityAdaptiveSizing.
                // Legacy probeCapNotionalUsdt (stageMarginKrwAfter-based absolute anchor) REMOVED.
                const policyRequestedNotional = isAddOn
                    ? (isAdverseAddon
                        ? ((v2State as any).requestedAddonNotionalUsdt ??
                            addOnPolicy?.requestedAddonNotionalUsdt ??
                            0)
                        : ((v2State as any).finalAddonNotionalUsdt ?? finalAddonNotionalUsdt ?? 0))
                    : null;
                const adverseRiskBudgetAllowedNotional = isAdverseAddon
                    ? (addOnPolicy?.requestedAddonNotionalUsdt ??
                        (addOnPolicy as any)?.riskProjection?.riskBudgetAllowedNotional ??
                        null)
                    : null;

                if (input.evaluationMode !== "diagnostic") {
                    console.info(JSON.stringify({
                        event: "V2_STRATEGY_EXPOSURE_AUTHORITY_PROOF",
                        symbol: String(input.symbol),
                        okx_total_account_notional_usdt: exposureAuthority.okx_account_notional_usdt,
                        okx_total_symbol_notional_usdt: exposureAuthority.okx_symbol_notional_usdt,
                        bot_strategy_account_notional_usdt: exposureAuthority.strategy_account_notional_usdt,
                        bot_strategy_symbol_notional_usdt: exposureAuthority.strategy_symbol_notional_usdt,
                        manual_position_notional_usdt: exposureAuthority.manual_position_notional_usdt,
                        operator_pending_notional_usdt: exposureAuthority.operator_pending_notional_usdt,
                        engine_owned_pending_notional_usdt: exposureAuthority.engine_owned_pending_notional_usdt,
                        available_balance_usdt: availableBalanceUsdt,
                        usable_available_margin_usdt: availableBalanceUsdt * (1 - marginReserveRatio),
                        account_cap_usdt: input.config.okxLiveMaxAccountNotionalUsdt ?? null,
                        symbol_cap_usdt: input.config.okxLiveMaxSymbolNotionalUsdt ?? null,
                        manual_exposure_excluded_from_strategy_cap: true
                    }));
                }

                const htfProbeSizeMultiplier =
                    judgment.polarityProbeEligible === true &&
                    judgment.htf_entry_policy === "PROBE_ONLY" &&
                    typeof judgment.htf_size_multiplier === "number" &&
                    judgment.htf_size_multiplier > 0 &&
                    judgment.htf_size_multiplier < 1
                        ? judgment.htf_size_multiplier
                        : undefined;

                // --- Probe multiplier decision (before evaluateEquityAdaptiveSizing) ---
                // Canonical order: risk notional → caps → probe → HTF → lot normalization → validation
                let entryProbeSizeMultiplier: number | null = null;
                let probeSizingSource = "NONE";
                if (!isAddOn) {
                    if (promotionReason === "V2_POLARITY_REVERSAL_MICRO_PROBE") {
                        entryProbeSizeMultiplier = 0.20;
                        probeSizingSource = "V2_POLARITY_REVERSAL_MICRO_PROBE";
                    } else if (promotionReason === "V2_RANGE_TREND_RECLAIM_MICRO_PROBE") {
                        entryProbeSizeMultiplier = 0.25;
                        probeSizingSource = "V2_RANGE_TREND_RECLAIM_MICRO_PROBE";
                    } else if (promotionReason === "CONTINUATION_MICRO_PROBE" && microProbeSizeCap != null) {
                        entryProbeSizeMultiplier = microProbeSizeCap;
                        probeSizingSource = "CONTINUATION_MICRO_PROBE";
                    } else if (isMicroProbe) {
                        entryProbeSizeMultiplier = 0.25;
                        probeSizingSource = "DEFAULT_MICRO_PROBE";
                    }
                    // FULL V2 ENTRY: entryProbeSizeMultiplier = null, probeSizingSource = "NONE" (no reduction)
                }

                const sizingResult = evaluateEquityAdaptiveSizing({
                    symbol: String(input.symbol),
                    side: sideCand === "short" ? "short" : "long",
                    orderKind,
                    accountEquityUsdt,
                    availableBalanceUsdt,
                    entryReferencePrice: lastPx,
                    effectiveStopPrice,
                    appliedLeverage,
                    entryQualityGrade: entryQualityGrade,
                    existingSymbolNotionalUsdt,
                    existingAccountNotionalUsdt,
                    policyRequestedNotionalUsdt: policyRequestedNotional,
                    adverseRiskBudgetAllowedNotional,
                    emergencyAbsoluteCapUsdt,
                    legacyStaticCapUsdt: maxOrderNotionalUsdt,
                    marginReserveRatio,
                    roundTripFeeRate: 0,
                    lastPrice: lastPx,
                    instrumentSizing,
                    htfSizeMultiplier: htfProbeSizeMultiplier,
                    externalSizeMultiplier:
                        externalMarketContext.externalContextApplied && !isAddOn
                            ? externalMarketContext.externalSizeMultiplier
                            : undefined,
                    v2AuthorityEntry: true,
                    entryProbeSizeMultiplier,
                    entryProbeSizingSource: probeSizingSource
                });

                equityAdaptiveSizingAuthority = sizingResult;

                if (input.evaluationMode !== "diagnostic") {
                    console.info(JSON.stringify(buildRiskBasedNotionalProof({
                        symbol: String(input.symbol),
                        equity_usdt: accountEquityUsdt,
                        risk_pct: sizingResult.riskPct,
                        risk_budget_usdt: sizingResult.riskBudgetUsdt,
                        entry_reference_price: lastPx,
                        effective_stop_price: effectiveStopPrice,
                        stop_distance_pct: sizingResult.stopDistancePct,
                        estimated_round_trip_fee_usdt: sizingResult.estimatedRoundTripFeeUsdt,
                        net_risk_budget_usdt: sizingResult.netRiskBudgetUsdt,
                        risk_based_notional_usdt: sizingResult.riskBasedNotionalUsdt,
                        applied_leverage: appliedLeverage,
                        estimated_margin_usdt: sizingResult.finalRequiredMarginUsdt
                    })));
                    console.info(JSON.stringify(buildMarginCapacityProof({
                        available_balance_usdt: availableBalanceUsdt,
                        margin_reserve_ratio: marginReserveRatio,
                        usable_available_balance_usdt: sizingResult.usableAvailableBalanceUsdt,
                        final_notional_usdt: sizingResult.finalOrderNotionalUsdt,
                        leverage: appliedLeverage,
                        required_margin_usdt: sizingResult.finalRequiredMarginUsdt,
                        margin_capacity_passed: sizingResult.marginCapacityPassed
                    })));
                    console.info(JSON.stringify(buildEquityAdaptiveSizingProof({
                        symbol: String(input.symbol),
                        equity_usdt: accountEquityUsdt,
                        risk_pct: sizingResult.riskPct,
                        quality_multiplier: sizingResult.qualityMultiplier,
                        risk_budget_usdt: sizingResult.riskBudgetUsdt,
                        stop_distance_pct: sizingResult.stopDistancePct,
                        risk_based_notional_usdt: sizingResult.riskBasedNotionalUsdt,
                        equity_initial_cap_usdt: sizingResult.equityInitialCapUsdt,
                        symbol_cap_usdt: sizingResult.symbolCapUsdt,
                        account_cap_usdt: sizingResult.accountCapUsdt,
                        existing_symbol_notional_usdt: existingSymbolNotionalUsdt,
                        existing_account_notional_usdt: existingAccountNotionalUsdt,
                        available_balance_cap_usdt: sizingResult.availableBalanceCapUsdt,
                        available_margin_cap_usdt: sizingResult.usableAvailableBalanceUsdt * appliedLeverage,
                        legacy_static_cap_usdt: sizingResult.legacyStaticCapUsdt,
                        emergency_cap_usdt: sizingResult.emergencyCapUsdt,
                        effective_live_cap_usdt: sizingResult.effectiveLiveCapUsdt,
                        ultimate_safety_cap_usdt: sizingResult.ultimateSafetyCapUsdt,
                        legacy_cap_source: sizingResult.legacyCapSource,
                        pre_probe_notional_usdt: sizingResult.preProbeNotionalUsdt,
                        pre_lot_notional_usdt: sizingResult.preLotNotionalUsdt,
                        probe_multiplier_applied: sizingResult.probeMultiplierApplied,
                        htf_size_multiplier_applied: sizingResult.htfSizeMultiplierApplied,
                        normalized_contracts: sizingResult.normalizedContracts,
                        normalized_notional_usdt: sizingResult.normalizedNotionalUsdt,
                        actual_risk_at_stop_usdt: sizingResult.actualRiskAtStopUsdt,
                        actual_risk_pct: sizingResult.actualRiskPct,
                        final_order_notional_usdt: sizingResult.finalOrderNotionalUsdt,
                        final_required_margin_usdt: sizingResult.finalRequiredMarginUsdt,
                        limiting_authority: sizingResult.limitingAuthority,
                        final_sizing_authority: sizingResult.finalSizingAuthority,
                        emergency_cap_applied: sizingResult.emergencyCapApplied,
                        emergency_cap_reason: sizingResult.emergencyCapReason,
                        v2_authority_entry: sizingResult.v2AuthorityEntryApplied === true,
                        sizing_passed: sizingResult.sizingPassed,
                        block_reason: sizingResult.blockReason
                    })));
                }

                if (!sizingResult.sizingPassed) {
                    min_order_check_passed = false;
                    min_order_block_reason = sizingResult.blockReason ?? "ORDER_BUILD_FAIL";
                } else {
                    requestedOrderNotionalUsdt = sizingResult.preLotNotionalUsdt;
                    finalOrderNotionalUsdt = sizingResult.finalOrderNotionalUsdt;

                    if (input.evaluationMode !== "diagnostic") {
                        console.info(JSON.stringify({
                            event: "V2_PROBE_SIZING_AUTHORITY_PROOF",
                            symbol: String(input.symbol),
                            is_micro_probe: isMicroProbe,
                            is_addon: isAddOn,
                            riskBasedNotionalUsdt: sizingResult.riskBasedNotionalUsdt,
                            equityInitialCapUsdt: sizingResult.equityInitialCapUsdt,
                            symbolCapUsdt: sizingResult.symbolCapUsdt,
                            accountCapUsdt: sizingResult.accountCapUsdt,
                            availableBalanceCapUsdt: sizingResult.availableBalanceCapUsdt,
                            cappedFullEntryNotionalUsdt: sizingResult.cappedFullEntryNotionalUsdt,
                            preProbeNotionalUsdt: sizingResult.preProbeNotionalUsdt,
                            probeMultiplierApplied: sizingResult.probeMultiplierApplied,
                            probeSizingSource: sizingResult.probeSizingSource,
                            probeAdjustedPreLotNotionalUsdt: sizingResult.probeAdjustedPreLotNotionalUsdt,
                            htfSizeMultiplierApplied: sizingResult.htfSizeMultiplierApplied,
                            preLotNotionalUsdt: sizingResult.preLotNotionalUsdt,
                            normalizedContracts: sizingResult.normalizedContracts,
                            normalizedNotionalUsdt: sizingResult.normalizedNotionalUsdt,
                            finalOrderNotionalUsdt,
                            finalRequiredMarginUsdt: sizingResult.finalRequiredMarginUsdt,
                            limitingAuthority: sizingResult.limitingAuthority,
                            finalSizingAuthority: sizingResult.finalSizingAuthority,
                            legacyStaticCapUsdt: sizingResult.legacyStaticCapUsdt,
                            emergencyCapUsdt: sizingResult.emergencyCapUsdt,
                            effectiveLiveCapUsdt: sizingResult.effectiveLiveCapUsdt,
                            emergencyCapApplied: sizingResult.emergencyCapApplied,
                            emergencyCapReason: sizingResult.emergencyCapReason,
                            v2AuthorityEntry: sizingResult.v2AuthorityEntryApplied === true,
                            legacyAbsoluteProbeCapApplied: false
                        }));
                    }

                    const projectedSymbolNotionalUsdt = existingSymbolNotionalUsdt + finalOrderNotionalUsdt;
                    const projectedAccountNotionalUsdt = existingAccountNotionalUsdt + finalOrderNotionalUsdt;

                    if (!Number.isFinite(projectedSymbolNotionalUsdt) || !Number.isFinite(projectedAccountNotionalUsdt)) {
                        min_order_check_passed = false;
                        min_order_block_reason = "EXPOSURE_CALCULATION_FAILED_NAN";
                    }

                    const capPassed =
                        projectedSymbolNotionalUsdt <= sizingResult.symbolCapUsdt + 1e-6 &&
                        projectedAccountNotionalUsdt <= sizingResult.accountCapUsdt + 1e-6;

                    if (input.evaluationMode !== "diagnostic") {
                        emitLiveExposureAuthorityProof((payload) => console.info(JSON.stringify(payload)), {
                            symbol: String(input.symbol),
                            exposure: exposureAuthority,
                            is_addon: isAddOn,
                            requested_order_notional_usdt: requestedOrderNotionalUsdt,
                            projected_symbol_notional_usdt: projectedSymbolNotionalUsdt,
                            projected_account_notional_usdt: projectedAccountNotionalUsdt,
                            max_symbol_notional_usdt: sizingResult.symbolCapUsdt,
                            max_account_notional_usdt: sizingResult.accountCapUsdt,
                            cap_passed: capPassed
                        });
                    }

                    if (finalOrderNotionalUsdt < 1.0) {
                        min_order_check_passed = false;
                        min_order_block_reason = "ORDER_BUILD_FAIL";
                    }

                    // --- Canonical Pre-Entry TP Profitability Authority ---
                    // Invariant: Read-only evaluation. NEVER modifies TP1/TP2 or SL prices.
                    // Blocks entry if structural TP1 distance < minimumProfitableTpPct (V2_TP1_NET_EDGE_INSUFFICIENT)
                    // Blocks entry if cost authority is invalid (V2_TP_PROFITABILITY_COST_AUTHORITY_INVALID)
                    if (min_order_check_passed && finalDecision === "ENTER" && !isAddOn) {
                        const execMetaRec = execMeta as Record<string, any>;
                        const execMetaRaw = (execution.metadata as Record<string, any>) ?? {};
                        const sideForTp = sideCand === "short" ? "short" : "long";
                        const rawStructuralSl =
                            typeof invalidationPxVal === "number" && Number.isFinite(invalidationPxVal) && invalidationPxVal > 0
                                ? invalidationPxVal
                                : stopOk && typeof stopPriceVal === "number"
                                  ? stopPriceVal
                                  : 0;
                        const rawPolicySlPrice = resolvePreEntryPolicySlPrice({
                            side: sideForTp,
                            regime: String(judgment.regime),
                            entryPrice: lastPx,
                            rawStructuralSl
                        });
                        const snapshotTickSz =
                            typeof (authoritativeInput.snapshot as { tickSz?: number }).tickSz === "number"
                                ? (authoritativeInput.snapshot as { tickSz?: number }).tickSz
                                : typeof (input.snapshot as { tickSz?: number }).tickSz === "number"
                                  ? (input.snapshot as { tickSz?: number }).tickSz
                                  : null;
                        const instrumentTickSz =
                            typeof (input.state as { instrumentTickSz?: number }).instrumentTickSz === "number"
                                ? (input.state as { instrumentTickSz?: number }).instrumentTickSz
                                : typeof (v2State as { instrumentTickSz?: number }).instrumentTickSz === "number"
                                  ? (v2State as { instrumentTickSz?: number }).instrumentTickSz
                                  : null;
                        const slippageBps =
                            typeof (authoritativeInput.config as any)?.paperSlippageEstimateBps === "number"
                                ? (authoritativeInput.config as any).paperSlippageEstimateBps
                                : typeof (input.config as any)?.paperSlippageEstimateBps === "number"
                                  ? (input.config as any).paperSlippageEstimateBps
                                  : 8;
                        const isExplicitMicroProbe =
                            isMicroProbe === true ||
                            promotionReason === "V2_RANGE_TREND_RECLAIM_MICRO_PROBE" ||
                            promotionReason === "V2_POLARITY_REVERSAL_MICRO_PROBE" ||
                            (promotionReason === "CONTINUATION_MICRO_PROBE" && microProbeSizeCap === 0.25);

                        const currentBoxPos =
                            typeof authoritativeInput.snapshot?.boxPos === "number"
                                ? authoritativeInput.snapshot.boxPos
                                : typeof input.snapshot?.boxPos === "number"
                                  ? input.snapshot.boxPos
                                  : null;

                        const htfBiasesMap = {
                            htf_1h_bias: (judgment.diagnostics as any)?.htf_1h_bias ?? (judgment as any).htf_1h_bias ?? (v2State as any).htf_1h_bias ?? null,
                            htf_4h_bias: (judgment.diagnostics as any)?.htf_4h_bias ?? (judgment as any).htf_4h_bias ?? (v2State as any).htf_4h_bias ?? null,
                            htf_1d_bias: (judgment.diagnostics as any)?.htf_1d_bias ?? (judgment as any).htf_1d_bias ?? (v2State as any).htf_1d_bias ?? null
                        };

                        const tpBundle = resolveV2PreEntryExecutableTpBundle({
                            side: sideForTp,
                            regime: String(judgment.regime),
                            entryPrice: lastPx,
                            rawStructuralSl,
                            rawPolicySlPrice,
                            execMetaTakeProfitPlanTp1:
                                typeof execMetaRec?.takeProfitPlan?.tp1 === "number"
                                    ? execMetaRec.takeProfitPlan.tp1
                                    : typeof execMetaRaw?.takeProfitPlan?.tp1 === "number"
                                      ? execMetaRaw.takeProfitPlan.tp1
                                      : null,
                            execMetaTakeProfit1Px:
                                typeof execMetaRec?.takeProfit1Px === "number"
                                    ? execMetaRec.takeProfit1Px
                                    : typeof execMetaRaw?.takeProfit1Px === "number"
                                      ? execMetaRaw.takeProfit1Px
                                      : null,
                            marketSubtype: judgment.subtype ?? null,
                            routingEngine: activeEngineRouting ?? null,
                            atr:
                                typeof authoritativeInput.snapshot?.atr === "number"
                                    ? authoritativeInput.snapshot.atr
                                    : typeof input.snapshot?.atr === "number"
                                      ? input.snapshot.atr
                                      : null,
                            boxHigh:
                                typeof authoritativeInput.snapshot?.boxHigh === "number"
                                    ? authoritativeInput.snapshot.boxHigh
                                    : typeof input.snapshot?.boxHigh === "number"
                                      ? input.snapshot.boxHigh
                                      : null,
                            boxLow:
                                typeof authoritativeInput.snapshot?.boxLow === "number"
                                    ? authoritativeInput.snapshot.boxLow
                                    : typeof input.snapshot?.boxLow === "number"
                                      ? input.snapshot.boxLow
                                      : null,
                            boxMid:
                                typeof execMetaRec?.rangeBoxMidAtEntry === "number"
                                    ? execMetaRec.rangeBoxMidAtEntry
                                    : (() => {
                                          const hi =
                                              typeof authoritativeInput.snapshot?.boxHigh === "number"
                                                  ? authoritativeInput.snapshot.boxHigh
                                                  : input.snapshot?.boxHigh;
                                          const lo =
                                              typeof authoritativeInput.snapshot?.boxLow === "number"
                                                  ? authoritativeInput.snapshot.boxLow
                                                  : input.snapshot?.boxLow;
                                          return typeof hi === "number" && typeof lo === "number" ? (hi + lo) / 2 : null;
                                      })(),
                            feeRate: Number(authoritativeInput.config.paperTakerFeeRate ?? input.config.paperTakerFeeRate ?? 0.0005),
                            preserveCanonicalStructuralStop:
                                judgment.subtype === "FAST_TREND_SHIFT" ||
                                execMetaRec.fast_trend_shift === true,
                            promotionReason,
                            symbol: String(input.symbol),
                            paperSlippageEstimateBps: slippageBps,
                            instrumentTickSz,
                            snapshotTickSz,
                            isExplicitMicroProbe,
                            probeMultiplier: entryProbeSizeMultiplier,
                            boxPos: currentBoxPos,
                            htfBiases: htfBiasesMap,
                            hasHardBlock: hardBlockPresent === true,
                            htfVetoPassed: judgment.htf_entry_policy === "ALLOW" || judgment.htf_entry_policy === "PROBE_ONLY",
                            rangeTrendConflictPassed: (judgment as any).side_veto_detail !== "RANGE_TREND_SIDE_CONFLICT",
                            chaseGatePassed: (currentBoxPos == null || currentBoxPos <= 0.65),
                            htf_candles: authoritativeInput.snapshot?.htf_candles ?? input.snapshot?.htf_candles ?? (authoritativeInput as any).htf_candles ?? (input as any).htf_candles,
                            candles: authoritativeInput.snapshot?.candles ?? input.snapshot?.candles
                        });

                        if (!tpBundle.ok) {
                            min_order_check_passed = false;
                            min_order_block_reason = tpBundle.blockReason ?? "V2_TP_PROFITABILITY_COST_AUTHORITY_INVALID";
                        } else {
                            const canonicalTp2PriceCandidate =
                                typeof execMetaRec?.takeProfitPlan?.tp2 === "number"
                                    ? execMetaRec.takeProfitPlan.tp2
                                    : typeof execMetaRaw?.takeProfitPlan?.tp2 === "number"
                                      ? execMetaRaw.takeProfitPlan.tp2
                                      : typeof execMetaRec?.takeProfit2Px === "number"
                                        ? execMetaRec.takeProfit2Px
                                        : typeof execMetaRaw?.takeProfit2Px === "number"
                                          ? execMetaRaw.takeProfit2Px
                                          : (tpBundle.rawCanonicalTp1Price != null && lastPx > 0
                                              ? (sideForTp === "long" ? lastPx + (tpBundle.rawCanonicalTp1Price - lastPx) * 1.8 : lastPx - (lastPx - tpBundle.rawCanonicalTp1Price) * 1.8)
                                              : null);

                            const tpProfitabilityResult = evaluateTpProfitabilityAuthority({
                                symbol: String(input.symbol),
                                side: sideForTp,
                                regime: String(judgment.regime),
                                entryPrice: lastPx,
                                canonicalTp1Price: tpBundle.rawCanonicalTp1Price,
                                canonicalTp1Source: tpBundle.canonicalTp1Source,
                                canonicalTp2Price: canonicalTp2PriceCandidate,
                                feeRate: Number(authoritativeInput.config.paperTakerFeeRate ?? input.config.paperTakerFeeRate ?? 0.0005),
                                paperSlippageEstimateBps: slippageBps,
                                tickSz: tpBundle.tpTickSize,
                                isExplicitMicroProbe,
                                probeMultiplier: entryProbeSizeMultiplier,
                                boxPos: currentBoxPos,
                                htfBiases: htfBiasesMap,
                                hasHardBlock: hardBlockPresent === true,
                                htfVetoPassed: judgment.htf_entry_policy === "ALLOW" || judgment.htf_entry_policy === "PROBE_ONLY",
                                rangeTrendConflictPassed: (judgment as any).side_veto_detail !== "RANGE_TREND_SIDE_CONFLICT",
                                chaseGatePassed: (currentBoxPos == null || currentBoxPos <= 0.65)
                            });

                            if (input.evaluationMode !== "diagnostic") {
                                console.info(JSON.stringify(tpProfitabilityResult));
                            }

                            if (!tpProfitabilityResult.entryAllowed) {
                                min_order_check_passed = false;
                                min_order_block_reason = tpProfitabilityResult.blockReason ?? "V2_TP1_NET_EDGE_INSUFFICIENT";
                            } else if (
                                tpProfitabilityResult.executableTp1Price !== tpBundle.executableTp1Price ||
                                tpProfitabilityResult.rawCanonicalTp1Price !== tpBundle.rawCanonicalTp1Price
                            ) {
                                min_order_check_passed = false;
                                min_order_block_reason = "V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE";
                            } else {
                                (execMeta as any).takeProfit1Px = tpBundle.executableTp1Price;
                                (execMeta as any).takeProfitPlan = {
                                    ...(typeof (execMeta as any).takeProfitPlan === "object" && (execMeta as any).takeProfitPlan != null ? (execMeta as any).takeProfitPlan : {}),
                                    tp1: tpBundle.rawCanonicalTp1Price,
                                    executableTp1: tpBundle.executableTp1Price
                                };
                                (execMeta as any).canonicalTp1Source = tpBundle.canonicalTp1Source;
                                (execMeta as any).tpSource = tpBundle.tpSource;
                                (execMeta as any).executableTp1Price = tpBundle.executableTp1Price;
                                (execMeta as any).rawCanonicalTp1Price = tpBundle.rawCanonicalTp1Price;
                                (execMeta as any).profitabilityTpApproved = true;
                            }
                        }
                    }
                }
            }
        }

        if (!min_order_check_passed) {
            finalDecision = "REJECT";
            v2DecisionAfterPromotion = "REJECT";
            v2SideAfterPromotion = "none";
            riskSizing.isBlocked = true;
            riskSizing.blockReason = min_order_block_reason;
            riskSizing.stageMarginKrw = 0;
            stageMarginKrwAfter = 0;
            blockReason = min_order_block_reason;
        } else if (isLiveSignedOrderAttempt) {
            stageMarginKrwAfter = Math.round((finalOrderNotionalUsdt / appliedLeverage) * 1400);
            riskSizing.stageMarginKrw = stageMarginKrwAfter;
        }
    }

    // Required Proof Log: LIVE_ORDER_SIZING_AUTHORITY_PROOF
    if (input.evaluationMode !== "diagnostic") {
        const liveCapProof = resolveUltimateSafetyCapForOrderSizing({
            v2AuthorityEntry: true,
            emergencyCapUsdt: input.config.okxLiveEmergencyMaxOrderNotionalUsdt ?? null,
            legacyStaticCapUsdt: maxOrderNotionalUsdt ?? null
        });
        console.info(JSON.stringify({
            event: "LIVE_ORDER_SIZING_AUTHORITY_PROOF",
            symbol: String(input.symbol),
            evaluation_mode: input.evaluationMode ?? "authoritative",
            accountEquityUsdt,
            availableBalanceUsdt,
            existingAccountNotionalUsdt,
            existingSymbolNotionalUsdt,
            requestedOrderNotionalUsdt,
            finalOrderNotionalUsdt,
            risk_per_trade_pct: RISK_PER_TRADE_PCT,
            equity_initial_cap_usdt: accountEquityUsdt != null ? accountEquityUsdt * MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE : null,
            symbol_cap_usdt: accountEquityUsdt != null ? accountEquityUsdt * MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE : null,
            account_cap_usdt: accountEquityUsdt != null ? accountEquityUsdt * MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE : null,
            legacy_static_cap_usdt: liveCapProof.legacyStaticCapUsdt,
            emergency_cap_usdt: liveCapProof.emergencyCapUsdt,
            effective_live_cap_usdt: liveCapProof.effectiveLiveCapUsdt,
            ultimate_safety_cap_usdt: liveCapProof.effectiveLiveCapUsdt,
            limiting_authority: equityAdaptiveSizingAuthority?.limitingAuthority ?? null,
            final_sizing_authority: equityAdaptiveSizingAuthority?.finalSizingAuthority ?? null,
            emergency_cap_applied: equityAdaptiveSizingAuthority?.emergencyCapApplied ?? false,
            emergency_cap_reason: equityAdaptiveSizingAuthority?.emergencyCapReason ?? null,
            v2_authority_entry: true,
            currentAddonCount,
            isAddon: isAddOn,
            blocked: finalDecision !== "ENTER",
            blockReason: blockReason ?? null
        }));
    }

    if (isDeadlockProbe && finalDecision !== "ENTER") {
        console.warn(JSON.stringify({
            event: "V2_DEADLOCK_PROBE_BLOCKED_PROOF",
            symbol: String(input.symbol),
            candidateSide: repeatedCandidateSide,
            blockedReason: min_order_block_reason || riskSizing.blockReason || "MIN_ORDER_SIZE_UNDERFLOW",
            htfPolicy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
            hardBlockReason: min_order_block_reason || riskSizing.blockReason,
            stopPrice: execution.stopPrice,
            qualityScore,
            sideZoneValid
        }));
        isDeadlockProbe = false;
        promotedDecision = null;
        promotedSide = "none";
    }


    if (!riskSizing.diagnostics) {
        (riskSizing as { diagnostics?: import("./types").RiskSizingDiagnostics }).diagnostics = {};
    }

    // 理쒖쥌 諛섏쁺??decision怨?margin??authority envelope??李몄“?섎룄濡?diagnostics 媛깆떊
    riskSizing.diagnostics!.original_v2_decision = finalDecision;
    riskSizing.diagnostics!.original_v2_side = v2SideAfterPromotion != null ? String(v2SideAfterPromotion) : undefined;
    riskSizing.diagnostics!.original_stage_margin_krw = stageMarginKrwAfter;

    if (promotionApplied || min_order_block_reason != null) {
        console.info(JSON.stringify({
            event: "V2_PROMOTION_STATE_COMMIT_PROOF",
            symbol: String(input.symbol),
            decision_before: v2DecisionBeforePromotion,
            side_before: v2SideBeforePromotion,
            decision_after: finalDecision,
            side_after: v2SideAfterPromotion,
            block_reason: blockReason,
            stage_margin_krw_after: stageMarginKrwAfter,
            is_micro_probe: isMicroProbe,
            promotion_reason: promotionReason,
            raw_env_OKX_LIVE_MAX_ORDER_NOTIONAL_USDT: rawEnvLiveMaxNotionalUsdt,
            live_max_notional_source: liveMaxNotionalSource,
            legacy_max_order_notional_usdt: maxOrderNotionalUsdt,
            legacy_max_addon_notional_usdt: maxAddonNotionalUsdt,
            legacy_max_symbol_notional_usdt: maxSymbolNotionalUsdt,
            legacy_max_account_notional_usdt: maxAccountNotionalUsdt,
            final_order_notional_usdt: finalOrderNotionalUsdt,
            applied_leverage: appliedLeverage,
            leverage_source: leverageSource,
            leverage_reason: leverageReason,
            cap_kind: cap_kind ?? "equity_adaptive_sizing",
            min_margin_krw_required: minProbeMarginKrw,
            cap_applied: cap_applied ?? false,
            cap_reason: cap_reason ?? null,
            min_order_check_passed,
            min_order_block_reason
        }));
    }

    if (finalDecision === "ENTER" || min_order_block_reason != null) {
        console.info(JSON.stringify({
            event: "LIVE_ORDER_SIZE_PROOF",
            symbol: String(input.symbol),
            decision: finalDecision,
            side: v2SideAfterPromotion,
            promotion_reason: promotionReason,
            stage_margin_krw_before: stageMarginKrwBefore,
            stage_margin_krw_after: stageMarginKrwAfter,
            is_micro_probe: isMicroProbe,
            raw_env_OKX_LIVE_MAX_ORDER_NOTIONAL_USDT: rawEnvLiveMaxNotionalUsdt,
            live_max_notional_source: liveMaxNotionalSource,
            order_size_authority: "risk.finalOrderNotionalUsdt",
            legacy_max_order_notional_usdt: maxOrderNotionalUsdt,
            legacy_max_addon_notional_usdt: maxAddonNotionalUsdt,
            legacy_max_symbol_notional_usdt: maxSymbolNotionalUsdt,
            legacy_max_account_notional_usdt: maxAccountNotionalUsdt,
            equity_adaptive_risk_pct: equityAdaptiveSizingAuthority?.riskPct ?? null,
            equity_adaptive_initial_cap_usdt: equityAdaptiveSizingAuthority?.equityInitialCapUsdt ?? null,
            equity_adaptive_symbol_cap_usdt: equityAdaptiveSizingAuthority?.symbolCapUsdt ?? null,
            equity_adaptive_account_cap_usdt: equityAdaptiveSizingAuthority?.accountCapUsdt ?? null,
            final_order_notional_usdt: finalOrderNotionalUsdt,
            applied_leverage: appliedLeverage,
            leverage_source: leverageSource,
            leverage_reason: leverageReason,
            cap_kind: cap_kind ?? "equity_adaptive_sizing",
            min_margin_krw_required: minProbeMarginKrw,
            cap_applied: cap_applied ?? false,
            cap_reason: cap_reason ?? null,
            min_order_check_passed,
            min_order_block_reason,
            side_zone_valid: sideZoneValid,
            range_edge_extreme: rangeEdgeExtreme,
            reversal_confirmed: reversalConfirmed
        }));
        if (promotionReason === "V2_RANGE_MID_MICRO_PROBE_CONFIRMED") {
            console.info(JSON.stringify({
                event: "V2_RANGE_MID_MICRO_PROBE_PROOF",
                symbol: String(input.symbol),
                market_subtype: judgment.subtype,
                rangeConfidence,
                boxPos,
                zone,
                trendSideCandidate,
                qualityScore,
                trendOk,
                paperExecutionReady,
                signedExecutionReady,
                hardBlockPresent,
                hardControlClear,
                decision_before: v2DecisionBeforePromotion,
                decision_after: finalDecision,
                side_after: v2SideAfterPromotion,
                stageMarginKrwBefore: riskSizing.stageMarginKrw,
                stageMarginKrwAfter: stageMarginKrwAfter,
                promotionReason
            }));
        }

        if (promotionReason === "V2_PROBE_ENTRY_CONFIRM_PROOF" || promotionReason === "V2_PROBE_ENTRY_CONFIRMED") {
            console.info(JSON.stringify({
                event: "V2_PROBE_ENTRY_CONFIRM_PROOF",
                symbol: String(input.symbol),
                shock,
                trendSideCandidate,
                decision_before: v2DecisionBeforePromotion,
                decision_after: finalDecision,
                side_after: v2SideAfterPromotion,
                qualityScore,
                trendOk,
                emaGap,
                trendWeaknessScore,
                paperExecutionReady,
                signedExecutionReady,
                hardBlockPresent,
                hardControlClear,
                stageMarginKrwBefore: riskSizing.stageMarginKrw,
                stageMarginKrwAfter: stageMarginKrwAfter,
                promotionReason
            }));
        }
    }

    let microExecution: MicroExecutionScoreSummary | null = null;
    let lifecycleAuthority: V2TradeLifecycleAuthorityResult | null = null;
    let v2ExitAuthority: V2ExitAuthorityResult | null = null;
    let v2PartialAuthority: V2PartialAuthorityResult | null = null;
    let v2CooldownAuthority: V2CooldownAuthorityResult | null = null;
    let v2PositionStateAuthority: V2PositionStateAuthorityResult | null = null;
    const exitActionMap: Record<string, V2ExitAuthorityResult["exitAction"]> = {
        HOLD: "none",
        WATCH: "watch",
        PARTIAL_TAKE_PROFIT: "partial_candidate",
        REDUCE: "partial_candidate",
        FULL_EXIT: "exit"
    };
    const exitUrgencyMap: Record<string, V2ExitAuthorityResult["exitUrgency"]> = {
        LOW: "low",
        MID: "medium",
        HIGH: "high",
        CRITICAL: "emergency"
    };
    const exitTrueInconsistencyReasons: string[] = [];
    const exitKnownShadowGaps: string[] = ["EXIT_EXECUTION_OWNER_NOT_V2"];
    const exitProofReasons = [
        `exit_policy_action:${exitPolicy.action}`,
        `exit_policy_reason:${exitPolicy.reason}`,
        `exit_policy_evidence:${exitPolicy.evidence}`
    ];
    v2ExitAuthority = {
        symbol: String(input.symbol),
        side: exitPolicy.positionSide === "none" ? "none" : exitPolicy.positionSide,
        exitAuthorityOwner: "v2",
        exitExecutionOwner: "paper_engine",
        exitAction: exitActionMap[exitPolicy.action] ?? "none",
        shouldExit: exitPolicy.shouldExit === true,
        exitReason: exitPolicy.hasPosition ? exitPolicy.reason : null,
        exitUrgency: exitUrgencyMap[exitPolicy.exitUrgency] ?? "none",
        exitConfidence: exitPolicy.exitConfidence,
        reduceRatio: exitPolicy.reduceRatio > 0 ? exitPolicy.reduceRatio : null,
        proofReasons: exitProofReasons,
        trueInconsistencyReasons: exitTrueInconsistencyReasons,
        knownShadowGaps: exitKnownShadowGaps
    };
    const partialActionMap: Record<string, V2PartialAuthorityResult["partialAction"]> = {
        HOLD: "none",
        WATCH: "watch",
        PARTIAL_TAKE_PROFIT: "protect_profit",
        REDUCE: "reduce_candidate",
        FULL_EXIT: "none"
    };
    const partialUrgencyMap: Record<string, V2PartialAuthorityResult["partialUrgency"]> = {
        LOW: "low",
        MID: "medium",
        HIGH: "high",
        CRITICAL: "high"
    };
    const partialProofReasons = [
        `exit_policy_action:${exitPolicy.action}`,
        `exit_policy_should_partial:${exitPolicy.shouldPartial}`,
        `exit_policy_should_reduce:${exitPolicy.shouldReduce}`,
        `exit_policy_reason:${exitPolicy.reason}`
    ];
    v2PartialAuthority = {
        symbol: String(input.symbol),
        side: exitPolicy.positionSide === "none" ? "none" : exitPolicy.positionSide,
        partialAuthorityOwner: "v2",
        partialExecutionOwner: "paper_engine",
        partialAction: partialActionMap[exitPolicy.action] ?? "none",
        shouldPartial: exitPolicy.shouldPartial === true || exitPolicy.shouldReduce === true,
        shouldReduce: exitPolicy.shouldReduce === true,
        partialReason: exitPolicy.hasPosition ? exitPolicy.reason : null,
        partialUrgency:
            (exitPolicy.shouldPartial === true || exitPolicy.shouldReduce === true)
                ? (partialUrgencyMap[exitPolicy.exitUrgency] ?? "none")
                : "none",
        partialConfidence:
            (exitPolicy.shouldPartial === true || exitPolicy.shouldReduce === true)
                ? exitPolicy.exitConfidence
                : Math.max(0, Math.min(1, exitPolicy.exitConfidence * 0.6)),
        reduceRatio: exitPolicy.reduceRatio > 0 ? exitPolicy.reduceRatio : null,
        proofReasons: partialProofReasons,
        trueInconsistencyReasons: [],
        knownShadowGaps: ["PARTIAL_EXECUTION_OWNER_NOT_V2"]
    };
    if (
        exitPolicy.hasPosition &&
        shouldEmitV2Proof(
            "V2_PARTIAL_AUTHORITY_STATE_PROOF",
            String(input.symbol),
            `${v2PartialAuthority.partialAction}|${v2PartialAuthority.partialReason}|${v2PartialAuthority.partialUrgency}|${v2PartialAuthority.reduceRatio ?? 0}`,
            v2PartialAuthority.trueInconsistencyReasons.length > 0
        )
    ) {
        console.info(JSON.stringify({
            event: "V2_PARTIAL_AUTHORITY_STATE_PROOF",
            symbol: String(input.symbol),
            side: v2PartialAuthority.side,
            partial_authority_owner: v2PartialAuthority.partialAuthorityOwner,
            partial_execution_owner: v2PartialAuthority.partialExecutionOwner,
            v2_partial_action: v2PartialAuthority.partialAction,
            v2_should_partial: v2PartialAuthority.shouldPartial,
            v2_partial_reason: v2PartialAuthority.partialReason,
            v2_partial_urgency: v2PartialAuthority.partialUrgency,
            v2_partial_confidence: v2PartialAuthority.partialConfidence,
            v2_reduce_ratio: v2PartialAuthority.reduceRatio,
            known_shadow_gaps: v2PartialAuthority.knownShadowGaps,
            true_inconsistency_reasons: v2PartialAuthority.trueInconsistencyReasons,
            proof_reasons: v2PartialAuthority.proofReasons
        }));
    }
    if (finalDecision === "ENTER") {
        finalReason = promotionReason ?? explanation.reason;
    } else if (finalDecision === "HOLD" && promotionApplied) {
        finalReason = `HOLD: ${promotionReason ?? "WAIT_RECHECK"}`;
    }

    const isV2EnterCandidate =
        finalDecision === "ENTER" &&
        (v2SideAfterPromotion === "long" || v2SideAfterPromotion === "short");
    if (isV2EnterCandidate) {
        const microStartedAt = Date.now();
        try {
            const rawDataFreshness = Number((judgment.metrics as Record<string, unknown>).dataFreshnessMs);
            const dataFreshnessMs =
                Number.isFinite(rawDataFreshness) && rawDataFreshness >= 0 ? rawDataFreshness : null;
            microExecution = deriveMicroExecutionScore({
                symbol: String(input.symbol),
                side: v2SideAfterPromotion,
                regime: judgment.regime,
                v2Decision: finalDecision,
                lastPrice: input.snapshot.lastPrice,
                volatilityProxy: Math.max(0, input.snapshot.volatilityProxy ?? 0),
                rangeConfidence: Math.max(0, input.snapshot.rangeConfidence ?? 0),
                breakoutFailureRate: Math.max(0, input.snapshot.breakoutFailureRate ?? 0),
                trendWeaknessScore: Math.max(0, input.snapshot.trendWeaknessScore ?? 0),
                qualityScore: Math.max(0, input.snapshot.qualityScore ?? 0),
                dataFreshnessMs
            });
        } catch {
            microExecution = deriveMicroExecutionScore({
                symbol: String(input.symbol),
                side: v2SideAfterPromotion,
                regime: judgment.regime,
                v2Decision: finalDecision,
                lastPrice: 0,
                volatilityProxy: 0,
                rangeConfidence: 0,
                breakoutFailureRate: 0,
                trendWeaknessScore: 0,
                qualityScore: 0,
                dataFreshnessMs: null
            });
        }
        const calcMs = Date.now() - microStartedAt;
        microPerfStats.calculatedCount += 1;
        microPerfStats.totalCalcMs += calcMs;
        microPerfStats.maxCalcMs = Math.max(microPerfStats.maxCalcMs, calcMs);
        if (microExecution.fallbackNeutral) microPerfStats.fallbackNeutralCount += 1;
        if (microExecution.usedOrderbook) microPerfStats.usedOrderbookCount += 1;
        if (microExecution.usedRecentTrades) microPerfStats.usedRecentTradesCount += 1;

        const microProofKey = [
            finalDecision,
            v2SideAfterPromotion,
            microExecution.score,
            microExecution.grade,
            microExecution.deferOnce,
            microExecution.hardBlockReason ?? "NONE"
        ].join("|");
        if (shouldEmitV2Proof("MICRO_EXECUTION_SCORE_PROOF", String(input.symbol), microProofKey, false)) {
            console.info(JSON.stringify({
                event: "MICRO_EXECUTION_SCORE_PROOF",
                symbol: String(input.symbol),
                side: v2SideAfterPromotion,
                regime: judgment.regime,
                v2_decision: finalDecision,
                score: microExecution.score,
                grade: microExecution.grade,
                sizeMultiplier: microExecution.sizeMultiplier,
                delayMs: microExecution.delayMs,
                deferOnce: microExecution.deferOnce,
                hardBlockReason: microExecution.hardBlockReason,
                reasons: microExecution.reasons,
                dataFreshnessMs: microExecution.dataFreshnessMs,
                usedOrderbook: microExecution.usedOrderbook,
                usedRecentTrades: microExecution.usedRecentTrades,
                fallbackNeutral: microExecution.fallbackNeutral,
                authority_source: microExecution.authoritySource
            }));
        }
        const shouldEmitCountSummary = microPerfStats.calculatedCount % 25 === 0;
        const shouldEmitTimeSummary =
            Date.now() - microPerfStats.lastLoggedAtMs >= MICRO_EXECUTION_PERF_LOG_INTERVAL_MS;
        if (shouldEmitCountSummary || shouldEmitTimeSummary) {
            const avgCalcMs = microPerfStats.calculatedCount > 0
                ? Number((microPerfStats.totalCalcMs / microPerfStats.calculatedCount).toFixed(3))
                : 0;
            const fallbackNeutralRate = microPerfStats.calculatedCount > 0
                ? Number((microPerfStats.fallbackNeutralCount / microPerfStats.calculatedCount).toFixed(4))
                : 0;
            console.info(JSON.stringify({
                event: "MICRO_EXECUTION_PERF_PROOF",
                calculatedCount: microPerfStats.calculatedCount,
                avgCalcMs,
                maxCalcMs: microPerfStats.maxCalcMs,
                fallbackNeutralCount: microPerfStats.fallbackNeutralCount,
                fallbackNeutralRate,
                usedOrderbookCount: microPerfStats.usedOrderbookCount,
                usedRecentTradesCount: microPerfStats.usedRecentTradesCount,
                appliedCount: microPerfStats.appliedCount,
                deferredCount: microPerfStats.deferredCount,
                sizeReducedCount: microPerfStats.sizeReducedCount,
                hardBlockedCount: microPerfStats.hardBlockedCount
            }));
            microPerfStats.lastLoggedAtMs = Date.now();
        }
    }

    const sameSidePosition_latest =
        v2SideAfterPromotion === "long" ? v2State.longPosition
            : v2SideAfterPromotion === "short" ? v2State.shortPosition
                : null;
    const heldPosition = v2State.longPosition ?? v2State.shortPosition ?? null;
    const lifecyclePosition_latest = sameSidePosition_latest ?? heldPosition;
    const lifecycleSide: EngineV2Side =
        lifecyclePosition_latest != null
            ? (String(lifecyclePosition_latest.side).toUpperCase() === "LONG" ? "long" : "short")
            : (v2SideAfterPromotion !== "none" && v2SideAfterPromotion != null)
                ? v2SideAfterPromotion
                : "none";

    let finalLifecycleSide = lifecycleSide;
    if (String(input.symbol) === "BTCUSDT") {
        const hasPaperLong = v2State.longPosition != null || (Array.isArray(input.state.currentPositions) &&
            input.state.currentPositions.some(p => p && p.symbol === "BTCUSDT" && String(p.side).toLowerCase() === "long"));
        const okxActualSide = input.state.okxActualSide;
        if (hasPaperLong && okxActualSide === "long") {
            finalLifecycleSide = "long";
        }
    }

    const hasLifecycleCandidate =
        lifecyclePosition_latest != null ||
        finalDecision === "ENTER" ||
        riskSizing.blockReason != null;

    if (lifecyclePosition_latest != null) {
        const currentPnlPct = lifecyclePosition_latest.pnlPct;
        const currentPnlUsd = lifecyclePosition_latest.sizeUsd * currentPnlPct;
        const oldPeakPct = lifecyclePosition_latest.peakUnrealizedPnlPct ?? -Infinity;
        const isNewPeak = currentPnlPct > oldPeakPct || lifecyclePosition_latest.peakUnrealizedPnlPct == null;

        if (isNewPeak) {
            lifecyclePosition_latest.peakUnrealizedPnlPct = currentPnlPct;
            lifecyclePosition_latest.peakUnrealizedPnlUsd = currentPnlUsd;
            lifecyclePosition_latest.peakPnlUpdatedAt = Date.now();
        }

        if (shouldEmitV2Proof("V2_TREND_PEAK_PNL_TRACK_PROOF", String(input.symbol), `${lifecyclePosition_latest.peakUnrealizedPnlPct}|${isNewPeak}`, false)) {
            console.info(JSON.stringify({
                event: "V2_TREND_PEAK_PNL_TRACK_PROOF",
                symbol: String(input.symbol),
                side: lifecyclePosition_latest.side,
                current_pnl_pct: currentPnlPct,
                peak_pnl_pct: lifecyclePosition_latest.peakUnrealizedPnlPct,
                peak_pnl_usd: lifecyclePosition_latest.peakUnrealizedPnlUsd,
                updated: isNewPeak
            }));
        }
    }

    if (hasLifecycleCandidate) {
        const cooldownReasonRaw = (riskSizing.diagnostics as Record<string, unknown> | undefined)?.risk_cooldown_subreason;
        const cooldownRemainingRaw = (riskSizing.diagnostics as Record<string, unknown> | undefined)?.cooldown_remaining_ms;
        lifecycleAuthority = deriveTradeLifecycleAuthority({
            symbol: String(input.symbol),
            side: finalLifecycleSide,
            regime: judgment.regime,
            marketMode: judgment.regime,
            directionalShockState: v2State.directionalShockState,
            v2Decision: finalDecision,
            v2Side: v2SideAfterPromotion,
            authoritySource: "v2",
            adoptedEngine: "V2",
            position: lifecyclePosition_latest,
            unrealizedPnl: lifecyclePosition_latest != null ? lifecyclePosition_latest.sizeUsd * lifecyclePosition_latest.pnlPct : null,
            unrealizedPnlPct: lifecyclePosition_latest?.pnlPct ?? null,
            holdMs: null,
            entryPrice: lifecyclePosition_latest?.entryPrice ?? null,
            markPrice: input.snapshot.lastPrice ?? null,
            riskState: v2State.riskMode,
            cooldownState: {
                reason: typeof cooldownReasonRaw === "string" ? cooldownReasonRaw : null,
                remainingMs: typeof cooldownRemainingRaw === "number" && Number.isFinite(cooldownRemainingRaw) ? cooldownRemainingRaw : null,
                reentryBlocked: typeof cooldownReasonRaw === "string" && cooldownReasonRaw.length > 0
            },
            microExecution,
            reversalQuality: input.snapshot.qualityScore ?? null,
            rawMetricsSummary: {
                qualityScore: input.snapshot.qualityScore ?? 0,
                rangeConfidence: input.snapshot.rangeConfidence ?? 0,
                trendWeaknessScore: input.snapshot.trendWeaknessScore ?? 0,
                boxPos: input.snapshot.boxPos ?? null,
                subtype: judgment.subtype,
                boxHigh: input.snapshot.boxHigh ?? undefined,
                boxLow: input.snapshot.boxLow ?? undefined,
                boxHighSlope: input.snapshot.boxHighSlope,
                boxLowSlope: input.snapshot.boxLowSlope,
                swingHighSlope: input.snapshot.swingHighSlope,
                swingLowSlope: input.snapshot.swingLowSlope,
                ema20: input.snapshot.ema20 ?? undefined,
                ema20Slope: input.snapshot.ema20Slope,
                atrExpansion: input.snapshot.atrExpansion,
                volumeExpansion: input.snapshot.volumeExpansion,
                breakoutFailureRate: input.snapshot.breakoutFailureRate
            },
            atr: input.snapshot.atr,
            currentStopPrice: lifecyclePosition_latest?.ledger_stop_px ?? undefined,
            accountEquityUsd: v2State.accountEquityKrw / 1400,
            currentSymbolNotionalUsd: v2State.symbolLedgerExposureNotionalKrw / 1400,
            currentGlobalNotionalUsd: v2State.ledgerExposureNotionalKrw / 1400,
            liveMaxOrderNotionalUsdt: v2State.liveMaxOrderNotionalUsdt,
            finalAddonNotionalUsdt: finalAddonNotionalUsdt,
            peakUnrealizedPnlPct: lifecyclePosition_latest?.peakUnrealizedPnlPct,
            peakUnrealizedPnlUsd: lifecyclePosition_latest?.peakUnrealizedPnlUsd,
            peakPnlUpdatedAt: lifecyclePosition_latest?.peakPnlUpdatedAt,
            takeProfitPlan: lifecyclePosition_latest?.takeProfitPlan,
            tp1Triggered: lifecyclePosition_latest?.tp1Triggered,
            tp2Triggered: lifecyclePosition_latest?.tp2Triggered,
            suggestedStopPrice: execution.stopPrice,
            suggestedInvalidationPx: execution.invalidationPx
        });

        if (String(input.symbol) === "BTCUSDT") {
            const hasPaperLong = Array.isArray(input.state.currentPositions) &&
                input.state.currentPositions.some(p => p && p.symbol === "BTCUSDT" && String(p.side).toUpperCase() === "LONG");
            const okxActualSide = input.state.okxActualSide;
            if (hasPaperLong && okxActualSide === "long") {
                lifecycleAuthority.side = "long";
            }
        }

        if (lifecycleAuthority.tp1Triggered && lifecyclePosition_latest) {
            lifecyclePosition_latest.tp1Triggered = true;
        }
        if (lifecycleAuthority.tp2Triggered && lifecyclePosition_latest) {
            lifecyclePosition_latest.tp2Triggered = true;
        }

        // Canonical Final Exit Authority Resolution (Phase D/E.5 runtime wiring)
        const finalExitAuth = resolveFinalExitAuthority({
            symbol: String(input.symbol),
            side: (Array.isArray(input.state?.currentPositions) && input.state.currentPositions.find(p => p && p.symbol === input.symbol)?.side as any) ?? "none",
            policyResult: {
                action: exitPolicy.action,
                reason: exitPolicy.reason,
                shouldExit: exitPolicy.shouldExit,
                shouldReduce: exitPolicy.shouldReduce,
                shouldPartial: exitPolicy.shouldPartial,
                reduceRatio: exitPolicy.reduceRatio
            },
            lifecycleResult: {
                exitAction: lifecycleAuthority.exitManagedByV2 ? lifecycleAuthority.exitAction : null,
                exitReason: lifecycleAuthority.exitManagedByV2 ? lifecycleAuthority.exitReason : null,
                partialAction: lifecycleAuthority.partialManagedByV2 ? lifecycleAuthority.partialAction : null,
                partialReason: lifecycleAuthority.partialManagedByV2 ? lifecycleAuthority.partialReason : null,
                reduceRatio: lifecycleAuthority.reduceRatio ?? undefined
            },
            riskResult: {
                action: v2ExitAuthority.exitAction,
                reason: v2ExitAuthority.exitReason,
                shouldExit: v2ExitAuthority.shouldExit
            },
            timestamp: input.now
        });

        if (finalExitAuth.action === "FULL_EXIT") {
            v2ExitAuthority = {
                ...v2ExitAuthority,
                exitAction: "exit",
                shouldExit: true,
                exitReason: finalExitAuth.terminalReason,
                exitUrgency: v2ExitAuthority.exitUrgency || "medium"
            };
        } else if (finalExitAuth.action === "PARTIAL_REDUCE") {
            v2PartialAuthority = {
                ...v2PartialAuthority,
                partialAction: "protect_profit",
                shouldPartial: true,
                partialReason: finalExitAuth.reduceReason || v2PartialAuthority.partialReason,
                reduceRatio: finalExitAuth.reduceRatio || v2PartialAuthority.reduceRatio
            };
            v2ExitAuthority = {
                ...v2ExitAuthority,
                exitAction: "none",
                shouldExit: false,
                exitReason: finalExitAuth.policyReason
            };
        } else {
            v2ExitAuthority = {
                ...v2ExitAuthority,
                exitAction: "none",
                shouldExit: false,
                exitReason: finalExitAuth.policyReason
            };
        }

        v2ExitAuthority = applyV2ExitAuthorityInvariants(v2ExitAuthority, {
            lifecycleExitReason: lifecycleAuthority.exitReason ?? null,
            lifecycleExitAction: lifecycleAuthority.exitAction ?? null
        });

        // Cooldown authority is computed as an independent proof/comparison layer.
        // It does NOT change any actual cooldown application logic (paper engine remains the executor).
        const cooldownType = lifecycleAuthority.cooldownType;
        const shouldCooldown = cooldownType !== "none";

        const cooldownAction: V2CooldownAuthorityResult["cooldownAction"] =
            cooldownType === "none"
                ? "none"
                : cooldownType === "direction_block"
                    ? "block_direction"
                    : cooldownType === "time_reentry"
                        ? "block_entry"
                        : cooldownType === "risk_halt"
                            ? "halt"
                            : "block_entry";

        const cooldownUrgency: V2CooldownAuthorityResult["cooldownUrgency"] =
            cooldownType === "none"
                ? "none"
                : cooldownType === "direction_block"
                    ? "medium"
                    : cooldownType === "time_reentry"
                        ? "low"
                        : cooldownType === "risk_halt"
                            ? "high"
                            : "medium";

        const directionBlocked: V2CooldownAuthorityResult["directionBlocked"] =
            cooldownType !== "direction_block"
                ? "none"
                : v2State.directionalShockState === "DOWN"
                    ? "long"
                    : v2State.directionalShockState === "UP"
                        ? "short"
                        : lifecycleSide === "long"
                            ? "long"
                            : lifecycleSide === "short"
                                ? "short"
                                : "none";

        v2CooldownAuthority = {
            symbol: String(input.symbol),
            side: lifecycleSide,
            cooldownAuthorityOwner: "v2",
            cooldownExecutionOwner: "paper_engine",
            cooldownAction,
            shouldCooldown,
            cooldownType,
            cooldownReason: lifecycleAuthority.cooldownReason,
            cooldownUrgency,
            cooldownRemainingMs:
                shouldCooldown && typeof cooldownRemainingRaw === "number" && Number.isFinite(cooldownRemainingRaw)
                    ? cooldownRemainingRaw
                    : null,
            directionBlocked,
            proofReasons: lifecycleAuthority.proofReasons,
            trueInconsistencyReasons: lifecycleAuthority.trueInconsistencyReasons,
            knownShadowGaps: lifecycleAuthority.knownShadowGaps
        };

        const cooldownProofKey = [
            v2CooldownAuthority.cooldownAction,
            v2CooldownAuthority.shouldCooldown,
            v2CooldownAuthority.cooldownType,
            v2CooldownAuthority.cooldownReason ?? "none",
            v2CooldownAuthority.cooldownUrgency,
            v2CooldownAuthority.directionBlocked
        ].join("|");

        const cooldownHighPriority = v2CooldownAuthority.trueInconsistencyReasons.length > 0;

        if (
            shouldEmitV2Proof(
                "V2_COOLDOWN_AUTHORITY_STATE_PROOF",
                String(input.symbol),
                cooldownProofKey,
                cooldownHighPriority
            )
        ) {
            console.info(JSON.stringify({
                event: "V2_COOLDOWN_AUTHORITY_STATE_PROOF",
                symbol: String(input.symbol),
                side: v2CooldownAuthority.side,
                regime: judgment.regime,
                directional_shock_state: v2State.directionalShockState,
                cooldown_authority_owner: v2CooldownAuthority.cooldownAuthorityOwner,
                cooldown_execution_owner: v2CooldownAuthority.cooldownExecutionOwner,
                v2_cooldown_action: v2CooldownAuthority.cooldownAction,
                v2_should_cooldown: v2CooldownAuthority.shouldCooldown,
                v2_cooldown_type: v2CooldownAuthority.cooldownType,
                v2_cooldown_reason: v2CooldownAuthority.cooldownReason,
                v2_cooldown_urgency: v2CooldownAuthority.cooldownUrgency,
                v2_cooldown_remaining_ms: v2CooldownAuthority.cooldownRemainingMs,
                direction_blocked: v2CooldownAuthority.directionBlocked,
                known_shadow_gaps: v2CooldownAuthority.knownShadowGaps,
                true_inconsistency_reasons: v2CooldownAuthority.trueInconsistencyReasons,
                proof_reasons: v2CooldownAuthority.proofReasons
            }));
        }
        const lifecycleProofKey = [
            lifecycleAuthority.lifecycleStage,
            lifecycleAuthority.lifecycleAuthorityOwner,
            lifecycleAuthority.executionOwner,
            lifecycleAuthority.cooldownType,
            lifecycleAuthority.partialAction,
            lifecycleAuthority.exitAction,
            lifecycleAuthority.consistencyPass,
            lifecycleAuthority.trueInconsistencyReasons.join(",")
        ].join("|");
        if (shouldEmitV2Proof("V2_TRADE_LIFECYCLE_PROOF", String(input.symbol), lifecycleProofKey, lifecycleAuthority.trueInconsistencyReasons.length > 0)) {
            console.info(JSON.stringify({
                event: "V2_TRADE_LIFECYCLE_PROOF",
                symbol: String(input.symbol),
                position_id: lifecyclePosition_latest != null
                    ? `${String(input.symbol)}:${lifecyclePosition_latest.side}:${lifecyclePosition_latest.entryStage}`
                    : `${String(input.symbol)}:none`,
                lifecycle_stage: lifecycleAuthority.lifecycleStage,
                authority_source: lifecycleAuthority.authoritySource,
                adopted_engine: lifecycleAuthority.adoptedEngine,
                regime: judgment.regime,
                market_mode: judgment.regime,
                directional_shock_state: v2State.directionalShockState,
                side: lifecycleSide,
                v2_decision: finalDecision,
                v2_side: v2SideAfterPromotion,
                lifecycle_authority_owner: lifecycleAuthority.lifecycleAuthorityOwner,
                execution_owner: lifecycleAuthority.executionOwner,
                position_state_owner: lifecycleAuthority.positionStateOwner,
                entry_managed_by_v2: lifecycleAuthority.entryManagedByV2,
                add_on_managed_by_v2: lifecycleAuthority.addOnManagedByV2,
                partial_managed_by_v2: lifecycleAuthority.partialManagedByV2,
                exit_managed_by_v2: lifecycleAuthority.exitManagedByV2,
                cooldown_managed_by_v2: lifecycleAuthority.cooldownManagedByV2,
                position_state_managed_by_v2: lifecycleAuthority.positionStateManagedByV2,
                add_on_allowed: lifecycleAuthority.addOnAllowed,
                partial_action: lifecycleAuthority.partialAction,
                exit_action: lifecycleAuthority.exitAction,
                cooldown_type: lifecycleAuthority.cooldownType,
                cooldown_reason: lifecycleAuthority.cooldownReason,
                legacy_intervention_detected: lifecycleAuthority.legacyInterventionDetected,
                consistency_pass: lifecycleAuthority.consistencyPass,
                known_shadow_gaps: lifecycleAuthority.knownShadowGaps,
                true_inconsistency_reasons: lifecycleAuthority.trueInconsistencyReasons,
                inconsistency_reasons: lifecycleAuthority.inconsistencyReasons,
                proof_reasons: lifecycleAuthority.proofReasons,
                giveback_pct: lifecycleAuthority.givebackPct,
                guard_threshold_pct: lifecycleAuthority.guardThresholdPct,
                guard_action: lifecycleAuthority.guardAction
            }));
        }

        // --- V2 Position State Authority (Step 4) ---
        const hasPosition = lifecyclePosition_latest != null;
        const positionLifecycleState: V2PositionStateAuthorityResult["positionLifecycleState"] = (() => {
            if (!hasPosition) return "none";
            if (lifecycleAuthority.exitAction === "exit") return "closing";
            if (lifecycleAuthority.partialAction === "reduce" || lifecycleAuthority.partialAction === "protect_profit") return "reducing";
            if (lifecycleAuthority.addOnAllowed) return "scaling";
            return "open";
        })();

        const positionRiskState: V2PositionStateAuthorityResult["positionRiskState"] = (() => {
            if (!hasPosition) return "none";
            const v2RiskMode = v2State.riskMode;
            if (v2RiskMode === "danger") return "danger";
            if (v2RiskMode === "drawdown_watch") return "drawdown_watch";
            if (lifecycleAuthority.partialAction === "protect_profit") return "profit_protect";
            return "normal";
        })();

        const pnlState: V2PositionStateAuthorityResult["pnlState"] = (() => {
            if (!hasPosition) return "none";
            const pct = lifecyclePosition_latest?.pnlPct ?? 0;
            if (pct > 0.001) return "profit";
            if (pct < -0.001) return "loss";
            return "flat";
        })();

        v2PositionStateAuthority = {
            symbol: String(input.symbol),
            side: finalLifecycleSide,
            positionStateAuthorityOwner: "v2",
            positionStateExecutionOwner: "paper_engine",
            positionStateAction: hasPosition ? "track" : "none",
            hasPosition,
            positionLifecycleState,
            positionRiskState,
            positionStage: lifecyclePosition_latest?.entryStage ?? null,
            holdMs: null,
            pnlState,
            unrealizedPnlKrw: null,
            unrealizedPnlUsdEstimate: lifecyclePosition_latest != null ? lifecyclePosition_latest.sizeUsd * lifecyclePosition_latest.pnlPct : null,
            unrealizedPnlPct: lifecyclePosition_latest?.pnlPct ?? null,
            peakUnrealizedPnlPct: lifecyclePosition_latest?.peakUnrealizedPnlPct ?? null,
            peakUnrealizedPnlUsd: lifecyclePosition_latest?.peakUnrealizedPnlUsd ?? null,
            givebackPct: lifecycleAuthority.givebackPct ?? null,
            stateReason: lifecycleAuthority.cooldownReason || null,
            proofReasons: [],
            trueInconsistencyReasons: [],
            knownShadowGaps: ["position_state_execution_owner_is_paper_engine"]
        };

        const positionStateProofKey = [
            v2PositionStateAuthority.hasPosition,
            v2PositionStateAuthority.positionLifecycleState,
            v2PositionStateAuthority.positionRiskState,
            v2PositionStateAuthority.positionStage,
            v2PositionStateAuthority.pnlState,
            v2PositionStateAuthority.side
        ].join("|");

        const positionStateHighPriority = v2PositionStateAuthority.trueInconsistencyReasons.length > 0;

        if (shouldEmitV2Proof("V2_POSITION_STATE_AUTHORITY_STATE_PROOF", String(input.symbol), positionStateProofKey, positionStateHighPriority)) {
            console.info(JSON.stringify({
                event: "V2_POSITION_STATE_AUTHORITY_STATE_PROOF",
                symbol: String(input.symbol),
                side: v2PositionStateAuthority.side,
                has_position: v2PositionStateAuthority.hasPosition,
                lifecycle_state: v2PositionStateAuthority.positionLifecycleState,
                risk_state: v2PositionStateAuthority.positionRiskState,
                stage: v2PositionStateAuthority.positionStage,
                pnl_state: v2PositionStateAuthority.pnlState,
                unrealized_pnl_usd_estimate: v2PositionStateAuthority.unrealizedPnlUsdEstimate,
                unrealized_pnl_pct: lifecyclePosition_latest?.pnlPct ?? null,
                peak_pnl_pct: v2PositionStateAuthority.peakUnrealizedPnlPct,
                peak_pnl_usd: v2PositionStateAuthority.peakUnrealizedPnlUsd,
                giveback_pct: v2PositionStateAuthority.givebackPct,
                state_reason: v2PositionStateAuthority.stateReason,
                hold_ms: v2PositionStateAuthority.holdMs
            }));
        }

        const rawBridgePnl = (lifecyclePosition_latest as any)?.pnlPct;
        const pnlReady = typeof rawBridgePnl === "number" && Number.isFinite(rawBridgePnl);
        console.info(JSON.stringify({
            event: "V2_POSITION_PNL_PROPAGATION_PROOF",
            proof_stage: "v2_bridge_consumer",
            symbol: String(input.symbol),
            side: v2PositionStateAuthority.side,
            entry_price: lifecyclePosition_latest?.entryPrice ?? null,
            current_price: input.snapshot?.lastPrice ?? null,
            paper_metric_pnl_pct_net: rawBridgePnl ?? null,
            paper_open_unrealized_pnl_pct: rawBridgePnl ?? null,
            bridge_pnl_pct: rawBridgePnl ?? null,
            adapted_v2_pnl_pct: pnlReady ? rawBridgePnl : 0,
            peak_unrealized_pnl_pct: v2PositionStateAuthority.peakUnrealizedPnlPct,
            pnl_source: pnlReady ? "bridge_position" : "fallback_zero",
            pnl_ready: pnlReady,
            fallback_used: !pnlReady,
            fallback_reason: !pnlReady ? "bridge_pnl_pct_missing" : null
        }));
    }

    console.info(JSON.stringify({
        event: "V2_TREND_AUTHORITY_DIAGNOSTIC_PROOF",
        symbol: String(input.symbol),
        market_mode: marketMode,
        active_engine_routing: activeEngineRouting,
        directional_shock_state: shock,
        risk_long_allow: riskLongAllow,
        risk_short_allow: riskShortAllow,
        allow_new_long: allowNewLong,
        allow_new_short: allowNewShort,
        raw_signal: rawSignal,
        aligned_signal: alignedSignal,
        trend_side_candidate: trendSideCandidate,
        entry_quality_grade: entryQualityGrade,
        quality_score: qualityScore,
        trendOk,
        v2_decision_before: v2DecisionBeforePromotion,
        v2_side_before: v2SideBeforePromotion,
        v2_reject_reason_before: v2RejectReasonBeforePromotion,
        promotion_applied: promotionApplied,
        promotion_reason: promotionReason,
        v2_decision_after: finalDecision,
        v2_side_after: v2SideAfterPromotion,
        v2_reject_reason_after: blockReason
    }));
    console.info(JSON.stringify({
        event: "V2_STRUCTURAL_METRIC_PROPAGATION_PROOF",
        symbol: String(input.symbol),
        source_boxCohesion01: input.snapshot?.boxCohesion01,
        adapted_boxCohesion01: authoritativeInput.snapshot?.boxCohesion01,
        final_boxCohesion01: boxCohesion01,
        source_trendWeaknessScore: input.snapshot?.trendWeaknessScore,
        adapted_trendWeaknessScore: authoritativeInput.snapshot?.trendWeaknessScore,
        final_trendWeaknessScore: trendWeaknessFromMeta,
        source_breakoutFailureRate: input.snapshot?.breakoutFailureRate,
        adapted_breakoutFailureRate: authoritativeInput.snapshot?.breakoutFailureRate,
        source_rangeOscillationScore: input.snapshot?.rangeOscillationScore,
        adapted_rangeOscillationScore: authoritativeInput.snapshot?.rangeOscillationScore,
        source_reviewing_ticks: input.snapshot?.reviewing_ticks,
        adapted_reviewing_ticks: authoritativeInput.snapshot?.reviewing_ticks,
        rangeConfidence,
        rangeConfidenceSource: rangeMetadataSource,
        fallbackUsed: rangeMetadataSource === "snapshot_fallback" || rangeMetadataMissingFields.length > 0,
        fallbackFields: rangeMetadataMissingFields
    }));
    console.info(JSON.stringify({
        event: "V2_AUTHORITY_PROMOTION_FINALIZER_PROOF",
        symbol: String(input.symbol),
        market_mode: marketMode,
        active_engine_routing: activeEngineRouting,
        v2_router_executor: activeEngineRouting,
        paper_execution_ready: paperExecutionReady,
        signed_execution_ready: signedExecutionReady,
        directional_shock_state: shock,
        trend_side_candidate: trendSideCandidate,
        range_side_candidate: rangeSideCandidate,
        entry_quality_grade: entryQualityGrade,
        quality_score: qualityScore,
        trendOk,
        rangeConfidence,
        boxCohesion01,
        trendWeaknessScore: trendWeaknessFromMeta,
        boxPos: boxPos,
        zone,
        range_zone_lower_extreme: rangeZoneLowerExtreme(boxPos),
        range_zone_upper_extreme: rangeZoneUpperExtreme(boxPos),
        range_metadata_source: rangeMetadataSource,
        range_metadata_missing_fields: rangeMetadataMissingFields.join("|") || null,
        side_zone_valid: sideZoneValid,
        range_edge_extreme: rangeEdgeExtreme,
        relaxedRangeEntry,
        reversal_confirmed: reversalConfirmed,
        decision_before: v2DecisionBeforePromotion,
        side_before: v2SideBeforePromotion,
        reject_reason_before: v2RejectReasonBeforePromotion,
        promotion_applied: promotionApplied,
        promotion_reason: promotionReason,
        decision_after: finalDecision,
        side_after: v2SideAfterPromotion,
        reject_reason_after: blockReason,
        promotion_block_reason: promotionBlockReason,
        promotion_min_condition_passed: promotionMinConditionPassed,
        contamination_softened: contaminationSoftened,
        contamination_hard_reject: contaminationHardReject,
        contamination_soften_reason: contaminationSoftenReason,
        shock_reaction_watch_active: shockReactionWatchActive,
        shock_reaction_direction: shockReactionDirection,
        shock_reaction_promotion_type: shockReactionPromotionType,
        shock_edge_setup_active_reason: shockEdgeSetupActiveReason.length > 0 ? shockEdgeSetupActiveReason.join("|") : null,
        shock_reaction_block_reason: shockReactionBlockReason ?? promotionBlockReason,
        shock_reaction_symmetry_case:
            shock === "DOWN"
                ? "DOWN_SHOCK_RANGE_FLOW"
                : shock === "UP"
                    ? "UP_SHOCK_RANGE_FLOW"
                    : "NONE",
        v2_state_authority_source: v2State.stateAuthoritySource,
        v2_state_position_ready: v2State.positionStateReady,
        v2_state_same_side_position: v2State.hasSameSidePosition,
        v2_state_opposite_side_position: v2State.hasOppositeSidePosition,
        v2_state_current_stage: v2State.currentStage,
        v2_state_held_position_side: v2State.heldPositionSide,
        v2_state_management_side: v2State.managementSide,
        v2_state_candidate_intent_side: v2State.candidateIntentSide,
        v2_state_inferred_intent_side: v2State.inferredIntentSide,
        v2_state_has_opposite_to_candidate: v2State.hasOppositeToCandidate,
        v2_state_has_long_position: v2State.hasLongPosition,
        v2_state_has_short_position: v2State.hasShortPosition,
        v2_state_long_stage: v2State.longStage,
        v2_state_short_stage: v2State.shortStage,
        market_subtype: judgment.subtype,
        market_subtype_reason: judgment.subtypeReason,
        market_shock_phase: judgment.shockPhase,
        market_range_phase: judgment.rangePhase,
        market_trend_phase: judgment.trendPhase,
        market_transition_phase: judgment.transitionPhase,
        market_judgment_version: judgment.judgmentVersion,
        market_judgment_state_source: "authoritative_input",
        transition_setup_type: typeof execMeta.transitionSetupType === "string" ? execMeta.transitionSetupType : null,
        transition_action: typeof execMeta.transitionAction === "string" ? execMeta.transitionAction : null,
        transition_watch_only: readNullableBoolean(execMeta.transitionWatchOnly),
        transition_confirm_required: readNullableBoolean(execMeta.transitionConfirmRequired),
        transition_reject_reason: typeof execMeta.transitionRejectReason === "string" ? execMeta.transitionRejectReason : null,
        addon_action: addOnPolicy.action,
        addon_allowed: addOnPolicy.allowed,
        addon_reason: addOnPolicy.reason,
        addon_is_initial: addOnPolicy.isInitial,
        addon_is_addon: addOnPolicy.isAddOn,
        addon_current_stage: addOnPolicy.currentStage,
        addon_has_same_side_position: addOnPolicy.hasSameSidePosition,
        addon_has_opposite_side_position: addOnPolicy.hasOppositeSidePosition,
        exit_action: exitPolicy.action,
        exit_reason: exitPolicy.reason,
        exit_should_exit: exitPolicy.shouldExit,
        exit_should_reduce: exitPolicy.shouldReduce,
        exit_should_partial: exitPolicy.shouldPartial,
        exit_reduce_ratio: exitPolicy.reduceRatio,
        exit_urgency: exitPolicy.exitUrgency,
        exit_confidence: exitPolicy.exitConfidence,
        hard_block_present: hardBlockPresent,
        hard_block_reason: hardBlockReason
    }));
    console.info(JSON.stringify({
        event: "V2_ENTRY_QUALITY_CONTAMINATION_PROOF",
        symbol: String(input.symbol),
        decision_before: v2DecisionBeforePromotion,
        reject_reason_before: v2RejectReasonBeforePromotion,
        entry_quality_grade: entryQualityGrade,
        qualityScore,
        profitDistance,
        lossDistance,
        contaminatedDistance,
        contamination_hard_reject: contaminationHardReject,
        contamination_softened: contaminationSoftened,
        contamination_soften_reason: contaminationSoftenReason,
        final_decision_after: finalDecision,
        hard_block_present: hardBlockPresent,
        hard_block_reason: hardBlockReason
    }));
    console.info(JSON.stringify({
        event: "V2_EXECUTION_READINESS_PROOF",
        symbol: String(input.symbol),
        paper_execution_ready: readinessDiag.paper_execution_ready ?? null,
        signed_execution_ready: readinessDiag.signed_execution_ready ?? null,
        okx_auth_mode: v2State.okxAuthMode ?? null,
        okx_auth_ready: v2State.okxAuthReady ?? null,
        okx_exchange_auth_opt_in: v2State.okxExchangeAuthOptIn ?? null,
        okx_live_enabled: v2State.okxLiveEnabled ?? null,
        okx_demo_enabled: v2State.okxDemoEnabled ?? null,
        okx_api_key_present: v2State.okxApiKeyPresent ?? null,
        okx_api_secret_present: v2State.okxApiSecretPresent ?? null,
        okx_passphrase_present: v2State.okxPassphrasePresent ?? null,
        okx_simulated_trading_header_enabled: v2State.okxSimulatedTradingHeaderEnabled ?? null,
        live_max_order_notional_usdt: v2State.liveMaxOrderNotionalUsdt ?? null,
        paper_readiness_block_reasons: readinessDiag.paper_readiness_block_reasons ?? null,
        signed_readiness_block_reason: readinessDiag.signed_readiness_block_reason ?? null,
        serverTradeEnabled: v2State.serverTradeEnabled,
        closeOnlyMode: v2State.closeOnlyMode,
        killSwitch: v2State.killSwitch,
        reconcileSafeMode: v2State.reconcileSafeMode,
        riskMode: readinessDiag.risk_mode ?? v2State.riskMode ?? null,
        dailyLossGuardTriggered: readinessDiag.daily_loss_guard_triggered ?? v2State.dailyLossGuardTriggered,
        market_snapshot_ready: readinessDiag.market_snapshot_ready ?? null,
        position_state_ready: readinessDiag.position_state_ready ?? null,
        v2_input_ready: readinessDiag.v2_input_ready ?? null,
        decision_before_readiness: decisionBeforeReadiness,
        decision_after_readiness: decisionAfterReadiness
    }));

    // Tier 6: Unify diagnostic suppression reasons for audit-ready transparency
    let whipsawBlocking = judgment.subtype === "WHIPSAW_SHOCK_RECHECK";
    if (!promotionBlockReason && finalDecision !== "ENTER" && !hardBlockPresent && (trendSideCandidate !== "none" || activeEngineRouting === "TREND" || marketMode === "TREND")) {
        if (!trendOk) {
            if (trendWeaknessScore >= 0.5) {
                promotionBlockReason = "TREND_PROMOTION_BLOCKED_TREND_WEAKNESS_TOO_HIGH";
                expectedNextAction = "WAIT_FOR_TREND_STRENGTHENING";
            } else if (Math.abs(emaGap) < 0.0004) {
                promotionBlockReason = "TREND_PROMOTION_BLOCKED_EMA_GAP_INSUFFICIENT";
                expectedNextAction = "WAIT_FOR_TREND_CONFIRMATION";
            } else {
                promotionBlockReason = "TREND_PROMOTION_BLOCKED_TREND_NOT_CONFIRMED";
                expectedNextAction = "WAIT_FOR_TREND_CONFIRMATION";
            }
        }
    }
    let auditRawMissingCondition: string | null = promotionBlockReason || v2RejectReasonAfterPromotion || expectedMissingCondition || (finalDecision === "SKIP" ? "MIN_QUALITY_NOT_MET" : "NONE");
    
    // Priority Logic for primary_missing_condition (Requirement 2 & 3 & 4)
    const htfPolarityMismatchReason =
        judgment.polarityProbeEligible === true
            ? null
            : (judgment.htf_policy_reason || "").includes("POLARITY_MISMATCH")
              ? judgment.htf_policy_reason
              : null;
    
    // Requirement 4: Shock/Retest/Reclaim check
    let isShockRetestBlock =
        judgment.subtype === "WHIPSAW_SHOCK_RECHECK" ||
        sideVetoDetail === "WHIPSAW_SHOCK_RECHECK_ACTIVE" ||
        sideVetoDetail === "SHOCK_UP_RECLAIM_NOT_CONFIRMED" ||
        sideVetoDetail === "SHOCK_UP_MID_RETEST_REQUIRED" ||
        sideVetoDetail === "SHOCK_DOWN_MID_RETEST_REQUIRED" ||
        sideVetoDetail === "SHOCK_DOWN_BREAKDOWN_RETEST_NOT_CONFIRMED" ||
        shockReactionBlockReason === "SHOCK_REACTION_WATCH_MID_CHASE_BLOCKED" ||
        shockReactionBlockReason === "SHOCK_REACTION_SETUP_NOT_READY_UP" ||
        sideVetoDetail === "SHOCK_REACTION_UP_RETEST_NOT_CONFIRMED" ||
        sideVetoDetail === "SHOCK_REACTION_DOWN_RETEST_NOT_CONFIRMED";

    const shockRetestReason = isShockRetestBlock ? (sideVetoDetail || shockReactionBlockReason) : null;

    // Requirement 3: Handle SIGNED_EXECUTION_NOT_READY priority
    const signedReadyBlocked = (finalDecision === "REJECT" || finalDecision === "HOLD") && hardBlockReason === "SIGNED_EXECUTION_NOT_READY";

    let primaryMissingCondition: string | null =
        (whipsawBlocking ? "WHIPSAW_RECHECK_NOT_CONFIRMED" : null) ||
        (signedReadyBlocked ? "SIGNED_EXECUTION_NOT_READY" : null) ||
        (hardBlockReason ? hardBlockReason : null) ||
        htfPolarityMismatchReason ||
        shockRetestReason ||
        (microProbeBlockReason ? microProbeBlockReason : null) ||
        auditRawMissingCondition;

    // Force alignment for shock/retest cases (Requirement 4)
    if (isShockRetestBlock && !signedReadyBlocked && !hardBlockReason) {
        primaryMissingCondition = shockRetestReason || primaryMissingCondition;
    }

    const secondaryMissingCondition =
        auditRawMissingCondition && auditRawMissingCondition !== primaryMissingCondition
            ? auditRawMissingCondition
            : null;

    let dashboardMissingCondition: string | null = primaryMissingCondition;
    let dashboardNextAction = expectedNextAction || (finalDecision === "SKIP" ? "WAIT_FOR_STRUCTURAL_REVERSAL_OR_RETEST" : "EXECUTE_V2_AUTHORITY");

    if (whipsawBlocking) {
        dashboardNextAction = "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION";
    }

    const isContinuationMicroProbeEnter = promotionReason === "CONTINUATION_MICRO_PROBE" && finalDecision === "ENTER";

    if (isContinuationMicroProbeEnter) {
        whipsawBlocking = false;
        isShockRetestBlock = false;
        primaryMissingCondition = null;
        dashboardMissingCondition = null;
        auditRawMissingCondition = null;
        dashboardNextAction = "WAIT_FOR_RETEST_BEFORE_ADDON";
    }

    // Requirement 3 & 4: align expected_next_action
    if (!isContinuationMicroProbeEnter) {
        if (primaryMissingCondition === "SIGNED_EXECUTION_NOT_READY") {
            dashboardNextAction = "WAIT_FOR_SIGNED_EXECUTION_READY";
        } else if (primaryMissingCondition && (primaryMissingCondition.includes("POLARITY_MISMATCH") || primaryMissingCondition.includes("HTF_BIAS_MISMATCH"))) {
            dashboardNextAction = "WAIT_FOR_HTF_POLARITY_ALIGNMENT";
        } else if (isShockRetestBlock) {
            dashboardNextAction = "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION";
        } else if (sideVetoDetail === "SHOCK_DOWN_TREND_CONFIRMATION_WEAK") {
            dashboardNextAction = "WAIT_FOR_TREND_CONFIRMATION";
        } else if (primaryMissingCondition === "WATCH_BOUNDARY_MISSING") {
            dashboardNextAction = "WAIT_FOR_BREAKOUT_OR_BREAKDOWN_SETUP";
        }

        // Requirement 5: If primary is retest/shock/hard-block, do not overwrite WAIT_FOR_QUALITY_IMPROVEMENT
        if (dashboardNextAction === "WAIT_FOR_QUALITY_IMPROVEMENT" && (isShockRetestBlock || hardBlockReason || htfPolarityMismatchReason)) {
            // Keep the more specific wait state if it was already set
            if (isShockRetestBlock) dashboardNextAction = "WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION";
            else if (hardBlockReason) dashboardNextAction = "WAIT_FOR_STRUCTURAL_REVERSAL_OR_RETEST"; // Fallback for general hard block
        }
    }

    const displayRetestRequired =
        isShockRetestBlock ||
        primaryMissingCondition === "TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED" ||
        primaryMissingCondition === "TREND_PROMOTION_BLOCKED_BREAKDOWN_RETEST_NOT_CONFIRMED" ||
        primaryMissingCondition === "TREND_PROMOTION_BLOCKED_RANGE_ZONE_NOT_BREAKOUT_CONFIRMED" ||
        primaryMissingCondition === "TREND_PROMOTION_BLOCKED_RANGE_ZONE_NOT_BREAKDOWN_CONFIRMED" ||
        (execMeta as any).retest_required === true;

    const displaySupportRecheckRequired =
        sideVetoDetail === "SHOCK_UP_RECLAIM_NOT_CONFIRMED" ||
        primaryMissingCondition === "TREND_PROMOTION_BLOCKED_SUPPORT_RECHECK_REQUIRED" ||
        (execMeta as any).support_recheck_required === true ||
        (isShockRetestBlock && sideVetoDetail?.includes("SHOCK_UP"));

    // Requirement 7: Validate StopPrice & InvalidationPx strictly from lifecycleAuthority
    const v2StopPrice = lifecycleAuthority?.newStopPrice ?? execution.stopPrice;
    const v2InvalidationPx = lifecycleAuthority?.invalidationPx ?? execution.invalidationPx;

    if (finalDecision === "ENTER") {
        let invalidRisk = false;
        let invalidReason = "";

        if (v2StopPrice == null || v2StopPrice <= 0) {
            invalidRisk = true;
            invalidReason = "MISSING_STOP_PRICE";
        } else if (v2InvalidationPx == null || v2InvalidationPx <= 0) {
            invalidRisk = true;
            invalidReason = "MISSING_INVALIDATION_PX";
        } else if (v2SideAfterPromotion === "long" && (v2StopPrice >= input.snapshot.lastPrice || v2InvalidationPx >= input.snapshot.lastPrice)) {
            invalidRisk = true;
            invalidReason = "INVALID_LONG_STOP_DIRECTION";
        } else if (v2SideAfterPromotion === "short" && (v2StopPrice <= input.snapshot.lastPrice || v2InvalidationPx <= input.snapshot.lastPrice)) {
            invalidRisk = true;
            invalidReason = "INVALID_SHORT_STOP_DIRECTION";
        }

        if (invalidRisk) {
            finalDecision = "REJECT";
            hardBlockPresent = true;
            hardBlockReason = invalidReason;
            blockReason = invalidReason;
        }
    }

    const normalizedV2Side = finalDecision === "ENTER" ? v2SideAfterPromotion : "none";
    executionAction = finalDecision === "ENTER"
        ? (isAddOn || (v2State as any).addOnPolicyAllowed === true ? "ADDON" : "ENTER")
        : "NONE";

    const authorityCreatedAt = input.now;

    const v2CommittedPlan: V2CommittedRiskPlan | undefined =
        (finalDecision === "ENTER" && (executionAction === "ENTER" || executionAction === "ADDON") && !hardBlockPresent && !riskSizing.isBlocked && finalOrderNotionalUsdt > 0)
            ? {
                symbol: input.symbol,
                side: (normalizedV2Side === "short" ? "short" : "long") as "long" | "short",
                action: executionAction,
                finalOrderNotionalUsdt,
                appliedLeverage: riskSizing.appliedLeverage,
                stopPrice: Number(v2StopPrice),
                invalidationPx: Number(v2InvalidationPx),
                ts: authorityCreatedAt,
                authorityCreatedAt
            }
            : undefined;

    console.info(JSON.stringify({
        event: "V2_STAIR_STEP_STRUCTURE_PROOF",
        symbol: String(input.symbol),
        detected: stairStepResult.detected,
        direction: stairStepResult.direction,
        higher_low_detected: stairStepResult.higher_low_detected,
        higher_high_detected: stairStepResult.higher_high_detected,
        lower_high_detected: stairStepResult.lower_high_detected,
        lower_low_detected: stairStepResult.lower_low_detected,
        center_slope: stairStepResult.center_slope,
        ema20_slope: stairStepResult.ema20_slope,
        pullback_depth_ratio: stairStepResult.pullback_depth_ratio,
        reclaim_or_rejection_confirmed: stairStepResult.reclaim_or_rejection_confirmed,
        htf_entry_policy: stairStepResult.htf_entry_policy,
        current_regime: judgment.regime,
        current_subtype: judgment.subtype,
        current_decision: finalDecision,
        current_side: normalizedV2Side,
        diagnostic_only: !stairStepPromoted,
        stair_step_promoted: stairStepPromoted,
        confidence: stairStepResult.confidence,
        block_reason: stairStepResult.block_reason,
        structure_candles_closed_only: stairStepResult.structure_candles_closed_only,
        reclaim_price_source: stairStepResult.reclaim_price_source,
        closed_candle_count: stairStepResult.closed_candle_count
    }));

    const decision: EngineV2Decision = {
        symbol: input.symbol,
        ts: input.now,
        regime: judgment.regime,
        confidence: confidenceForSizing.level,
        confidenceScore: confidenceForSizing.score,
        signal: execution.signal,
        side: normalizedV2Side as any,
        decision: finalDecision,
        executionAction,
        risk: {
            ...riskSizing,
            stopPrice: v2StopPrice,
            invalidationPx: v2InvalidationPx ?? undefined,
            isBlocked: hardBlockPresent || riskSizing.isBlocked || finalDecision === "REJECT",
            blockReason: hardBlockReason ?? riskSizing.blockReason ?? blockReason ?? null,
            stageMarginKrw: isLiveSignedOrderAttempt ? (finalDecision === "ENTER" ? stageMarginKrwAfter : 0) : (finalDecision === "ENTER" ? stageMarginKrwAfter : riskSizing.stageMarginKrw),
            exposureNotionalKrw: isLiveSignedOrderAttempt ? (finalDecision === "ENTER" ? stageMarginKrwAfter : 0) * riskSizing.appliedLeverage : (finalDecision === "ENTER" ? stageMarginKrwAfter * riskSizing.appliedLeverage : riskSizing.exposureNotionalKrw),
            finalOrderNotionalUsdt: isLiveSignedOrderAttempt ? (finalDecision === "ENTER" ? finalOrderNotionalUsdt : 0) : undefined,
            requestedOrderNotionalUsdt: isLiveSignedOrderAttempt ? (finalDecision === "ENTER" ? requestedOrderNotionalUsdt : 0) : undefined
        },
        committedRiskPlan: v2CommittedPlan,
        explanation: {
            reason: finalReason,
            uiLabelRegime: judgment.subtype === "WHIPSAW_SHOCK_RECHECK" ? "WHIPSAW" : judgment.regime,
            uiLabelStatus: explanation.uiLabels.status
        },
        microExecution: microExecution ?? undefined,
        lifecycleAuthority: lifecycleAuthority ?? undefined,
        metadata: {
            ...execMeta,
            v2_router_executor: activeEngineRouting,
            alignedSignal,
            selectedSideAfterVeto: normalizedV2Side,
            promotionApplied,
            promotionReason,
            promotionBlockReason,
            shockReactionBlockReason,
            qualityScore,
            v2DecisionFinal: finalDecision,
            v2SideFinal: normalizedV2Side,
            rangeSideCandidate,
            trendSideCandidate,
            reversalConfirmed,
            sideZoneValid,
            invalidationPx: v2CalculatedInvalidationPx ?? execMeta.invalidationPx ?? undefined,
            expectedMissingCondition: dashboardMissingCondition,
            expectedNextAction: dashboardNextAction,
            primary_missing_condition: primaryMissingCondition,
            secondary_missing_condition: secondaryMissingCondition,
            raw_missing_condition: primaryMissingCondition,
            retest_required: displayRetestRequired,
            reclaim_required: displaySupportRecheckRequired,
            display_retest_required: displayRetestRequired,
            display_support_recheck_required: displaySupportRecheckRequired,
            side_veto_detail: sideVetoDetail,
            macro_source: judgment.macro_source ?? "data_not_ready",
            daily_bias_actual: judgment.daily_bias_actual ?? "DATA_NOT_READY",
            h4_bias_actual: judgment.h4_bias_actual ?? "DATA_NOT_READY",
            h1_bias_actual: judgment.h1_bias_actual ?? "DATA_NOT_READY",
            m15_bias_actual: judgment.m15_bias_actual ?? "DATA_NOT_READY",
            m5_bias_actual: judgment.m5_bias_actual ?? "DATA_NOT_READY",
            htf_bias: judgment.htf_bias ?? { m5: "DATA_NOT_READY", m15: "DATA_NOT_READY", h1: "DATA_NOT_READY", h4: "DATA_NOT_READY", d1: "DATA_NOT_READY" },
            htf_entry_policy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
            htf_policy_reason: judgment.htf_policy_reason ?? "HTF_DATA_NOT_READY",
            htf_hard_block_reason: judgment.htf_hard_block_reason ?? null,
            counter_trend_risk: judgment.counter_trend_risk ?? false,
            htf_size_multiplier: judgment.htf_size_multiplier ?? 1.0,
            htf_requires_stronger_confirmation: judgment.htf_requires_stronger_confirmation ?? false,
            macro_polarity: judgment.macroPolarity ?? "NEUTRAL",
            polarity_mismatch: judgment.polarityMismatch ?? false,
            polarity_probe_eligible: judgment.polarityProbeEligible ?? false,
            trend_ok: trendOk,
            judgmentShockPhase: judgment.shockPhase,
            judgmentTrendPhase: judgment.trendPhase,
            micro_probe_active: promotionReason === "CONTINUATION_MICRO_PROBE" ? true : undefined,
            micro_probe_block_reason: microProbeBlockReason ?? undefined,
            full_entry_retest_required: promotionReason === "CONTINUATION_MICRO_PROBE" ? true : undefined,
            stair_step_detected: stairStepResult.detected,
            stair_step_direction: stairStepResult.direction,
            stair_step_confidence: stairStepResult.confidence,
            stair_step_block_reason: stairStepResult.block_reason,
            external_context_score: externalMarketContext.externalContextScore,
            nq_signal: externalMarketContext.signals.nqSignal,
            es_signal: externalMarketContext.signals.esSignal,
            dxy_signal: externalMarketContext.signals.dxySignal,
            us10y_signal: externalMarketContext.signals.us10ySignal,
            news_signal: externalMarketContext.signals.newsSignal,
            news_event_risk: externalMarketContext.newsEventRisk,
            external_size_multiplier: externalMarketContext.externalSizeMultiplier,
            external_context_age_ms: externalMarketContext.externalContextAgeMs,
            external_context_applied: externalMarketContext.externalContextApplied,
            external_context_reason: externalMarketContext.externalContextReason
        },
        v2ExitAuthority: v2ExitAuthority ?? undefined,
        v2PartialAuthority: v2PartialAuthority ?? undefined,
        v2CooldownAuthority: v2CooldownAuthority ?? undefined,
        v2PositionStateAuthority: v2PositionStateAuthority ?? undefined,
        rawMetrics: {
            ...judgment.metrics,
            qualityScore: input.snapshot.qualityScore ?? 0,
            directionalShockState: v2State.directionalShockState,
            confidenceScore: confidence.score,
            sizingMultiplier: riskSizing.sizeMultiplier,
            microExecutionScore: microExecution?.score ?? 0,
            microExecutionFallbackNeutral: microExecution?.fallbackNeutral ?? false,
            lifecycleConsistencyPass: lifecycleAuthority?.consistencyPass ?? false,
            lifecycleLegacyInterventionDetected: lifecycleAuthority?.legacyInterventionDetected ?? false,
            v2ExitShouldExit: v2ExitAuthority?.shouldExit ?? false,
            v2PartialShouldPartial: v2PartialAuthority?.shouldPartial ?? false
        }
    };

    // Audit Coverage for all suppression paths
    if (finalDecision !== "ENTER") {
        console.info(JSON.stringify({
            event: "V2_NO_ENTER_PATH_AUDIT_PROOF",
            symbol: String(input.symbol),
            final_decision: finalDecision,
            regime: judgment.regime,
            subtype: judgment.subtype,
            side_candidate: v2SideAfterPromotion || v2SideBeforePromotion || "none",
            macro_polarity: judgment.macroPolarity ?? "NEUTRAL",
            htf_policy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
            polarity_mismatch: judgment.polarityMismatch ?? false,
            promotion_applied: promotionApplied,
            promotion_reason: promotionReason,
            promotion_block_reason: promotionBlockReason,
            primary_missing_condition: primaryMissingCondition,
            secondary_missing_condition: secondaryMissingCondition,
            expected_missing_condition: dashboardMissingCondition,
            raw_missing_condition: primaryMissingCondition,
            expected_next_action: dashboardNextAction,
            htf_policy_reason: judgment.htf_policy_reason ?? "HTF_DATA_NOT_READY",
            macro_source: judgment.macro_source ?? "data_not_ready",
            side_veto_detail: sideVetoDetail,
            shock_reaction_block_reason: shockReactionBlockReason,
            quality_score: qualityScore,
            counter_trend_risk: judgment.counter_trend_risk ?? false,
            trend_ok: trendOk
        }));
    }


    const internal: EngineV2InternalResult = {
        judgment,
        confidence,
        routing,
        execution,
        riskSizing,
        explanation,
        microExecution,
        lifecycleAuthority,
        v2ExitAuthority,
        v2PartialAuthority,
        v2CooldownAuthority,
        v2PositionStateAuthority,
        exitPolicy: {
            action: exitPolicy.action,
            reason: exitPolicy.reason,
            shouldExit: exitPolicy.shouldExit,
            shouldReduce: exitPolicy.shouldReduce,
            shouldPartial: exitPolicy.shouldPartial,
            reduceRatio: exitPolicy.reduceRatio,
            exitUrgency: exitPolicy.exitUrgency,
            exitConfidence: exitPolicy.exitConfidence
        }
    };

    // --- BTC POSITION PROTECTION GUARD ---
    // CRITICAL: This guard must NOT depend on currentPositions.side, which may be polluted.
    // Condition: symbol===BTCUSDT AND okxActualSide===long -> ALWAYS suppress, regardless of paper ledger side.
    const isBtcProtected = (() => {
        if (String(input.symbol) !== "BTCUSDT") return false;
        // Primary guard: OKX actual long position exists -> protect unconditionally.
        // Do NOT check currentPositions.side here; it may be short-polluted.
        const okxActualSide = input.state.okxActualSide;
        if (okxActualSide === "long") return true;
        // Fallback: if okxActualSide is unavailable, check paper ledger (best-effort only).
        const hasPaperLong = Array.isArray(input.state.currentPositions) &&
            input.state.currentPositions.some(p => p && p.symbol === "BTCUSDT" && String(p.side).toLowerCase() === "long");
        return hasPaperLong;
    })();

    // --- V2_BTC_PROTECTED_SUPPRESSOR_PRE_AUTHORITY_AUDIT_PROOF ---
    // Emitted ALWAYS (regardless of killSwitch/serverTradeEnabled) for runtime verification.
    // Captures decision/side before and after suppression for audit under any control state.
    if (String(input.symbol) === "BTCUSDT") {
        const decisionBefore = decision.decision;
        const sideBefore = decision.side;
        const decisionAfter = isBtcProtected
            ? (decision.decision === "ENTER" ? "SKIP" : "HOLD")
            : decision.decision;
        const sideAfter = isBtcProtected ? "none" : decision.side;
        console.info(JSON.stringify({
            event: "V2_BTC_PROTECTED_SUPPRESSOR_PRE_AUTHORITY_AUDIT_PROOF",
            symbol: "BTCUSDT",
            okxActualSide: input.state.okxActualSide ?? null,
            hasOkxActualLong: input.state.okxActualSide === "long",
            isBtcProtected,
            decisionBefore,
            sideBefore,
            decisionAfter,
            sideAfter,
            hardBlockReason: isBtcProtected ? "BTCUSDT_OKX_LONG_POSITION_PROTECTED" : null,
            paperLedgerSideCheck: Array.isArray(input.state.currentPositions)
                ? (input.state.currentPositions.find(p => p && (p as any).symbol === "BTCUSDT") as any)?.side ?? "not_found"
                : "no_positions",
            exitPolicyActionBefore: internal.exitPolicy?.action ?? null,
            exitShouldReduceBefore: internal.exitPolicy?.shouldReduce ?? null,
            ts: Date.now()
        }));
    }

    if (isBtcProtected) {
        const suppressedActions = ["ENTER", "ADDON", "CLOSE", "PARTIAL", "REDUCE", "REVERSE", "ORDER_SUBMIT", "HISTORY_WRITE", "LEDGER_PRUNE", "PROTECTIVE_ENSURE"];

        console.info(JSON.stringify({
            event: "POSITION_SIDE_RECONCILE_PROTECTED",
            symbol: String(input.symbol),
            reason: "BTCUSDT_OKX_ACTUAL_LONG_GUARD",
            okxActualSide: input.state.okxActualSide,
            paperLedgerSideCheck: Array.isArray(input.state.currentPositions)
                ? (input.state.currentPositions.find(p => p && p.symbol === "BTCUSDT") as any)?.side ?? "not_found"
                : "no_positions",
            suppressed_actions: suppressedActions,
            pre_suppress_decision: decision.decision,
            pre_suppress_side: decision.side,
            ts: Date.now()
        }));

        // Force decision and side to safe values
        decision.decision = decision.decision === "ENTER" ? "SKIP" : "HOLD";
        decision.side = "none";
        decision.signal = "NONE";
        decision.executionAction = "NONE";

        // Zero out all sizing
        if (decision.risk) {
            decision.risk.stageMarginKrw = 0;
            decision.risk.exposureNotionalKrw = 0;
        }

        // Suppress add-on
        if (decision.lifecycleAuthority) {
            decision.lifecycleAuthority.addOnAllowed = false;
        }

        const hasStructureBreach = Array.isArray(input.state.currentPositions) &&
            input.state.currentPositions.some(p => p && p.symbol === "BTCUSDT" && p.structureBreached === true);

        // Suppress exit/partial/reduce policy
        if (internal.exitPolicy && !hasStructureBreach) {
            internal.exitPolicy.action = "SUPPRESSED";
            internal.exitPolicy.shouldExit = false;
            internal.exitPolicy.shouldReduce = false;
            internal.exitPolicy.shouldPartial = false;
            internal.exitPolicy.reduceRatio = 0;
        }

        // Suppress v2 exit authority
        if (internal.v2ExitAuthority && !hasStructureBreach) {
            (internal.v2ExitAuthority as any).exitAction = "none";
            (internal.v2ExitAuthority as any).shouldExit = false;
        }

        // Suppress v2 partial authority
        if (internal.v2PartialAuthority) {
            (internal.v2PartialAuthority as any).partialAction = "none";
            (internal.v2PartialAuthority as any).shouldPartial = false;
        }

        // Suppress execution output
        if (internal.execution) {
            internal.execution.signal = "NONE";
            internal.execution.side = "none";
            internal.execution.baseSizeIntent = 0;
        }
    }

    // --- V2_STOP_PLAN_PROPAGATION_PROOF ---
    let stopPriceValidFinal = true;
    const stopPriceFinal = decision.lifecycleAuthority?.newStopPrice ?? null;
    if (decision.decision === "ENTER") {
        if (stopPriceFinal == null || isNaN(stopPriceFinal) || stopPriceFinal <= 0) {
            stopPriceValidFinal = false;
        }
        
        console.info(JSON.stringify({
            event: "V2_STOP_PLAN_PROPAGATION_PROOF",
            symbol: String(input.symbol),
            decision: decision.decision,
            side: decision.side,
            stop_price: stopPriceFinal,
            stop_price_valid: stopPriceValidFinal,
            action: stopPriceValidFinal ? "PROPAGATE_TO_BRIDGE" : "FORCE_SKIP_DUE_TO_INVALID_STOP"
        }));

        if (!stopPriceValidFinal) {
            decision.decision = "SKIP";
            decision.side = "none";
            decision.signal = "NONE";
            decision.risk.stageMarginKrw = 0;
            decision.risk.exposureNotionalKrw = 0;
            if (decision.metadata) {
                decision.metadata.v2DecisionFinal = "SKIP";
                decision.metadata.v2SideFinal = "none";
                decision.metadata.expectedMissingCondition = "INVALID_STOP_PRICE_PROPAGATION";
                decision.metadata.expectedNextAction = "WAIT_FOR_VALID_STOP_PRICE";
            }
        }
    }

    // V2_EARLY_NORMALIZATION: Ensure non-ENTER states do not leak candidate values to execution bridge
    // Note: SA and deadlock promotion paths produce ENTER decision with execution.signal === "NONE".
    // In those cases, decision.decision is the authoritative ENTER marker; do NOT zero out side.
    const isValidEnter = decision.decision === "ENTER" && decision.side !== "none";
    if (isValidEnter) {
        if (!decision.signal || decision.signal === "NONE") {
            decision.signal = decision.side === "long" ? "LONG_CANDIDATE" : "SHORT_CANDIDATE";
        }
    }
    if (!decision.metadata) {
        decision.metadata = {};
    }
    
    // V2 Telemetry Extension
    decision.metadata.entry_quality_grade = entryQualityGrade;
    decision.metadata.entry_quality_score = qualityScore;
    decision.metadata.judgment_subtype = judgment.subtype ?? null;
    decision.metadata.zone = zone;
    decision.metadata.trend_side = trendSideCandidate;
    decision.metadata.range_side = rangeSideCandidate;
    decision.metadata.htf_policy = judgment.htf_entry_policy ?? null;
    decision.metadata.promotion_reason = promotionReason;
    decision.metadata.decision_reason = execution.reason;
    decision.metadata.market_mode = marketMode;
    decision.metadata.box_pos = typeof boxPos === "number" && Number.isFinite(boxPos) ? boxPos : undefined;

    if (!isValidEnter) {
        decision.metadata.candidate_side = decision.side;
        decision.metadata.candidate_stageMarginKrw = decision.risk.stageMarginKrw;
        decision.metadata.candidate_exposureNotionalKrw = decision.risk.exposureNotionalKrw;
        decision.metadata.candidate_finalOrderNotionalUsdt = decision.risk.finalOrderNotionalUsdt;
        if (decision.lifecycleAuthority) {
            decision.metadata.candidate_stopPrice = decision.lifecycleAuthority.newStopPrice;
            decision.metadata.candidate_invalidationPx = decision.lifecycleAuthority.invalidationPx;
            decision.lifecycleAuthority.newStopPrice = undefined;
            decision.lifecycleAuthority.invalidationPx = undefined;
        }

        decision.side = "none";
        decision.risk.stageMarginKrw = 0;
        decision.risk.finalOrderNotionalUsdt = 0;
        decision.risk.exposureNotionalKrw = 0;
        decision.committedRiskPlan = undefined;
        decision.executionAction = "NONE";
    }

    const bridgeFinalSignal = (() => {
        if (decision.decision === "ENTER" && decision.side === "long") {
            const snap = String(input.snapshot?.signal ?? "");
            return snap === "paper_long_candidate_v2" ? "paper_long_candidate_v2" : "paper_long_candidate";
        }
        if (decision.decision === "ENTER" && decision.side === "short") {
            const snap = String(input.snapshot?.signal ?? "");
            return snap === "paper_short_candidate_v2" ? "paper_short_candidate_v2" : "paper_short_candidate";
        }
        return decision.signal;
    })();

    console.info(JSON.stringify({
        event: "V2_ENTRY_EXECUTION_BRIDGE_PROOF",
        symbol: String(input.symbol),
        final_decision: decision.decision,
        final_side: decision.side,
        final_signal: bridgeFinalSignal,
        v2_signal_state: decision.signal,
        stage_margin_krw: decision.risk.stageMarginKrw,
        applied_leverage: decision.risk.appliedLeverage,
        exposure_notional_krw: decision.risk.exposureNotionalKrw,
        stop_price: decision.lifecycleAuthority?.newStopPrice ?? null,
        risk_blocked: decision.risk.isBlocked,
        risk_block_reason: decision.risk.blockReason,
        promotion_reason: promotionReason,
        judgment_subtype: judgment.subtype
    }));

    // V2_NO_ENTER_DEADLOCK_RESOLVER: Update history and maps
    const symbolStr = String(input.symbol);
    const hasPosition = v2State.currentPositions.some(p => p.symbol === input.symbol);
    if (!symbolHasPositionMap.has(symbolStr)) {
        symbolHasPositionMap.set(symbolStr, hasPosition);
    } else {
        const hadPosition = symbolHasPositionMap.get(symbolStr) ?? false;
        symbolHasPositionMap.set(symbolStr, hasPosition);

        if (!hadPosition && hasPosition) {
            symbolLastPositionOpenedAtMap.set(symbolStr, input.now);
        }
    }

    if (finalDecision === "ENTER") {
        if (input.evaluationMode !== "diagnostic") {
            symbolLastV2EnterDecisionAtMap.set(symbolStr, input.now);
            symbolCyclesSinceLastEnterMap.set(symbolStr, 0);
        }

        if (isDeadlockProbe) {
            symbolLastProbeAtMap.set(symbolStr, input.now);
            symbolLastProbeSideMap.set(symbolStr, promotedSide ?? "none");
            symbolLastProbeQualityMap.set(symbolStr, qualityScore);
            symbolLastProbeStructureMap.set(symbolStr, `${judgment.regime}|${judgment.subtype ?? "none"}|${zone}`);
        }
    } else if (input.evaluationMode !== "diagnostic") {
        symbolCyclesSinceLastEnterMap.set(symbolStr, (symbolCyclesSinceLastEnterMap.get(symbolStr) ?? 0) + 1);
    }

    let finalCandidateSide: string = "none";
    if (rangeSideCandidate && rangeSideCandidate !== "none") {
        finalCandidateSide = rangeSideCandidate;
    } else if (trendSideCandidate && trendSideCandidate !== "none") {
        finalCandidateSide = trendSideCandidate;
    } else if (v2State.inferredIntentSide && v2State.inferredIntentSide !== "none") {
        finalCandidateSide = v2State.inferredIntentSide;
    } else if (selectedSideFinal && selectedSideFinal !== "none") {
        finalCandidateSide = selectedSideFinal;
    } else if (v2SideAfterPromotion && v2SideAfterPromotion !== "none") {
        finalCandidateSide = v2SideAfterPromotion;
    }

    const histItem: DeadlockHistoryItem = {
        timestamp: input.now,
        decision: finalDecision,
        side: finalCandidateSide,
        qualityScore,
        grade: entryQualityGrade,
        softBlockReason: (finalDecision !== "ENTER" && !hardBlockPresent) ? (blockReason || vetoReason) : null,
        hardBlockPresent,
        readinessOk: paperExecutionReady && signedExecutionReady,
        stopPlanOk: execution.stopPrice != null && !isNaN(execution.stopPrice),
        htfPolicy: judgment.htf_entry_policy ?? "NEUTRAL_HTF_DATA_WAIT",
        zone,
        sideZoneValid
    };

    // Requirement 1: Single authoritative executionAction finalization right before return.
    const finalExecutionAction: import("./types").EngineV2ExecutionAction = (() => {
        if (decision.decision !== "ENTER" || decision.side === "none" || !decision.side) return "NONE";
        const targetSym = String(input.symbol).replace("-SWAP", "").replace("-", "");
        const hasPositionInInput = Array.isArray(input.state.currentPositions) &&
            input.state.currentPositions.some(p => p && String((p as any).symbol).replace("-SWAP", "").replace("-", "") === targetSym && (p as any).side === decision.side && ((p as any).status ?? "open") === "open");
        const hasPositionInBridge = Array.isArray((input as any).bridgeState?.openPositions) &&
            (input as any).bridgeState.openPositions.some((p: any) => p && String(p.symbol).replace("-SWAP", "").replace("-", "") === targetSym && p.side === decision.side && (p.status ?? "open") === "open");
        const hasExistingSameSide = hasPositionInInput || hasPositionInBridge;
        
        const targetSideUpper = String(decision.side).toUpperCase();
        const hasActualOkxSameSide = Array.isArray(input.state.okxActualPositions) &&
            input.state.okxActualPositions.some(p => p && p.symbol === targetSym && String(p.side).toUpperCase() === targetSideUpper);
        
        if (hasExistingSameSide) {
            // Requirement 1: Strictly require BOTH existing same-side position AND policy approval (addOnAllowed === true)
            const policyApproved = addOnPolicy.allowed === true && hasActualOkxSameSide;

            if (decision.lifecycleAuthority) {
                // Do not force true based on position existence alone; strict policy only
                decision.lifecycleAuthority.addOnAllowed = policyApproved;
            }

            if (policyApproved) {
                return "ADDON";
            } else {
                // If position exists but policy rejects Add-on, REJECT and return NONE!
                decision.decision = "REJECT";
                decision.risk.isBlocked = true;
                decision.risk.blockReason = "ADDON_POLICY_DENIED";
                return "NONE";
            }
        }
        
        const finalEnterExecutable =
            decision.decision === "ENTER" &&
            String(decision.side) !== "none" &&
            decision.risk.isBlocked !== true &&
            Number(decision.risk.finalOrderNotionalUsdt ?? 0) > 0 &&
            decision.committedRiskPlan != null &&
            Number(decision.lifecycleAuthority?.newStopPrice ?? 0) > 0;

        if (!finalEnterExecutable) {
            let finalEnterBlockReason = decision.risk.blockReason ?? "UNKNOWN";
            if (!decision.risk.blockReason) {
                if (String(decision.side) === "none") finalEnterBlockReason = "SIDE_MISSING";
                else if (decision.risk.isBlocked === true) finalEnterBlockReason = "RISK_BLOCKED";
                else if (!(Number(decision.risk.finalOrderNotionalUsdt ?? 0) > 0)) finalEnterBlockReason = "ORDER_NOTIONAL_ZERO";
                else if (decision.committedRiskPlan == null) finalEnterBlockReason = "COMMITTED_RISK_PLAN_MISSING";
                else if (!(Number(decision.lifecycleAuthority?.newStopPrice ?? 0) > 0)) finalEnterBlockReason = "STOP_PRICE_INVALID";
            }
            if (decision.metadata) {
                decision.metadata.final_enter_executable = false;
                decision.metadata.final_enter_block_reason = finalEnterBlockReason;
            }
            
            decision.decision = "SKIP";
            return "NONE";
        }

        return "ENTER";
    })();
    decision.executionAction = finalExecutionAction;

    const addonPositionSide: "long" | "short" | null = (() => {
        const ledgerSide = String(ledgerPos?.side ?? "").toLowerCase();
        if (ledgerSide === "long" || ledgerSide === "short") return ledgerSide;
        if (hasShortActual) return "short";
        if (hasLongActual) return "long";
        return null;
    })();
    if (addonPositionSide != null || isAddOn || ledgerPos != null) {
        const authoritySide: "long" | "short" | "none" =
            decision.side === "long" || decision.side === "short" ? decision.side : "none";
        const entryPriceForProof = Number(
            (sameSymbolPos as { entryPrice?: number } | null)?.entryPrice ??
            ledgerPos?.entryPrice ??
            0
        );
        const currentPriceForProof = Number(authoritativeInput.snapshot.lastPrice ?? 0);
        const cooldownBlocked =
            v2CooldownAuthority?.cooldownAction === "block_entry" ||
            v2CooldownAuthority?.cooldownAction === "block_direction" ||
            v2CooldownAuthority?.cooldownAction === "halt" ||
            (v2CooldownAuthority?.directionBlocked != null && v2CooldownAuthority.directionBlocked !== "none");
        const addonEligibilityProof = buildV2AddonEligibilityProof({
            symbol: String(input.symbol),
            positionSide: addonPositionSide,
            authoritySide,
            currentNotionalUsdt: existingSymbolNotionalUsdt > 0
                ? existingSymbolNotionalUsdt
                : Number((sameSymbolPos as { sizeUsd?: number } | null)?.sizeUsd ?? 0),
            addonRequestedNotionalUsdt: Number(
                (v2State as { finalAddonNotionalUsdt?: number }).finalAddonNotionalUsdt ??
                finalOrderNotionalUsdt ??
                0
            ),
            addOnPolicy,
            executionAction: finalExecutionAction,
            finalDecision: decision.decision,
            liveReadinessPassed,
            okxPendingOrdersReady: okxPendingOrdersReady === true,
            minOrderBlockReason: min_order_block_reason,
            riskBlockReason: decision.risk.blockReason ?? null,
            cooldownBlocked,
            cooldownReason: v2CooldownAuthority?.cooldownReason ?? null,
            currentPrice: currentPriceForProof,
            entryPrice: entryPriceForProof
        });
        const addonEligibilityProofKey = [
            addOnPolicy.addonMode ?? "NONE",
            addonPositionSide,
            authoritySide,
            addonEligibilityProof.add_on_allowed,
            addonEligibilityProof.block_reason ?? "none",
            addOnPolicy.reason,
            finalExecutionAction
        ].join("|");
        if (
            shouldEmitV2Proof(
                "V2_ADDON_ELIGIBILITY_PROOF",
                String(input.symbol),
                addonEligibilityProofKey,
                addonEligibilityProof.add_on_allowed === true || addonEligibilityProof.block_reason === "LIVE_ACCOUNT_AUTHORITY_NOT_READY"
            )
        ) {
            console.info(JSON.stringify(addonEligibilityProof));
        }
    }

    // Requirement 1: Non-ENTER 정규화
    normalizeNonEnterDecision(decision);

    const shouldConsumeMicroProbeSetup =
        promotionReason === "CONTINUATION_MICRO_PROBE" &&
        microProbeSetupKeyToConsume != null &&
        decision.decision === "ENTER" &&
        decision.executionAction === "ENTER" &&
        String(decision.side) !== "none" &&
        decision.risk.isBlocked !== true &&
        Number(decision.risk.finalOrderNotionalUsdt ?? 0) > 0 &&
        decision.committedRiskPlan != null &&
        Number(decision.lifecycleAuthority?.newStopPrice ?? 0) > 0;

    if (shouldConsumeMicroProbeSetup) {
        symbolLastProbeAtMap.set(symbolStr, input.now);
        symbolLastProbeSideMap.set(symbolStr, decision.side ?? "none");
        symbolLastProbeQualityMap.set(symbolStr, qualityScore);
        symbolLastProbeStructureMap.set(
            symbolStr,
            microProbeSetupKeyToConsume!
        );

        if (decision.metadata) {
            decision.metadata.micro_probe_setup_consumed = true;
        }
    } else if (promotionReason === "CONTINUATION_MICRO_PROBE") {
        if (decision.metadata) {
            decision.metadata.micro_probe_setup_consumed = false;
        }
    }

    if (finalDecision === "ENTER" && decision.decision !== "ENTER") {
        console.info(JSON.stringify({
            event: "V2_ENTER_HISTORY_FINALIZATION_MISMATCH_PROOF",
            symbol: symbolStr,
            preFinalDecision: finalDecision,
            postFinalDecision: decision.decision,
            executionAction: decision.executionAction,
            riskBlocked: decision.risk.isBlocked,
            riskBlockReason: decision.risk.blockReason,
            promotionReason
        }));
    }

    return { decision, internal };
}

export function normalizeNonEnterDecision(decision: EngineV2Decision): void {
    if (decision.decision !== "ENTER") {
        decision.side = "none";
        decision.executionAction = "NONE";
        
        if (decision.risk) {
            decision.risk.stageMarginKrw = 0;
            decision.risk.exposureNotionalKrw = 0;
            decision.risk.finalOrderNotionalUsdt = 0;
            decision.risk.requestedOrderNotionalUsdt = 0;
            decision.risk.sizeMultiplier = 0; 
        }
        
        if (decision.lifecycleAuthority) {
            const la = decision.lifecycleAuthority as any;
            la.newStopPrice = undefined;
            la.suggestedStopPrice = undefined;
            la.suggestedInvalidationPx = undefined;
        }
        
        if (decision.metadata) {
            const savedShock = decision.metadata.judgmentShockPhase;
            const savedTrend = decision.metadata.judgmentTrendPhase;
            decision.metadata.invalidationPx = undefined;
            decision.metadata.judgmentShockPhase = savedShock;
            decision.metadata.judgmentTrendPhase = savedTrend;
        }
        
        decision.committedRiskPlan = undefined;
    }
}

/**
 * Legacy-to-V2 Input Adapter (Zero Any).
 * Maps legacy complex objects through strict adapter interfaces.
 */
export function adaptV2Input(
    symbol: MarketSymbol,
    now: number,
    snapshot: LegacySnapshotAdapter,
    config: LegacyConfigAdapter,
    state: {
        currentPositions: LegacyPositionAdapter[];
        globalRiskScore: number;
        lossStreaks: Record<string, number>;
        directionalShockState: "UP" | "DOWN" | "NONE" | "UNKNOWN";
        longAllow: boolean;
        shortAllow: boolean;
        executionReadiness: boolean;
        paperExecutionReady?: boolean;
        signedExecutionReady?: boolean;
        freshTickBarrierActive: boolean;
        freshTickExecutionBlocked?: boolean;
        freshTickCompletedCycles: number;
        freshTickRequiredCycles: number;
        entryQualityProfiles?: {
            profit: { qualityScoreAvg: number; emaGapAvg: number; atrPctAvg: number; volumeRatioAvg: number; count: number };
            loss: { qualityScoreAvg: number; emaGapAvg: number; atrPctAvg: number; volumeRatioAvg: number; count: number };
            contaminated: { qualityScoreAvg: number; emaGapAvg: number; atrPctAvg: number; volumeRatioAvg: number; count: number };
        };
        serverTradeEnabled?: boolean;
        closeOnlyMode?: boolean;
        killSwitch?: boolean;
        reconcileSafeMode?: boolean;
        killSwitchActive?: boolean;
        reconcileSafeModeActive?: boolean;
        accountEquityKrw?: number;
        maxUsableMarginKrw?: number;
        exposureNotionalCapKrw?: number;
        symbolExposureNotionalCapKrw?: number;
        finalAddonNotionalUsdt?: number;
        addonMaxNotionalUsdt?: number;
        riskMode?: string | null;
        dailyLossGuardTriggered?: boolean;
        crashState?: string | null;
        pumpState?: string | null;
        pump_state?: string | null;
        okxActualSide?: string;
        okxAuthMode?: "disabled" | "demo" | "live";
        okxAuthReady?: boolean;
        okxDemoEnabled?: boolean;
        okxApiKeyPresent?: boolean;
        okxApiSecretPresent?: boolean;
        okxPassphrasePresent?: boolean;
        okxSimulatedTradingHeaderEnabled?: boolean;
        okxExchangeAuthOptIn?: boolean;
        okxLiveEnabled?: boolean;
        liveBalanceReady?: boolean;
        accountEquityUsdt?: number;
        availableBalanceUsdt?: number;
        okxActualPositionsReady?: boolean;
        actualAccountNotionalUsdtReady?: boolean;
        okxActualPositions?: Array<{ symbol: string; sizeUsd?: number; notionalUsd?: number; side: string }>;
        okxPendingOrdersReady?: boolean;
        okxPendingOrdersNotionalUsdt?: number;
        okxPendingSymbolNotionalUsdt?: number;
        hasSymbolPendingEntry?: boolean;
        hasUnknownPendingNotional?: boolean;
        balanceFetchedAt?: number;
        positionsFetchedAt?: number;
        pendingOrdersFetchedAt?: number;
    },
    v1Result: LegacyResultAdapter,
    recentCandles?: import("../models/types").Candle[],
    evaluationMode?: "authoritative" | "diagnostic",
    runCycleId?: string
): EngineV2Input {
    const htfCandlesRef = snapshot.htf_candles;
    return {
        symbol,
        now,
        evaluationMode,
        run_cycle_id: runCycleId,
        htf_candles: htfCandlesRef,
        candles: recentCandles,
        snapshot: {
            lastPrice: snapshot.lastPrice,
            latestCandleClose: snapshot.latestCandleClose,
            boxHigh: snapshot.boxHigh ?? 0,
            boxLow: snapshot.boxLow ?? 0,
            boxPos:
                typeof snapshot.boxPosDiag === "number" && Number.isFinite(snapshot.boxPosDiag)
                    ? snapshot.boxPosDiag
                    : (snapshot.boxPos ?? 0.5),
            rangeConfidence: snapshot.rangeConfidenceDiag ?? snapshot.rangeConfidence ?? 0,
            ema20: snapshot.ema20 ?? 0,
            emaGap: snapshot.emaGapDiag ?? snapshot.emaGap ?? 0,
            volatilityProxy: snapshot.volatilityProxyDiag ?? snapshot.volatilityProxy ?? 0,
            boxCohesion01: snapshot.boxCohesion01 ?? snapshot.boxCohesionDiag ?? 0,
            breakoutFailureRate: snapshot.breakoutFailureRate ?? snapshot.breakoutFailureRateDiag ?? 0,
            trendWeaknessScore: snapshot.trendWeaknessScore ?? snapshot.trendWeaknessDiag ?? 0,
            rangeOscillationScore: snapshot.rangeOscillationScore ?? snapshot.rangeOscillationDiag ?? 0,
            reviewing_ticks: snapshot.reviewing_ticks ?? 0,
            regimeExitRisk: snapshot.regimeExitRisk ?? 0,
            boxBreakSide: snapshot.boxBreakSide ?? "none",
            signal: snapshot.signal ?? "NONE",
            qualityScore: snapshot.qualityScore ?? 0,
            data_ready: snapshot.data_ready ?? true,
            dump_protection_hit: snapshot.dump_protection_hit ?? false,
            volatility_guard_hit: snapshot.volatility_guard_hit ?? false,
            entryCandidate: snapshot.entryCandidate ?? false,
            signalGateBlockedReason: snapshot.signalGateBlockedReason ?? null,
            rangeSignalDowngraded: snapshot.rangeSignalDowngraded ?? false,
            rangeSignalKeptByRelax: snapshot.rangeSignalKeptByRelax ?? false,
            atr: snapshot.atr ?? snapshot.volatilityProxyDiag ?? 0,
            atr20:
                typeof snapshot.atr20 === "number" && Number.isFinite(snapshot.atr20) && snapshot.atr20 > 0
                    ? snapshot.atr20
                    : (typeof snapshot.atr === "number" && Number.isFinite(snapshot.atr) && snapshot.atr > 0 ? snapshot.atr : null),
            closedClose:
                typeof snapshot.closedClose === "number" && Number.isFinite(snapshot.closedClose)
                    ? snapshot.closedClose
                    : (Array.isArray(recentCandles) && recentCandles.length >= 2
                        ? recentCandles[recentCandles.length - 2].close
                        : (typeof snapshot.latestCandleClose === "number" && Number.isFinite(snapshot.latestCandleClose)
                            ? snapshot.latestCandleClose
                            : null)),
            retestConfirmed: snapshot.retestConfirmed === true,
            retestTouched: snapshot.retestTouched === true,
            retestRejected: snapshot.retestRejected === true,
            swingHighSlope: snapshot.swingHighSlope ?? 0,
            swingLowSlope: snapshot.swingLowSlope ?? 0,
            rangeCenterSlope: snapshot.rangeCenterSlope ?? 0,
            boxHighSlope: snapshot.boxHighSlope ?? 0,
            boxLowSlope: snapshot.boxLowSlope ?? 0,
            ema20Slope: snapshot.ema20Slope ?? 0,
            ema60Slope: snapshot.ema60Slope ?? 0,
            atrExpansion: snapshot.atrExpansion ?? 0,
            volumeExpansion: snapshot.volumeExpansion ?? 0,
            candles: recentCandles,
            htf_candles: htfCandlesRef,
            canonicalRegime: snapshot.canonicalRegime,
            canonicalRegimeSource: snapshot.canonicalRegimeSource,
            canonicalTrendScore: snapshot.canonicalTrendScore,
            canonicalRangeConfidence: snapshot.canonicalRangeConfidence,
            canonicalTrendWeaknessScore: snapshot.canonicalTrendWeaknessScore,
            canonicalRegimeAmbiguous: snapshot.canonicalRegimeAmbiguous,
            ...(typeof snapshot.tickSz === "number" && Number.isFinite(snapshot.tickSz) && snapshot.tickSz > 0
                ? { tickSz: snapshot.tickSz }
                : {})
        },
        config: {
            paperMaxOpenPositions: config.paperMaxOpenPositions,
            paperReentryCooldownMs: config.paperReentryCooldownMs,
            baseSizeUsd: config.baseSizeUsd,
            okxLiveMaxOrderNotionalUsdt: config.okxLiveMaxOrderNotionalUsdt,
            okxLiveMaxAddonNotionalUsdt: config.okxLiveMaxAddonNotionalUsdt ?? null,
            okxLiveMaxSymbolNotionalUsdt: config.okxLiveMaxSymbolNotionalUsdt ?? null,
            okxLiveMaxAccountNotionalUsdt: config.okxLiveMaxAccountNotionalUsdt ?? null,
            okxLiveMaxAddonCount: config.okxLiveMaxAddonCount ?? null,
            okxLiveEmergencyMaxOrderNotionalUsdt: config.okxLiveEmergencyMaxOrderNotionalUsdt ?? null,
            okxLiveMarginReserveRatio: config.okxLiveMarginReserveRatio ?? 0.2,
            paperTakerFeeRate: config.paperTakerFeeRate ?? 0.0005,
            externalMarketContextEnabled: config.externalMarketContextEnabled ?? false,
            externalMarketContextShadowMode: config.externalMarketContextShadowMode !== false,
            externalMarketContextFetchEnabled: config.externalMarketContextFetchEnabled ?? false,
            externalMarketContextWeight: config.externalMarketContextWeight ?? 0.22,
            externalMarketMinSizeMultiplier: config.externalMarketMinSizeMultiplier ?? 0.8,
            externalMarketMaxSizeMultiplier: config.externalMarketMaxSizeMultiplier ?? 1.1,
            externalMarketContextMaxAgeMs: config.externalMarketContextMaxAgeMs ?? 900_000,
            externalMarketEmergencyEventEnabled: config.externalMarketEmergencyEventEnabled ?? false
        },
        state: {
            currentPositions: state.currentPositions.map((p: LegacyPositionAdapter) => {
                const s = String(p.side ?? "").toUpperCase();
                return {
                    symbol: p.symbol,
                    side: s === "LONG" ? "LONG" : s === "SHORT" ? "SHORT" : ("NONE" as any),
                    entryPrice: p.entryPrice,
                    sizeUsd: p.sizeUsd,
                    entryStage: p.entryStage ?? 0,
                    pnlPct: p.pnlPct ?? 0,
                    leverage: p.leverage,
                    ledger_stop_px: p.ledger_stop_px,
                    peakUnrealizedPnlPct: p.peakUnrealizedPnlPct,
                    peakUnrealizedPnlUsd: p.peakUnrealizedPnlUsd,
                    peakPnlUpdatedAt: p.peakPnlUpdatedAt,
                    takeProfitPlan: p.takeProfitPlan,
                    tp1Triggered: p.tp1Triggered,
                    tp2Triggered: p.tp2Triggered,
                    breakevenStopRequired: p.breakevenStopRequired,
                    breakevenStopConfirmed: p.breakevenStopConfirmed,
                    breakevenStopPrice: p.breakevenStopPrice,
                    addonCount: p.addonCount,
                    adverseAddonCount: p.adverseAddonCount,
                    adverseMoveAnchorCandleTs: p.adverseMoveAnchorCandleTs,
                    lastAdverseConfirmationCandleTs: p.lastAdverseConfirmationCandleTs,
                    structureBreached: p.structureBreached === true,
                    slProtectionSatisfied: p.slProtectionSatisfied === true,
                    protectiveSlAlgoId: p.protectiveSlAlgoId,
                    isProtectiveStopRegistered: p.isProtectiveStopRegistered === true,
                    slProtectionProvisional: p.slProtectionProvisional === true,
                    protectiveVisibilityGraceDeadlineMs: p.protectiveVisibilityGraceDeadlineMs,
                    lastReduceReason: p.lastReduceReason,
                    rangeOppositePartialTaken: p.rangeOppositePartialTaken === true,
                    protectivePartialReduceCount: p.protectivePartialReduceCount
                };
            }),
            globalRiskScore: state.globalRiskScore,
            lossStreaks: state.lossStreaks,
            directionalShockState: state.directionalShockState,
            longAllow: state.longAllow,
            shortAllow: state.shortAllow,
            executionReadiness: state.executionReadiness,
            paperExecutionReady: state.paperExecutionReady,
            signedExecutionReady: state.signedExecutionReady,
            freshTickBarrierActive: state.freshTickBarrierActive,
            freshTickExecutionBlocked: state.freshTickExecutionBlocked === true,
            freshTickCompletedCycles: state.freshTickCompletedCycles,
            freshTickRequiredCycles: state.freshTickRequiredCycles,
            entryQualityProfiles: state.entryQualityProfiles,
            serverTradeEnabled: state.serverTradeEnabled,
            closeOnlyMode: state.closeOnlyMode,
            killSwitch: state.killSwitch,
            reconcileSafeMode: state.reconcileSafeMode,
            killSwitchActive: state.killSwitchActive,
            reconcileSafeModeActive: state.reconcileSafeModeActive,
            riskMode: state.riskMode ?? undefined,
            dailyLossGuardTriggered: state.dailyLossGuardTriggered ?? false,
            crashState: state.crashState ?? undefined,
            pumpState: state.pumpState ?? undefined,
            pump_state: state.pump_state ?? undefined,
            accountEquityKrw: state.accountEquityKrw,
            maxUsableMarginKrw: state.maxUsableMarginKrw,
            exposureNotionalCapKrw: state.exposureNotionalCapKrw,
            symbolExposureNotionalCapKrw: state.symbolExposureNotionalCapKrw,
            finalAddonNotionalUsdt: (state as any).finalAddonNotionalUsdt,
            addonMaxNotionalUsdt: (state as any).addonMaxNotionalUsdt,
            okxActualSide: state.okxActualSide,
            okxAuthMode: state.okxAuthMode,
            okxAuthReady: state.okxAuthReady,
            okxDemoEnabled: state.okxDemoEnabled,
            okxApiKeyPresent: state.okxApiKeyPresent,
            okxApiSecretPresent: state.okxApiSecretPresent,
            okxPassphrasePresent: state.okxPassphrasePresent,
            okxSimulatedTradingHeaderEnabled: state.okxSimulatedTradingHeaderEnabled,
            okxExchangeAuthOptIn: state.okxExchangeAuthOptIn,
            okxLiveEnabled: state.okxLiveEnabled,
            liveBalanceReady: state.liveBalanceReady,
            accountEquityUsdt: state.accountEquityUsdt,
            availableBalanceUsdt: state.availableBalanceUsdt,
            okxActualPositionsReady: state.okxActualPositionsReady,
            actualAccountNotionalUsdtReady: state.actualAccountNotionalUsdtReady,
            okxActualPositions: state.okxActualPositions,
            okxPendingOrdersReady: state.okxPendingOrdersReady,
            okxPendingOrdersNotionalUsdt: state.okxPendingOrdersNotionalUsdt,
            okxPendingSymbolNotionalUsdt: state.okxPendingSymbolNotionalUsdt,
            hasSymbolPendingEntry: state.hasSymbolPendingEntry,
            hasUnknownPendingNotional: state.hasUnknownPendingNotional,
            balanceFetchedAt: state.balanceFetchedAt,
            positionsFetchedAt: state.positionsFetchedAt,
            pendingOrdersFetchedAt: state.pendingOrdersFetchedAt,
            lastLossReentryState: (state as any).lastLossReentryState ?? null,
            externalMarketSnapshot: (state as any).externalMarketSnapshot ?? null
        },
        v1Result: {
            regime: v1Result.decision?.regime_state ?? (v1Result as any).regime ?? "UNDEFINED",
            decision: v1Result.decision?.final_decision ?? (v1Result as any).decision ?? "SKIP",
            side: v1Result.intentSide ?? (v1Result as any).side ?? "none",
            isBlocked: !!(v1Result.decision?.reject_reason ?? (v1Result as any).isBlocked)
        }
    };
}

export { clearGlobalShockStates } from "./state/derive";

