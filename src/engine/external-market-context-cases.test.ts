import {
    applyExternalContextToConfidenceScore,
    computeSizeMultiplierFromAlignment,
    evaluateExternalMarketContext,
    normalizeMomentumSignal
} from "../engine-v2/external-market-context";
import { calculateRiskSizing } from "../engine-v2/risk-sizing/policy";
import { evaluateEquityAdaptiveSizing } from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import type { EngineV2Input, ExecutorOutput, MarketJudgmentOutput, RegimeConfidenceOutput } from "../engine-v2/types";

function assertTrue(cond: boolean, msg: string): void {
    if (!cond) throw new Error(msg);
}

function assertClose(actual: number, expected: number, eps: number, msg: string): void {
    if (Math.abs(actual - expected) > eps) {
        throw new Error(`${msg}: expected ${expected}, got ${actual}`);
    }
}

function baseConfig(enabled: boolean, shadowMode = false) {
    return {
        enabled,
        shadowMode,
        weight: 0.22,
        minSizeMultiplier: 0.8,
        maxSizeMultiplier: 1.1,
        maxAgeMs: 900_000,
        emergencyEventEnabled: false
    };
}

function fullSnapshot(now: number): import("../engine-v2/external-market-context").ExternalMarketSnapshot {
    return {
        generatedAt: now,
        maxAgeMs: 900_000,
        unavailableSources: [],
        sources: {},
        nqMomentum: 2,
        esMomentum: 2,
        dxyMomentum: -1.5,
        us10yChange: -0.1,
        newsSentiment: 0.8,
        fetchedAt: now,
        status: "ok"
    };
}

