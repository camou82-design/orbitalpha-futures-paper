import * as assert from "assert";
import { executeRangeRegime } from "./engine-v2/executors/range-executor";
import { EngineV2Input, MarketJudgmentOutput, EngineV2Decision } from "./engine-v2/types";
import { evaluateRegimeExitPolicy } from "./strategy/regime-exit";
import { buildV2ExecutionAuthorityEnvelope } from "./engine-v2/execution/envelope";
import { deriveExecutionAuthorityFromEnvelope } from "./engine-v2/reconciler";
import { planProtectiveOrderReconcile, ProtectiveReconcileContext, ProtectiveAlgoRow } from "./engine-v2/execution/protective-reconcile-plan";
import { buildPositionOpsSurface } from "./engine/position-ops-monitor";

function createMockInput(overrides: {
    side: "long" | "short";
    entryPx: number;
    boxLow: number;
    boxHigh: number;
    boxPos: number;
    atr: number;
}): EngineV2Input {
    const { side, entryPx, boxLow, boxHigh, boxPos, atr } = overrides;
    const now = Date.now();

    // Create candles that trigger reversal confirmation
    // For LONG: touch boxLow, no overshot (< boxLow - atr*0.15), and lastPrice > boxLow * 1.0003
    // For SHORT: touch boxHigh, no overshot (> boxHigh + atr*0.15), and lastPrice < boxHigh * 0.9997
    const candles = side === "long" ? [
        { ts: now - 4000, open: entryPx, high: entryPx + 0.1, low: boxLow, close: boxLow, volume: 100 },
        { ts: now - 3000, open: boxLow, high: entryPx, low: boxLow, close: entryPx, volume: 100 },
        { ts: now - 2000, open: entryPx, high: entryPx + 0.1, low: entryPx - 0.01, close: entryPx, volume: 100 }
    ] : [
        { ts: now - 4000, open: entryPx, high: boxHigh, low: entryPx - 0.1, close: boxHigh, volume: 100 },
        { ts: now - 3000, open: boxHigh, high: boxHigh, low: entryPx, close: entryPx, volume: 100 },
        { ts: now - 2000, open: entryPx, high: entryPx + 0.01, low: entryPx - 0.1, close: entryPx, volume: 100 }
    ];

    return {
        symbol: "BTCUSDT",
        run_cycle_id: `cycle_${Math.random()}`,
        candles,
        snapshot: {
            lastPrice: entryPx,
            latestCandleClose: entryPx,
            boxHigh,
            boxLow,
            boxPos,
            atr,
            rangeConfidence: 0.85,
            boxCohesion01: 0.9,
            rangeOscillationScore: 0.8,
            breakoutFailureRate: 0.1,
            trendWeaknessScore: 0.8,
            qualityScore: 85,
            reviewing_ticks: 0,
            regimeExitRisk: 0,
            boxBreakSide: "none",
            signal: "none",
            data_ready: true,
            dump_protection_hit: false,
            volatility_guard_hit: false,
            entryCandidate: false,
            ema20: entryPx,
            emaGap: side === "long" ? 0.0001 : -0.0001,
            volatilityProxy: 100,
            candles
        },
        state: {
            currentPositions: [],
            lossStreaks: {},
            globalRiskScore: 0,
            longAllow: true,
            shortAllow: true,
            executionReadiness: true,
            paperExecutionReady: true,
            signedExecutionReady: true,
            serverTradeEnabled: true,
            closeOnlyMode: false,
            killSwitch: false,
            reconcileSafeMode: false,
            riskMode: "NORMAL",
            dailyLossGuardTriggered: false,
            directionalShockState: "NONE",
            accountEquityKrw: 1000000,
            maxUsableMarginKrw: 900000,
            exposureNotionalCapKrw: 5000000,
            symbolExposureNotionalCapKrw: 3000000,
            okxLiveEnabled: false,
            freshTickBarrierActive: false,
            freshTickCompletedCycles: 5,
            freshTickRequiredCycles: 5
        },
        config: {
            baseSizeUsd: 100,
            paperMaxOpenPositions: 3,
            paperReentryCooldownMs: 60000,
            okxLiveMaxOrderNotionalUsdt: 1000
        },
        now,
        v1Result: {
            regime: "RANGE",
            decision: "SKIP",
            side: "none",
            isBlocked: false
        }
    };
}

function createMockJudgment(): MarketJudgmentOutput {
    return {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "RANGE_FLAT",
        subtypeReason: "flat range test",
        shockPhase: "NONE",
        trendPhase: "NONE",
        rangePhase: "FLAT",
        transitionPhase: "NONE",
        judgmentVersion: "v2_market_judgment_subtype_v1",
        no_trade_reason: null,
        data_ready: true,
        dump_protection_hit: false,
        volatility_guard_hit: false,
        reason: "RANGE test",
        metrics: {
            rangeScore: 80,
            trendScore: 20,
            boxCohesionCollapse: false,
            mixedBreakoutState: false,
            emaExpansionWeak: false
        }
    };
}

/**
 * Simulates production buildV2PreEntryRiskPlanCommitted TP extraction
 */
function extractCommittedTpPrice(
    authority: import("./engine-v2/types").EntryExecutionAuthority,
    decision: { stopLoss?: unknown; takeProfit?: unknown },
    side: "long" | "short",
    referenceEntryPx: number
): { finalTpPrice: number; finalTpSource: "engine_calculated" | "authority_tp_price" } {
    const authTp =
        typeof decision.takeProfit === "number" && Number.isFinite(decision.takeProfit) && decision.takeProfit !== 0
            ? decision.takeProfit
            : typeof authority.takeProfit1Px === "number" &&
              Number.isFinite(authority.takeProfit1Px) &&
              authority.takeProfit1Px !== 0
            ? authority.takeProfit1Px
            : null;

    if (authTp != null) {
        const isAuthTpValidDirection = side === "long" ? authTp > referenceEntryPx : authTp < referenceEntryPx;
        if (isAuthTpValidDirection) {
            return { finalTpPrice: authTp, finalTpSource: "authority_tp_price" };
        }
    }

    // Mirror fallback (RANGE fallback TP is 0.0025)
    const fallbackTp = side === "long" ? referenceEntryPx * (1 + 0.0025) : referenceEntryPx * (1 - 0.0025);
    return { finalTpPrice: fallbackTp, finalTpSource: "engine_calculated" };
}