function runExternalMarketContextCases(): void {
    // CASE A — fail-open when feature disabled
    {
        const r = evaluateExternalMarketContext({
            side: "long",
            now: 1_000_000,
            config: baseConfig(false),
            snapshot: {
                nqMomentum: 3,
                fetchedAt: 999_000,
                status: "ok"
            }
        });
        assertTrue(r.externalContextApplied === false, "CASE A applied=false when disabled");
        assertClose(r.externalSizeMultiplier, 1, 1e-9, "CASE A multiplier=1");
        assertClose(r.externalContextScore, 0, 1e-9, "CASE A score neutral");
        assertTrue(r.failOpen === true, "CASE A failOpen");
    }

    // CASE B — fail-open when snapshot unavailable
    {
        const r = evaluateExternalMarketContext({
            side: "long",
            now: 1_000_000,
            config: baseConfig(true),
            snapshot: null
        });
        assertTrue(r.externalContextApplied === false, "CASE B applied=false");
        assertClose(r.externalSizeMultiplier, 1, 1e-9, "CASE B multiplier=1");
        assertTrue(r.externalContextReason.includes("FAIL_OPEN"), "CASE B fail-open reason");
    }

    // CASE C — fail-open when stale
    {
        const r = evaluateExternalMarketContext({
            side: "long",
            now: 2_000_000,
            config: baseConfig(true),
            snapshot: {
                nqMomentum: 2,
                fetchedAt: 500_000,
                status: "ok"
            }
        });
        assertTrue(r.externalContextApplied === false, "CASE C stale → not applied");
        assertClose(r.externalSizeMultiplier, 1, 1e-9, "CASE C multiplier=1 when stale");
    }

    // CASE D — strong agreement boosts size, never zero
    {
        const r = evaluateExternalMarketContext({
            side: "long",
            now: 1_000_000,
            config: baseConfig(true, false),
            snapshot: fullSnapshot(999_000)
        });
        assertTrue(r.externalContextApplied === true, "CASE D applied");
        assertTrue(r.externalSizeMultiplier > 1.0, "CASE D strong agreement > 1");
        assertTrue(r.externalSizeMultiplier <= 1.1, "CASE D capped at max");
        assertTrue(r.externalSizeMultiplier > 0, "CASE D never zero");
    }

    // CASE E — strong conflict reduces size but stays >= min
    {
        const r = evaluateExternalMarketContext({
            side: "long",
            now: 1_000_000,
            config: baseConfig(true, false),
            snapshot: {
                generatedAt: 999_000,
                maxAgeMs: 900_000,
                unavailableSources: [],
                sources: {},
                nqMomentum: -2,
                esMomentum: -2,
                dxyMomentum: 2,
                us10yChange: 0.2,
                newsSentiment: -0.9,
                fetchedAt: 999_000,
                status: "ok"
            }
        });
        assertTrue(r.externalSizeMultiplier < 1, "CASE E conflict reduces size");
        assertTrue(r.externalSizeMultiplier >= 0.8, "CASE E respects min multiplier");
    }

    // CASE F — SHORT inverts alignment vs LONG
    {
        const snap = fullSnapshot(999_000);
        const longR = evaluateExternalMarketContext({
            side: "long",
            now: 1_000_000,
            config: baseConfig(true, false),
            snapshot: snap
        });
        const shortR = evaluateExternalMarketContext({
            side: "short",
            now: 1_000_000,
            config: baseConfig(true, false),
            snapshot: snap
        });
        assertTrue(longR.sideAlignedScore > 0, "CASE F long aligned positive");
        assertTrue(shortR.sideAlignedScore < 0, "CASE F short aligned negative");
        assertTrue(longR.externalSizeMultiplier > shortR.externalSizeMultiplier, "CASE F long size > short size on bullish macro");
    }

    // CASE G — confidence blend only adjusts score, no hard block in risk sizing
    {
        const strategyScore = 80;
        const external = evaluateExternalMarketContext({
            side: "long",
            now: 1_000_000,
            config: baseConfig(true, false),
            snapshot: {
                ...fullSnapshot(999_000),
                nqMomentum: -3,
                esMomentum: -3
            }
        });
        const blended = applyExternalContextToConfidenceScore(strategyScore, external, 0.22);
        assertTrue(blended < strategyScore, "CASE G bearish external lowers confidence");
        assertTrue(blended >= 0 && blended <= 100, "CASE G blended in range");

        const judgment = { regime: "TREND" } as MarketJudgmentOutput;
        const confidence: RegimeConfidenceOutput = { score: strategyScore, level: "HIGH" };
        const executor = { baseSizeIntent: 1, side: "long", signal: "ENTER" } as ExecutorOutput;
        const input = {
            symbol: "BTCUSDT",
            config: { baseSizeUsd: 100, paperMaxOpenPositions: 3, paperReentryCooldownMs: 0, okxLiveMaxOrderNotionalUsdt: null },
            snapshot: {
                lastPrice: 100_000,
                latestCandleClose: 100_000,
                qualityScore: 85,
                trendWeaknessScore: 0.2,
                emaGap: 0.01,
                data_ready: true
            },
            state: {
                currentPositions: [],
                lossStreaks: {},
                globalRiskScore: 0,
                directionalShockState: "NONE",
                longAllow: true,
                shortAllow: true,
                executionReadiness: true,
                freshTickBarrierActive: false,
                freshTickCompletedCycles: 0,
                freshTickRequiredCycles: 0
            },
            now: Date.now(),
            v1Result: { regime: "TREND", decision: "ENTER", side: "long", isBlocked: false }
        } as EngineV2Input;

        const baseSizing = calculateRiskSizing(judgment, confidence, executor, input, null);
        const extSizing = calculateRiskSizing(judgment, confidence, executor, input, 0.85);
        assertTrue(baseSizing.isBlocked === extSizing.isBlocked, "CASE G external must not flip isBlocked");
        assertTrue(
            extSizing.stageMarginKrw < baseSizing.stageMarginKrw,
            "CASE G external conflict reduces stageMarginKrw only"
        );
    }

    // CASE H — equity adaptive path applies external multiplier after caps, never zero input
    {
        const r = evaluateEquityAdaptiveSizing({
            symbol: "BTCUSDT",
            side: "long",
            orderKind: "ENTRY",
            accountEquityUsdt: 500,
            availableBalanceUsdt: 500,
            entryReferencePrice: 100_000,
            effectiveStopPrice: 99_000,
            appliedLeverage: 10,
            entryQualityGrade: "A",
            existingSymbolNotionalUsdt: 0,
            existingAccountNotionalUsdt: 0,
            lastPrice: 100_000,
            externalSizeMultiplier: 0.85,
            v2AuthorityEntry: true
        });
        assertTrue(r.sizingPassed === true, "CASE H sizing passes with external 0.85");
        assertClose(r.externalSizeMultiplierApplied, 0.85, 1e-9, "CASE H external applied");
        assertTrue(r.finalOrderNotionalUsdt > 0, "CASE H final notional > 0");
    }

    // CASE I — normalize helpers
    {
        assertClose(normalizeMomentumSignal(2), 1, 1e-9, "CASE I momentum clamp +1");
        assertClose(normalizeMomentumSignal(-4), -1, 1e-9, "CASE I momentum clamp -1");
        assertClose(computeSizeMultiplierFromAlignment(0, 0.7, 1.2), 1, 1e-9, "CASE I neutral → 1");
    }

    console.log("external-market-context-cases: ALL PASS");
}

runExternalMarketContextCases();