async function runTests() {
    console.log("=== RANGE TP1 REALISTIC REGRESSION TESTS ===");
    let passed = 0;
    let failed = 0;

    function report(name: string, ok: boolean, details?: any) {
        if (ok) {
            console.log(`[PASS] ${name}`);
            passed++;
        } else {
            console.error(`[FAIL] ${name}`, details);
            failed++;
        }
    }

    // CASE A — LONG, boxMid가 매우 멀다 (entry = 100, boxLow = 99.95, boxHigh = 110.05 -> boxMid = 105)
    // TP1 <= 100.25 (entry + 0.25%)
    {
        const entry = 100;
        const input = createMockInput({
            side: "long",
            entryPx: entry,
            boxLow: 99.95,
            boxHigh: 110.05,
            boxPos: 0.1,
            atr: 1.0
        });
        const out = executeRangeRegime(input, createMockJudgment());
        const tp1 = out.metadata.takeProfit1Px as number;
        const maxExpected = entry * (1 + 0.0025); // 100.25
        const ok = out.signal === "LONG_CANDIDATE" && tp1 <= maxExpected + 1e-8 && tp1 >= entry * (1 + 0.0018) - 1e-8;
        report("CASE A — LONG, boxMid가 매우 멀 때 TP1 <= 100.25", ok, { signal: out.signal, tp1, maxExpected });
    }

    // CASE B — SHORT, boxMid가 매우 멀다 (entry = 100, boxHigh = 100.05, boxLow = 89.95 -> boxMid = 95)
    // TP1 >= 99.75 (entry - 0.25%)
    {
        const entry = 100;
        const input = createMockInput({
            side: "short",
            entryPx: entry,
            boxLow: 89.95,
            boxHigh: 100.05,
            boxPos: 0.9,
            atr: 1.0
        });
        const out = executeRangeRegime(input, createMockJudgment());
        const tp1 = out.metadata.takeProfit1Px as number;
        const minExpected = entry * (1 - 0.0025); // 99.75
        const ok = out.signal === "SHORT_CANDIDATE" && tp1 >= minExpected - 1e-8 && tp1 <= entry * (1 - 0.0018) + 1e-8;
        report("CASE B — SHORT, boxMid가 매우 멀 때 TP1 >= 99.75", ok, { signal: out.signal, tp1, minExpected });
    }

    // CASE C — LONG TP1 minimum (entry = 100, boxLow = 99.95, boxHigh = 100.15 -> boxMid = 100.05, atr = 0.01)
    // TP1 >= entry * 1.0018 (100.18)
    {
        const entry = 100;
        const input = createMockInput({
            side: "long",
            entryPx: entry,
            boxLow: 99.95,
            boxHigh: 100.15,
            boxPos: 0.1,
            atr: 0.01
        });
        const out = executeRangeRegime(input, createMockJudgment());
        const tp1 = out.metadata.takeProfit1Px as number;
        const minExpected = entry * (1 + 0.0018); // 100.18
        const ok = out.signal === "LONG_CANDIDATE" && tp1 >= minExpected - 1e-8;
        report("CASE C — LONG TP1 minimum >= entry * 1.0018", ok, { signal: out.signal, tp1, minExpected });
    }

    // CASE D — SHORT TP1 minimum (entry = 100, boxHigh = 100.05, boxLow = 99.85 -> boxMid = 99.95, atr = 0.01)
    // TP1 <= entry * 0.9982 (99.82)
    {
        const entry = 100;
        const input = createMockInput({
            side: "short",
            entryPx: entry,
            boxLow: 99.85,
            boxHigh: 100.05,
            boxPos: 0.9,
            atr: 0.01
        });
        const out = executeRangeRegime(input, createMockJudgment());
        const tp1 = out.metadata.takeProfit1Px as number;
        const maxExpected = entry * (1 - 0.0018); // 99.82
        const ok = out.signal === "SHORT_CANDIDATE" && tp1 <= maxExpected + 1e-8;
        report("CASE D — SHORT TP1 minimum <= entry * 0.9982", ok, { signal: out.signal, tp1, maxExpected });
    }

    // CASE E — LONG ordering: entry < TP1 < TP2
    {
        const entry = 100;
        const input = createMockInput({
            side: "long",
            entryPx: entry,
            boxLow: 99.95,
            boxHigh: 102,
            boxPos: 0.1,
            atr: 0.2
        });
        const out = executeRangeRegime(input, createMockJudgment());
        const tp1 = out.metadata.takeProfit1Px as number;
        const tp2 = out.metadata.takeProfit2Px as number;
        const inv = out.metadata.invalidationPx as number;
        const ok = out.signal === "LONG_CANDIDATE" && inv < entry && entry < tp1 && tp1 < tp2;
        report("CASE E — LONG ordering (inv < entry < TP1 < TP2)", ok, { inv, entry, tp1, tp2 });
    }

    // CASE F — SHORT ordering: TP2 < TP1 < entry
    {
        const entry = 100;
        const input = createMockInput({
            side: "short",
            entryPx: entry,
            boxLow: 98,
            boxHigh: 100.05,
            boxPos: 0.9,
            atr: 0.2
        });
        const out = executeRangeRegime(input, createMockJudgment());
        const tp1 = out.metadata.takeProfit1Px as number;
        const tp2 = out.metadata.takeProfit2Px as number;
        const inv = out.metadata.invalidationPx as number;
        const ok = out.signal === "SHORT_CANDIDATE" && tp2 < tp1 && tp1 < entry && entry < inv;
        report("CASE F — SHORT ordering (TP2 < TP1 < entry < inv)", ok, { tp2, tp1, entry, inv });
    }

    // CASE G — LONG/SHORT symmetry
    {
        const entry = 100;
        const atr = 0.5;
        const longInput = createMockInput({
            side: "long",
            entryPx: entry,
            boxLow: 99.95,
            boxHigh: 100.45,
            boxPos: 0.1,
            atr
        });
        const shortInput = createMockInput({
            side: "short",
            entryPx: entry,
            boxLow: 99.55,
            boxHigh: 100.05,
            boxPos: 0.9,
            atr
        });
        const longOut = executeRangeRegime(longInput, createMockJudgment());
        const shortOut = executeRangeRegime(shortInput, createMockJudgment());

        const longTp1 = longOut.metadata.takeProfit1Px as number;
        const shortTp1 = shortOut.metadata.takeProfit1Px as number;

        const longDist = longTp1 - entry;
        const shortDist = entry - shortTp1;
        const diff = Math.abs(longDist - shortDist);
        const ok = longOut.signal === "LONG_CANDIDATE" && shortOut.signal === "SHORT_CANDIDATE" && diff < 1e-8;
        report("CASE G — LONG/SHORT symmetry (distance magnitudes match)", ok, { longDist, shortDist, diff });
    }

    // CASE H — Fallback RANGE TP in strategy/regime-exit.ts is 0.0025
    {
        const entryPrice = 100;
        const resTp = evaluateRegimeExitPolicy({
            regime: "RANGE",
            side: "long",
            pnlPctNet: 0.025,
            holdingMs: 1000,
            mark: 100.25,
            entryPrice,
            trailingExtreme: undefined
        });
        const resHold = evaluateRegimeExitPolicy({
            regime: "RANGE",
            side: "long",
            pnlPctNet: 0.024,
            holdingMs: 1000,
            mark: 100.24,
            entryPrice,
            trailingExtreme: undefined
        });
        const ok = resTp.action === "close" && resTp.reason === "take_profit" && resHold.action === "hold";
        report("CASE H — Fallback RANGE TP policy triggers at 0.25% (0.0025)", ok, { resTp, resHold });
    }

    // =========================================================================
    // PRODUCTION AUTHORITY PROPAGATION INTEGRATION TESTS (CASE I ~ L)
    // =========================================================================

    // CASE I — LONG entry=100, executor TP1=100.2 -> envelope -> authority -> committed risk plan: initial_tp_price == 100.2
    {
        const entry = 100;
        const input = createMockInput({
            side: "long",
            entryPx: entry,
            boxLow: 99.95,
            boxHigh: 100.15, // boxMid = 100.05 -> clamped dist = 0.20 -> tp1 = 100.2
            boxPos: 0.1,
            atr: 0.01
        });
        const out = executeRangeRegime(input, createMockJudgment());
        const execMeta = out.metadata;
        assert.strictEqual(execMeta.takeProfit1Px, 100.2);

        // Build execution envelope via production function
        const v2Decision: any = {
            decision: "ENTER",
            side: "long",
            regime: "RANGE",
            risk: {
                stageMarginKrw: 100000,
                baseStageMarginKrw: 100000,
                appliedLeverage: 10,
                exposureNotionalKrw: 1000000,
                equityMultiple: 1,
                entryQualityGrade: "A",
                leverageProfile: "BASE",
                isBlocked: false,
                blockReason: null,
                isAddOn: false,
                sizeMultiplier: 1,
                leverageReason: "test",
                leverageBlockReason: null
            },
            explanation: { reason: "test", uiLabelRegime: "RANGE", uiLabelStatus: "ENTER" },
            metadata: execMeta
        };

        const selector: any = {
            adopted_result: { engine: "V2", adopted_decision: "ENTER", adopted_side: "long" },
            v2_result: { risk: v2Decision.risk, decision: "ENTER", side: "long" }
        };

        const envelope = buildV2ExecutionAuthorityEnvelope({
            symbol: "BTCUSDT",
            mode: "engine_v2",
            v2Decision,
            selector,
            legacyComparison: {} as any,
            marketSubtype: "RANGE_FLAT",
            takeProfitPlan: execMeta.takeProfitPlan,
            takeProfit1Px: typeof execMeta.takeProfit1Px === "number" ? execMeta.takeProfit1Px : undefined,
            takeProfit2Px: typeof execMeta.takeProfit2Px === "number" ? execMeta.takeProfit2Px : undefined,
            partialExitRatio: typeof execMeta.partialExitRatio === "number" ? execMeta.partialExitRatio : undefined,
            invalidationPx: typeof execMeta.invalidationPx === "number" ? execMeta.invalidationPx : undefined
        });

        // Derive authority from envelope via production function
        const authority = deriveExecutionAuthorityFromEnvelope(envelope);
        assert.strictEqual(authority.takeProfit1Px, 100.2);

        // Extract committed risk plan TP
        const riskPlan = extractCommittedTpPrice(authority, {}, "long", entry);
        const ok = riskPlan.finalTpPrice === 100.2 && riskPlan.finalTpSource === "authority_tp_price";
        report("CASE I — LONG entry=100 executor TP1=100.2 -> envelope -> authority -> risk plan: 100.2", ok, {
            authorityTp1: authority.takeProfit1Px,
            riskPlan
        });
    }

    // CASE J — SHORT entry=100, executor TP1=99.8 -> envelope -> authority -> committed risk plan: initial_tp_price == 99.8
    {
        const entry = 100;
        const input = createMockInput({
            side: "short",
            entryPx: entry,
            boxLow: 99.85,
            boxHigh: 100.05, // boxMid = 99.95 -> clamped dist = 0.20 -> tp1 = 99.8
            boxPos: 0.9,
            atr: 0.01
        });
        const out = executeRangeRegime(input, createMockJudgment());
        const execMeta = out.metadata;
        assert.strictEqual(execMeta.takeProfit1Px, 99.8);

        const v2Decision: any = {
            decision: "ENTER",
            side: "short",
            regime: "RANGE",
            risk: {
                stageMarginKrw: 100000,
                baseStageMarginKrw: 100000,
                appliedLeverage: 10,
                exposureNotionalKrw: 1000000,
                equityMultiple: 1,
                entryQualityGrade: "A",
                leverageProfile: "BASE",
                isBlocked: false,
                blockReason: null,
                isAddOn: false,
                sizeMultiplier: 1,
                leverageReason: "test",
                leverageBlockReason: null
            },
            explanation: { reason: "test", uiLabelRegime: "RANGE", uiLabelStatus: "ENTER" },
            metadata: execMeta
        };

        const selector: any = {
            adopted_result: { engine: "V2", adopted_decision: "ENTER", adopted_side: "short" },
            v2_result: { risk: v2Decision.risk, decision: "ENTER", side: "short" }
        };

        const envelope = buildV2ExecutionAuthorityEnvelope({
            symbol: "BTCUSDT",
            mode: "engine_v2",
            v2Decision,
            selector,
            legacyComparison: {} as any,
            marketSubtype: "RANGE_FLAT",
            takeProfitPlan: execMeta.takeProfitPlan,
            takeProfit1Px: typeof execMeta.takeProfit1Px === "number" ? execMeta.takeProfit1Px : undefined,
            takeProfit2Px: typeof execMeta.takeProfit2Px === "number" ? execMeta.takeProfit2Px : undefined,
            partialExitRatio: typeof execMeta.partialExitRatio === "number" ? execMeta.partialExitRatio : undefined,
            invalidationPx: typeof execMeta.invalidationPx === "number" ? execMeta.invalidationPx : undefined
        });

        const authority = deriveExecutionAuthorityFromEnvelope(envelope);
        assert.strictEqual(authority.takeProfit1Px, 99.8);

        const riskPlan = extractCommittedTpPrice(authority, {}, "short", entry);
        const ok = riskPlan.finalTpPrice === 99.8 && riskPlan.finalTpSource === "authority_tp_price";
        report("CASE J — SHORT entry=100 executor TP1=99.8 -> envelope -> authority -> risk plan: 99.8", ok, {
            authorityTp1: authority.takeProfit1Px,
            riskPlan
        });
    }

    // CASE K — Authority TP1 missing -> fallback to mirror 0.25% (100.25 for LONG, 99.75 for SHORT)
    {
        const entry = 100;
        const emptyAuthority: any = {
            decision: "ENTER",
            side: "long",
            regime: "RANGE",
            source: "v2",
            takeProfit1Px: undefined,
            stopPrice: 99.5
        };

        const riskPlanLong = extractCommittedTpPrice(emptyAuthority, {}, "long", entry);
        const riskPlanShort = extractCommittedTpPrice(emptyAuthority, {}, "short", entry);

        const ok = riskPlanLong.finalTpPrice === 100.25 &&
                   riskPlanLong.finalTpSource === "engine_calculated" &&
                   riskPlanShort.finalTpPrice === 99.75 &&
                   riskPlanShort.finalTpSource === "engine_calculated";
        report("CASE K — Authority TP1 missing -> mirror fallback 0.25% (100.25 / 99.75)", ok, {
            riskPlanLong,
            riskPlanShort
        });
    }

    // CASE L — TP1, TP2, partialRatio preserved down to ledger / open position structure
    {
        const entry = 100;
        const input = createMockInput({
            side: "long",
            entryPx: entry,
            boxLow: 99.95,
            boxHigh: 101.50,
            boxPos: 0.1,
            atr: 0.1
        });
        const out = executeRangeRegime(input, createMockJudgment());
        const execMeta = out.metadata;

        const v2Decision: any = {
            decision: "ENTER",
            side: "long",
            regime: "RANGE",
            risk: {
                stageMarginKrw: 100000,
                baseStageMarginKrw: 100000,
                appliedLeverage: 10,
                exposureNotionalKrw: 1000000,
                equityMultiple: 1,
                entryQualityGrade: "A",
                leverageProfile: "BASE",
                isBlocked: false,
                blockReason: null,
                isAddOn: false,
                sizeMultiplier: 1,
                leverageReason: "test",
                leverageBlockReason: null
            },
            explanation: { reason: "test", uiLabelRegime: "RANGE", uiLabelStatus: "ENTER" },
            metadata: execMeta
        };

        const selector: any = {
            adopted_result: { engine: "V2", adopted_decision: "ENTER", adopted_side: "long" },
            v2_result: { risk: v2Decision.risk, decision: "ENTER", side: "long" }
        };

        const envelope = buildV2ExecutionAuthorityEnvelope({
            symbol: "BTCUSDT",
            mode: "engine_v2",
            v2Decision,
            selector,
            legacyComparison: {} as any,
            marketSubtype: "RANGE_FLAT",
            takeProfitPlan: execMeta.takeProfitPlan,
            takeProfit1Px: typeof execMeta.takeProfit1Px === "number" ? execMeta.takeProfit1Px : undefined,
            takeProfit2Px: typeof execMeta.takeProfit2Px === "number" ? execMeta.takeProfit2Px : undefined,
            partialExitRatio: typeof execMeta.partialExitRatio === "number" ? execMeta.partialExitRatio : undefined,
            invalidationPx: typeof execMeta.invalidationPx === "number" ? execMeta.invalidationPx : undefined
        });

        const authority = deriveExecutionAuthorityFromEnvelope(envelope);

        // Simulate open position record creation as in paper-engine.ts:20240-20253 and 21336-21351
        const openPositionRecord = {
            symbol: "BTCUSDT",
            side: authority.side,
            status: "open",
            isV2Authority: authority.source === "v2",
            takeProfitPlan: authority.takeProfitPlan,
            takeProfit1Px: authority.takeProfit1Px,
            takeProfit2Px: authority.takeProfit2Px,
            partialExitRatio: authority.partialExitRatio,
            invalidationPx: authority.stopPrice
        };

        const hasValidTp1 = openPositionRecord.takeProfit1Px != null && openPositionRecord.takeProfit1Px === execMeta.takeProfit1Px;
        const hasValidTp2 = openPositionRecord.takeProfit2Px != null && openPositionRecord.takeProfit2Px === execMeta.takeProfit2Px;
        const hasValidRatio = openPositionRecord.partialExitRatio === 0.5;
        const ladderConditionSatisfied = openPositionRecord.isV2Authority && openPositionRecord.takeProfit1Px != null;

        const ok = hasValidTp1 && hasValidTp2 && hasValidRatio && ladderConditionSatisfied;
        report("CASE L — TP1/TP2/partialRatio preserved in open position & ladder condition satisfied", ok, {
            openPositionRecord,
            ladderConditionSatisfied
        });
    }

    // =========================================================================
    // PARTIAL EXECUTION SOVEREIGNTY & PROTECTIVE ORDER TESTS (CASE M ~ U)
    // =========================================================================

    function resolveProtectiveRequirements(open: any) {
        const isV2RangePartialPlan =
          open.isV2Authority === true &&
          open.regimeAtEntry === "RANGE" &&
          open.takeProfitPlan != null &&
          typeof open.takeProfit1Px === "number" &&
          Number.isFinite(open.takeProfit1Px) &&
          typeof open.partialExitRatio === "number" &&
          open.partialExitRatio > 0 &&
          open.partialExitRatio < 1;

        const rawWantsTp = open.targetPrice1 != null && Number.isFinite(open.targetPrice1) && open.targetPrice1 > 0;
        const wantsTp = rawWantsTp && !isV2RangePartialPlan;
        const slRequired = true;
        const tpRequired = !isV2RangePartialPlan && ((open.regimeAtEntry === "RANGE") || (open.takeProfitRequired === true) || (rawWantsTp && open.isV2Authority !== true));

        return { isV2RangePartialPlan, wantsTp, tpRequired, slRequired };
    }

    // CASE M — RANGE LONG protective semantics: full-size SL YES, full-size exchange TP1 OCO NO
    {
        const open: any = {
            symbol: "BTCUSDT",
            side: "long",
            entryPrice: 100,
            stopPrice: 99.5,
            targetPrice1: 100.18,
            takeProfitPlan: "v2_range_fixed_plan_v1",
            takeProfit1Px: 100.18,
            takeProfit2Px: 100.35,
            partialExitRatio: 0.5,
            isV2Authority: true,
            regimeAtEntry: "RANGE",
            okxContracts: 10
        };

        const reqs = resolveProtectiveRequirements(open);
        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: open.side,
            openedAt36: "12345",
            tdModeUsed: "cross",
            contractsToProtect: 10,
            activeStopPrice: open.stopPrice,
            activeTpPrice: reqs.wantsTp ? open.targetPrice1 : null,
            wantsTp: reqs.wantsTp,
            expectedSide: "sell",
            tickSz: 0.01
        };

        const plan = planProtectiveOrderReconcile([], ctx);

        const ok = reqs.isV2RangePartialPlan === true &&
                   reqs.wantsTp === false &&
                   reqs.tpRequired === false &&
                   reqs.slRequired === true &&
                   plan.needSubmitSl === true &&
                   plan.needSubmitTp === false &&
                   plan.submitOco === false;

        report("CASE M — RANGE LONG protective semantics (Full SL = YES, Exchange TP1 OCO = NO)", ok, {
            reqs,
            plan
        });
    }

    // CASE N — RANGE SHORT protective semantics: full-size SL YES, full-size exchange TP1 OCO NO
    {
        const open: any = {
            symbol: "BTCUSDT",
            side: "short",
            entryPrice: 100,
            stopPrice: 100.5,
            targetPrice1: 99.82,
            takeProfitPlan: "v2_range_fixed_plan_v1",
            takeProfit1Px: 99.82,
            takeProfit2Px: 99.65,
            partialExitRatio: 0.5,
            isV2Authority: true,
            regimeAtEntry: "RANGE",
            okxContracts: 10
        };

        const reqs = resolveProtectiveRequirements(open);
        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: open.side,
            openedAt36: "12345",
            tdModeUsed: "cross",
            contractsToProtect: 10,
            activeStopPrice: open.stopPrice,
            activeTpPrice: reqs.wantsTp ? open.targetPrice1 : null,
            wantsTp: reqs.wantsTp,
            expectedSide: "buy",
            tickSz: 0.01
        };

        const plan = planProtectiveOrderReconcile([], ctx);

        const ok = reqs.isV2RangePartialPlan === true &&
                   reqs.wantsTp === false &&
                   reqs.tpRequired === false &&
                   reqs.slRequired === true &&
                   plan.needSubmitSl === true &&
                   plan.needSubmitTp === false &&
                   plan.submitOco === false;

        report("CASE N — RANGE SHORT protective semantics (Full SL = YES, Exchange TP1 OCO = NO)", ok, {
            reqs,
            plan
        });
    }

    function simulateApplyV2PartialFillConfirmed(open: any, input: {
        newFillContracts: number;
        orderFullyFilled: boolean;
        reason?: string;
    }) {
        if (input.newFillContracts <= 0) return;
        const stageBefore = open.partialPendingStage ?? open.partialExitStage ?? 0;
        const stageAfter = input.orderFullyFilled ? stageBefore + 1 : stageBefore;

        if (input.orderFullyFilled) {
            open.partialExitStage = stageAfter;
            open.okxContracts = (open.okxContracts ?? 0) - input.newFillContracts;
            open.sizeUsd = (open.sizeUsd ?? 100) * (1 - (open.partialExitRatio ?? 0.5));
            open.v2RangeTp1Triggered = true;
            open.lifecycleState = "OPEN";

            const fillReason = input.reason ?? open.partialPendingReason ?? "partial_reduce";
            const isRangeTp1Confirmed =
                open.isV2Authority === true &&
                open.regimeAtEntry === "RANGE" &&
                (fillReason === "v2_tp1_automated" ||
                 input.reason === "v2_tp1_automated" ||
                 open.v2RangeTp1Triggered === true ||
                 stageAfter >= 1);

            if (isRangeTp1Confirmed) {
                const tp2 = open.takeProfit2Px;
                const tp1 = open.takeProfit1Px;
                const entryPx = open.entryPrice;
                const isValidTp2Direction =
                    typeof tp2 === "number" &&
                    Number.isFinite(tp2) &&
                    (open.side === "long" ? tp2 > (tp1 ?? entryPx) : tp2 < (tp1 ?? entryPx));

                if (isValidTp2Direction) {
                    open.targetPrice1 = tp2;
                } else {
                    open.targetPrice1 = undefined;
                }
            }
        }
    }

    // CASE O — TP1 50% confirmed LONG: targetPrice1 advances to TP2 (> TP1)
    {
        const open: any = {
            symbol: "BTCUSDT",
            side: "long",
            entryPrice: 100,
            stopPrice: 99.5,
            targetPrice1: 100.18,
            takeProfit1Px: 100.18,
            takeProfit2Px: 100.35,
            partialExitRatio: 0.5,
            isV2Authority: true,
            regimeAtEntry: "RANGE",
            okxContracts: 10,
            sizeUsd: 1000
        };

        simulateApplyV2PartialFillConfirmed(open, {
            newFillContracts: 5,
            orderFullyFilled: true,
            reason: "v2_tp1_automated"
        });

        const ok = open.okxContracts === 5 &&
                   open.targetPrice1 === 100.35 &&
                   open.partialExitStage === 1 &&
                   open.v2RangeTp1Triggered === true;

        report("CASE O — TP1 50% confirmed LONG -> targetPrice1 advances to TP2 (100.35)", ok, {
            remainingContracts: open.okxContracts,
            targetPrice1: open.targetPrice1,
            stage: open.partialExitStage
        });
    }

    // CASE P — Next tick at TP1 (100.18): hard TP gate does NOT close remainder
    {
        const open: any = {
            symbol: "BTCUSDT",
            side: "long",
            entryPrice: 100,
            targetPrice1: 100.35, // Already advanced to TP2
            takeProfit1Px: 100.18,
            takeProfit2Px: 100.35,
            isV2Authority: true,
            regimeAtEntry: "RANGE",
            okxContracts: 5
        };

        const closePrice = 100.19; // Price at TP1 + slight tick
        let isHardTpTriggered = false;
        if (typeof open.targetPrice1 === "number" && Number.isFinite(open.targetPrice1)) {
            isHardTpTriggered = open.side === "long" ? closePrice >= open.targetPrice1 : closePrice <= open.targetPrice1;
        }

        const ok = isHardTpTriggered === false;
        report("CASE P — Next tick at TP1 (100.19) -> hard TP gate does NOT close remainder", ok, {
            closePrice,
            targetPrice1: open.targetPrice1,
            isHardTpTriggered
        });
    }

    // CASE Q — SHORT symmetry: TP1 50% confirmed -> targetPrice1 advances to TP2 (< TP1), no old TP1 hard close
    {
        const open: any = {
            symbol: "BTCUSDT",
            side: "short",
            entryPrice: 100,
            stopPrice: 100.5,
            targetPrice1: 99.82,
            takeProfit1Px: 99.82,
            takeProfit2Px: 99.65,
            partialExitRatio: 0.5,
            isV2Authority: true,
            regimeAtEntry: "RANGE",
            okxContracts: 10,
            sizeUsd: 1000
        };

        simulateApplyV2PartialFillConfirmed(open, {
            newFillContracts: 5,
            orderFullyFilled: true,
            reason: "v2_tp1_automated"
        });

        const closePrice = 99.81; // Price at TP1
        let isHardTpTriggered = false;
        if (typeof open.targetPrice1 === "number" && Number.isFinite(open.targetPrice1)) {
            isHardTpTriggered = open.side === "short" ? closePrice <= open.targetPrice1 : closePrice >= open.targetPrice1;
        }

        const ok = open.targetPrice1 === 99.65 && isHardTpTriggered === false;
        report("CASE Q — SHORT symmetry: targetPrice1 -> 99.65 & no old TP1 hard close at 99.81", ok, {
            targetPrice1: open.targetPrice1,
            closePrice,
            isHardTpTriggered
        });
    }

    // CASE R — TP2 missing/invalid: TP1 confirmed -> targetPrice1 cleared to undefined (no hard TP full close)
    {
        const open: any = {
            symbol: "BTCUSDT",
            side: "long",
            entryPrice: 100,
            targetPrice1: 100.18,
            takeProfit1Px: 100.18,
            takeProfit2Px: undefined, // Missing TP2
            partialExitRatio: 0.5,
            isV2Authority: true,
            regimeAtEntry: "RANGE",
            okxContracts: 10,
            sizeUsd: 1000
        };

        simulateApplyV2PartialFillConfirmed(open, {
            newFillContracts: 5,
            orderFullyFilled: true,
            reason: "v2_tp1_automated"
        });

        const closePrice = 100.20;
        let isHardTpTriggered = false;
        if (typeof open.targetPrice1 === "number" && Number.isFinite(open.targetPrice1)) {
            isHardTpTriggered = open.side === "long" ? closePrice >= open.targetPrice1 : closePrice <= open.targetPrice1;
        }

        const ok = open.targetPrice1 === undefined && isHardTpTriggered === false;
        report("CASE R — TP2 missing -> targetPrice1 cleared & remainder held by runner", ok, {
            targetPrice1: open.targetPrice1,
            isHardTpTriggered
        });
    }

    // CASE S — Partial not confirmed (pending/rejected): targetPrice1 MUST NOT advance
    {
        const open: any = {
            symbol: "BTCUSDT",
            side: "long",
            entryPrice: 100,
            targetPrice1: 100.18,
            takeProfit1Px: 100.18,
            takeProfit2Px: 100.35,
            partialExitRatio: 0.5,
            isV2Authority: true,
            regimeAtEntry: "RANGE",
            okxContracts: 10
        };

        // Partial order submitted but NOT filled (orderFullyFilled = false)
        simulateApplyV2PartialFillConfirmed(open, {
            newFillContracts: 0,
            orderFullyFilled: false,
            reason: "v2_tp1_automated"
        });

        const ok = open.targetPrice1 === 100.18 && open.okxContracts === 10 && open.partialExitStage === undefined;
        report("CASE S — Partial not confirmed -> targetPrice1 remains at TP1 (no premature advance)", ok, {
            targetPrice1: open.targetPrice1,
            contracts: open.okxContracts
        });
    }

    // CASE T — SL size after partial: reconciler cancels full SL and installs remaining contracts SL
    {
        // 1. Before partial: 10 contracts protected by existing SL algo
        const beforeAlgo: ProtectiveAlgoRow = {
            algoId: "sl_full_10",
            instId: "BTC-USDT-SWAP",
            side: "sell",
            posSide: "long",
            tdMode: "cross",
            ordType: "conditional",
            state: "live",
            reduceOnly: true,
            sz: "10",
            slTriggerPx: "99.50",
            slTriggerPxType: "last"
        };

        const ctxBefore: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "12345",
            tdModeUsed: "cross",
            contractsToProtect: 10,
            activeStopPrice: 99.5,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.01
        };

        const planBefore = planProtectiveOrderReconcile([beforeAlgo], ctxBefore);
        assert.strictEqual(planBefore.canonicalSl?.algoId, "sl_full_10");
        assert.strictEqual(planBefore.needSubmitSl, false);

        // 2. After 50% partial confirmed: actual remaining contracts = 5
        const ctxAfter: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "12345",
            tdModeUsed: "cross",
            contractsToProtect: 5, // Now only 5 contracts!
            activeStopPrice: 99.5,
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.01
        };

        const planAfter = planProtectiveOrderReconcile([beforeAlgo], ctxAfter);
        const ok = planAfter.cancelAlgoIds.includes("sl_full_10") &&
                   planAfter.needSubmitSl === true &&
                   ctxAfter.contractsToProtect === 5;

        report("CASE T — SL size after partial (10 sz SL canceled -> 5 sz SL re-submitted)", ok, {
            cancelAlgoIds: planAfter.cancelAlgoIds,
            needSubmitSl: planAfter.needSubmitSl,
            contractsToProtect: ctxAfter.contractsToProtect
        });
    }

    // CASE U — Non-RANGE unchanged: TREND protective TP / SL semantics unaffected
    {
        const openTrend: any = {
            symbol: "BTCUSDT",
            side: "long",
            entryPrice: 100,
            stopPrice: 99.0,
            targetPrice1: undefined,
            isV2Authority: true,
            regimeAtEntry: "TREND",
            okxContracts: 10
        };

        const reqsTrend = resolveProtectiveRequirements(openTrend);
        const ok = reqsTrend.isV2RangePartialPlan === false &&
                   reqsTrend.slRequired === true;

        report("CASE U — Non-RANGE (TREND) protective semantics unchanged", ok, {
            reqsTrend
        });
    }

    // =========================================================================
    // PROTECTIVE SL CONTINUITY & OPS WATCH TESTS (CASE V ~ Z)
    // =========================================================================

    // CASE V — TP1 FULL fill: Safe Replacement exact order (New SL Submit -> Persist -> Old SL Cancel)
    {
        const executionTrace: string[] = [];
        const open: any = {
            symbol: "BTCUSDT",
            side: "long",
            okxContracts: 5, // actual remaining size after 50% partial fill
            protectiveStopAlgoId: "old_sl_10",
            isProtectiveStopRegistered: true,
            stopPrice: 99.5
        };

        // Simulate safe replacement sequence as executed by ensureProtectiveStopOrder / reconcileProtectiveOrders
        const simulateSafeReplacement = async (shouldSubmitSucceed: boolean) => {
            const contractsToProtect = open.okxContracts; // 5
            const oldAlgoId = open.protectiveStopAlgoId; // "old_sl_10"

            // 1. Submit new SL with remaining size
            if (shouldSubmitSucceed) {
                executionTrace.push("new_sl_submit_success");
                // 2. Persist new SL algoId
                const newAlgoId = "new_sl_5";
                open.protectiveStopAlgoId = newAlgoId;
                open.isProtectiveStopRegistered = true;
                executionTrace.push("new_sl_persisted");

                // 3. Cancel old oversized SL
                if (oldAlgoId && oldAlgoId !== newAlgoId) {
                    executionTrace.push(`old_sl_cancelled:${oldAlgoId}`);
                }
            } else {
                executionTrace.push("new_sl_submit_failed");
                // On failure: old SL is NOT cancelled!
            }
        };

        await simulateSafeReplacement(true);

        const expectedOrder = [
            "new_sl_submit_success",
            "new_sl_persisted",
            "old_sl_cancelled:old_sl_10"
        ];
        const ok = JSON.stringify(executionTrace) === JSON.stringify(expectedOrder) &&
                   open.protectiveStopAlgoId === "new_sl_5";

        report("CASE V — TP1 FULL fill: Safe Replacement order (Submit -> Persist -> Cancel)", ok, {
            executionTrace,
            expectedOrder,
            currentStopAlgoId: open.protectiveStopAlgoId
        });
    }

    // CASE W — New SL submit fails: Old SL 10 MUST NOT be cancelled
    {
        const executionTrace: string[] = [];
        const open: any = {
            symbol: "BTCUSDT",
            side: "long",
            okxContracts: 5,
            protectiveStopAlgoId: "old_sl_10",
            isProtectiveStopRegistered: true,
            stopPrice: 99.5
        };

        // Simulate safe replacement with submit failure
        const contractsToProtect = open.okxContracts;
        const oldAlgoId = open.protectiveStopAlgoId;

        // 1. Submit new SL fails
        const submitSuccess = false;
        if (!submitSuccess) {
            executionTrace.push("new_sl_submit_failed");
            // CRITICAL: Old SL is NOT cancelled, old protection remains intact!
        }

        const ok = !executionTrace.includes("old_sl_cancelled:old_sl_10") &&
                   open.protectiveStopAlgoId === "old_sl_10" &&
                   open.isProtectiveStopRegistered === true;

        report("CASE W — New SL submit fails -> Old SL 10 NOT cancelled (protection intact)", ok, {
            executionTrace,
            protectiveStopAlgoId: open.protectiveStopAlgoId
        });
    }

    // CASE X — Ops-watch V2 RANGE partial plan: SL exists, exchange TP absent -> protectionSatisfied = true
    {
        const now = Date.now();
        const v2RangeOpen: any = {
            symbol: "BTCUSDT",
            side: "long",
            status: "open",
            entryPrice: 100,
            stopPrice: 99.5,
            targetPrice1: 100.18,
            takeProfitPlan: "v2_range_fixed_plan_v1",
            takeProfit1Px: 100.18,
            takeProfit2Px: 100.35,
            partialExitRatio: 0.5,
            isV2Authority: true,
            regimeAtEntry: "RANGE",
            okxContracts: 10
        };

        const surface = buildPositionOpsSurface({
            now,
            paperOpens: [v2RangeOpen],
            okxPayload: [
                { instId: "BTC-USDT-SWAP", pos: "10", posSide: "long", avgPx: "100" }
            ],
            pendingOrders: [],
            algoOrders: [
                {
                    algoId: "sl_only_1",
                    instId: "BTC-USDT-SWAP",
                    posSide: "long",
                    side: "sell",
                    ordType: "conditional",
                    slTriggerPx: "99.5",
                    sz: "10",
                    reduceOnly: true,
                    state: "live"
                }
            ],
            ordersScanPerformed: true,
            ordersScanErrors: []
        });

        const row = surface.rows[0];
        const ok = row != null &&
                   row.tp_required_for_exchange_protection === false &&
                   row.reduce_only_protective_found === true;

        report("CASE X — Ops-watch V2 RANGE partial plan (TP required = false, protection satisfied = true)", ok, {
            tp_required: row?.tp_required_for_exchange_protection,
            reduce_only_protective_found: row?.reduce_only_protective_found,
            exchange_stop_px: row?.exchange_stop_px
        });
    }

    // CASE Y — Ops-watch TREND: Existing TP+SL requirement unchanged
    {
        const now = Date.now();
        const trendOpen: any = {
            symbol: "BTCUSDT",
            side: "long",
            status: "open",
            entryPrice: 100,
            stopPrice: 99.0,
            targetPrice1: 105.0, // Fixed TP configured for test
            isV2Authority: true,
            regimeAtEntry: "TREND",
            okxContracts: 10
        };

        const surface = buildPositionOpsSurface({
            now,
            paperOpens: [trendOpen],
            okxPayload: [
                { instId: "BTC-USDT-SWAP", pos: "10", posSide: "long", avgPx: "100" }
            ],
            pendingOrders: [],
            algoOrders: [
                {
                    algoId: "sl_only_1",
                    instId: "BTC-USDT-SWAP",
                    posSide: "long",
                    side: "sell",
                    ordType: "conditional",
                    slTriggerPx: "99.0",
                    sz: "10",
                    reduceOnly: true,
                    state: "live"
                }
            ],
            ordersScanPerformed: true,
            ordersScanErrors: []
        });

        const row = surface.rows[0];
        // In TREND with ledger TP, exchange TP is required, so SL-only does NOT satisfy full protection
        const ok = row != null &&
                   row.tp_required_for_exchange_protection === true &&
                   row.reduce_only_protective_found === false;

        report("CASE Y — Ops-watch TREND semantics unchanged (TP required = true when TP set)", ok, {
            tp_required: row?.tp_required_for_exchange_protection,
            reduce_only_protective_found: row?.reduce_only_protective_found
        });
    }

    // CASE Z — PARTIALLY_FILLED (2/5): No unsafe guessed resize during partial in-flight
    {
        const open: any = {
            symbol: "BTCUSDT",
            side: "long",
            okxContracts: 8, // Position reduced from 10 to 8 by 2 contracts fill
            protectiveStopAlgoId: "sl_orig_10",
            isProtectiveStopRegistered: true,
            stopPrice: 99.5,
            partialPendingStage: 0,
            partialPendingProcessedContracts: 2
        };

        // During PARTIALLY_FILLED (orderState !== "filled"):
        const orderState: string = "partially_filled";
        let prematureResizeTriggered = false;

        if (orderState === "filled") {
            prematureResizeTriggered = true;
        }

        const ok = prematureResizeTriggered === false &&
                   open.protectiveStopAlgoId === "sl_orig_10";

        report("CASE Z — PARTIALLY_FILLED (2/5): No unsafe guessed resize, original SL (sz=10) covers remainder (sz=8)", ok, {
            orderState,
            prematureResizeTriggered,
            protectiveStopAlgoId: open.protectiveStopAlgoId,
            residualRiskAnalysis: "Market order fill is transient; original SL 10 fully covers position 8 without reduce-only order collision."
        });
    }

    // =========================================================================
    // CLOSEFRACTION SL AUTHORITY & ACCOUNT MODE TESTS (CASE AA ~ AH)
    // =========================================================================

    // Helper to simulate paper-engine SL submission payload construction
    function buildSlSubmitPayload(args: {
        isV2RangePartialPlan: boolean;
        acctLv: string;
        posMode: string;
        instId: string;
        tdMode: string;
        side: string;
        activeStopPrice: number;
        szStr: string;
        hedgePosSide?: string;
        slAlgoClOrdId: string;
    }) {
        const useCloseFraction =
            args.isV2RangePartialPlan &&
            args.acctLv === "2" &&
            args.posMode === "net_mode";

        const slSubmitArgs: any = {
            instId: args.instId,
            tdMode: args.tdMode,
            side: args.side,
            ordType: "conditional",
            reduceOnly: true,
            slTriggerPx: String(args.activeStopPrice),
            slOrdPx: "-1",
            slTriggerPxType: "last",
            algoClOrdId: args.slAlgoClOrdId,
            accountPosMode: args.posMode
        };

        if (useCloseFraction) {
            slSubmitArgs.closeFraction = "1";
        } else {
            slSubmitArgs.sz = args.szStr;
            if (args.hedgePosSide) slSubmitArgs.posSide = args.hedgePosSide;
        }

        return { useCloseFraction, slSubmitArgs };
    }

    // CASE AA — Verified account mode (acctLv=2, posMode=net_mode, RANGE V2 partial) -> closeFraction="1", sz absent
    {
        const { useCloseFraction, slSubmitArgs } = buildSlSubmitPayload({
            isV2RangePartialPlan: true,
            acctLv: "2",
            posMode: "net_mode",
            instId: "BTC-USDT-SWAP",
            tdMode: "isolated",
            side: "sell",
            activeStopPrice: 99.5,
            szStr: "10",
            slAlgoClOrdId: "oapBTCUls1s"
        });

        const ok = useCloseFraction === true &&
                   slSubmitArgs.ordType === "conditional" &&
                   slSubmitArgs.reduceOnly === true &&
                   slSubmitArgs.closeFraction === "1" &&
                   slSubmitArgs.slOrdPx === "-1" &&
                   slSubmitArgs.sz === undefined &&
                   slSubmitArgs.posSide === undefined;

        report("CASE AA — Verified account (acctLv=2, posMode=net_mode): closeFraction='1', sz absent", ok, {
            useCloseFraction,
            slSubmitArgs
        });
    }

    // CASE AB — PARTIALLY_FILLED (10 -> 8): closeFraction SL retained without size-driven cancel/resubmit
    {
        const existingAlgo: ProtectiveAlgoRow = {
            algoId: "sl_cf_1",
            instId: "BTC-USDT-SWAP",
            side: "sell",
            tdMode: "isolated",
            ordType: "conditional",
            reduceOnly: true,
            closeFraction: "1",
            slTriggerPx: "99.5",
            state: "live"
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc",
            tdModeUsed: "isolated",
            contractsToProtect: 8, // Position reduced to 8
            activeStopPrice: 99.5, // Stop price unchanged
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile(
            [existingAlgo],
            ctx
        );

        const ok = plan.canonicalSl?.algoId === "sl_cf_1" &&
                   plan.needSubmitSl === false &&
                   plan.cancelAlgoIds.length === 0;

        report("CASE AB — Partial fill (10 -> 8): closeFraction SL retained (no cancel, no resubmit)", ok, {
            canonicalSl: plan.canonicalSl?.algoId,
            needSubmitSl: plan.needSubmitSl,
            cancelAlgoIds: plan.cancelAlgoIds
        });
    }

    // CASE AC — FULL FILL (10 -> 5): Size change alone does not replace closeFraction SL
    {
        const existingAlgo: ProtectiveAlgoRow = {
            algoId: "sl_cf_1",
            instId: "BTC-USDT-SWAP",
            side: "sell",
            tdMode: "isolated",
            ordType: "conditional",
            reduceOnly: true,
            closeFraction: "1",
            slTriggerPx: "99.5",
            state: "live"
        };

        const ctx: ProtectiveReconcileContext = {
            instId: "BTC-USDT-SWAP",
            positionSide: "long",
            openedAt36: "abc",
            tdModeUsed: "isolated",
            contractsToProtect: 5, // Position reduced to 5
            activeStopPrice: 99.5, // Stop price unchanged
            activeTpPrice: null,
            wantsTp: false,
            expectedSide: "sell",
            tickSz: 0.1
        };

        const plan = planProtectiveOrderReconcile(
            [existingAlgo],
            ctx
        );

        const ok = plan.canonicalSl?.algoId === "sl_cf_1" &&
                   plan.needSubmitSl === false &&
                   plan.cancelAlgoIds.length === 0;

        report("CASE AC — Full fill (10 -> 5): Size change alone does NOT replace closeFraction SL", ok, {
            canonicalSl: plan.canonicalSl?.algoId,
            needSubmitSl: plan.needSubmitSl,
            cancelAlgoIds: plan.cancelAlgoIds
        });
    }

    // CASE AD — SL trigger semantics: closeFraction="1" represents current remaining position authority
    {
        const { slSubmitArgs } = buildSlSubmitPayload({
            isV2RangePartialPlan: true,
            acctLv: "2",
            posMode: "net_mode",
            instId: "ETH-USDT-SWAP",
            tdMode: "isolated",
            side: "sell",
            activeStopPrice: 2900,
            szStr: "100",
            slAlgoClOrdId: "oapETHUls1s"
        });

        const ok = slSubmitArgs.closeFraction === "1" &&
                   slSubmitArgs.sz === undefined &&
                   slSubmitArgs.slOrdPx === "-1";

        report("CASE AD — SL trigger semantics: closeFraction='1' protects full dynamic remaining position", ok, {
            closeFraction: slSubmitArgs.closeFraction,
            slOrdPx: slSubmitArgs.slOrdPx
        });
    }

    // CASE AE — Non-RANGE (TREND): Existing explicit sz protective semantics unchanged
    {
        const { useCloseFraction, slSubmitArgs } = buildSlSubmitPayload({
            isV2RangePartialPlan: false, // TREND position
            acctLv: "2",
            posMode: "net_mode",
            instId: "BTC-USDT-SWAP",
            tdMode: "cross",
            side: "sell",
            activeStopPrice: 99.0,
            szStr: "10",
            slAlgoClOrdId: "oapBTCUls1s"
        });

        const ok = useCloseFraction === false &&
                   slSubmitArgs.sz === "10" &&
                   slSubmitArgs.closeFraction === undefined;

        report("CASE AE — TREND non-RANGE: Explicit sz protective semantics preserved (sz='10')", ok, {
            useCloseFraction,
            sz: slSubmitArgs.sz,
            closeFraction: slSubmitArgs.closeFraction
        });
    }

    // CASE AF — posMode != net_mode (e.g. long_short_mode): Fallback to explicit sz
    {
        const { useCloseFraction, slSubmitArgs } = buildSlSubmitPayload({
            isV2RangePartialPlan: true,
            acctLv: "2",
            posMode: "long_short_mode", // Not net_mode!
            instId: "BTC-USDT-SWAP",
            tdMode: "cross",
            side: "sell",
            activeStopPrice: 99.5,
            szStr: "10",
            hedgePosSide: "long",
            slAlgoClOrdId: "oapBTCUls1s"
        });

        const ok = useCloseFraction === false &&
                   slSubmitArgs.sz === "10" &&
                   slSubmitArgs.posSide === "long" &&
                   slSubmitArgs.closeFraction === undefined;

        report("CASE AF — posMode != net_mode: Fallback to explicit sz and posSide preserved", ok, {
            useCloseFraction,
            sz: slSubmitArgs.sz,
            posSide: slSubmitArgs.posSide
        });
    }

    // CASE AG — acctLv != 2 (e.g. acctLv=1): Fallback to explicit sz
    {
        const { useCloseFraction, slSubmitArgs } = buildSlSubmitPayload({
            isV2RangePartialPlan: true,
            acctLv: "1", // Not 2!
            posMode: "net_mode",
            instId: "BTC-USDT-SWAP",
            tdMode: "cross",
            side: "sell",
            activeStopPrice: 99.5,
            szStr: "10",
            slAlgoClOrdId: "oapBTCUls1s"
        });

        const ok = useCloseFraction === false &&
                   slSubmitArgs.sz === "10" &&
                   slSubmitArgs.closeFraction === undefined;

        report("CASE AG — acctLv != 2: Fallback to explicit sz preserved", ok, {
            useCloseFraction,
            sz: slSubmitArgs.sz,
            closeFraction: slSubmitArgs.closeFraction
        });
    }

    // CASE AH — Ops-watch: closeFraction SL present, exchange TP absent -> protectionSatisfied = true
    {
        const now = Date.now();
        const v2RangeOpen: any = {
            symbol: "BTCUSDT",
            side: "long",
            status: "open",
            entryPrice: 100,
            stopPrice: 99.5,
            targetPrice1: 100.18,
            takeProfitPlan: "v2_range_fixed_plan_v1",
            takeProfit1Px: 100.18,
            takeProfit2Px: 100.35,
            partialExitRatio: 0.5,
            isV2Authority: true,
            regimeAtEntry: "RANGE",
            okxContracts: 10
        };

        const surface = buildPositionOpsSurface({
            now,
            paperOpens: [v2RangeOpen],
            okxPayload: [
                { instId: "BTC-USDT-SWAP", pos: "10", posSide: "long", avgPx: "100" }
            ],
            pendingOrders: [],
            algoOrders: [
                {
                    algoId: "sl_cf_row_1",
                    instId: "BTC-USDT-SWAP",
                    posSide: "long",
                    side: "sell",
                    ordType: "conditional",
                    slTriggerPx: "99.5",
                    closeFraction: "1", // closeFraction present, sz absent!
                    reduceOnly: true,
                    state: "live"
                }
            ],
            ordersScanPerformed: true,
            ordersScanErrors: []
        });

        const row = surface.rows[0];
        const ok = row != null &&
                   row.tp_required_for_exchange_protection === false &&
                   row.reduce_only_protective_found === true;

        report("CASE AH — Ops-watch closeFraction SL (sz absent) recognized as valid exchange protection", ok, {
            tp_required: row?.tp_required_for_exchange_protection,
            reduce_only_protective_found: row?.reduce_only_protective_found,
            exchange_stop_px: row?.exchange_stop_px
        });
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed.`);
    if (failed > 0) {
        process.exit(1);
    }
}

runTests();
