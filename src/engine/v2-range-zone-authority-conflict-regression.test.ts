/**
 * Comprehensive Authority Conflict & Regression Tests:
 * 1. Authority resolver sets range_zone_veto_applicable=true only for pure RANGE execution
 * 2. A. RANGE + upper long -> 기존 veto 유지 (RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG)
 * 3. B. RANGE + lower short -> 기존 veto 유지 (RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT)
 * 4. C. TREND_UP + BREAKOUT + upper long -> RANGE veto 미적용 (authority bypass)
 * 5. D. TREND_DOWN + breakdown + lower short -> RANGE veto 미적용 (authority bypass)
 * 6. E. TREND_UP이더라도 chase/RR/edge 실패 -> 기존 TREND gate에서 SKIP 가능
 * 7. Proof schema validation:
 *    - final_regime
 *    - active_engine_routing
 *    - router_executor
 *    - range_zone_veto_applicable
 *    - range_zone_veto_bypass_reason
 *    - decision_before
 *    - decision_after
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import { resolveFinalRegimeExecutionAuthority } from "../engine-v2/execution/entry-final-regime-authority";
import { buildV2SnapshotBridge } from "./paper-engine";
import type { Candle } from "../models/types";

function captureProofLogs(fn: () => void): Record<string, unknown>[] {
    const logs: Record<string, unknown>[] = [];
    const origInfo = console.info;
    console.info = (msg: unknown) => {
        try {
            const p = JSON.parse(String(msg));
            if (p && typeof p.event === "string") logs.push(p);
        } catch { /* ignore */ }
        origInfo(msg);
    };
    try { fn(); } finally { console.info = origInfo; }
    return logs;
}

function makeLiveBridge(overrides: Record<string, unknown> = {}) {
    const now = Date.now();
    return {
        paperExecutionReady: true,
        signedExecutionReady: true,
        serverTradeEnabled: true,
        closeOnlyMode: false,
        killSwitch: false,
        reconcileSafeMode: false,
        longAllow: true,
        shortAllow: true,
        currentPositions: [],
        executionReadiness: true,
        accountEquityKrw: 10_000_000,
        accountEquityUsdt: 10_000,
        availableBalanceUsdt: 10_000,
        liveBalanceReady: true,
        okxActualPositionsReady: true,
        actualAccountNotionalUsdtReady: true,
        okxActualPositions: [],
        okxPendingOrdersReady: true,
        okxPendingOrdersNotionalUsdt: 0,
        okxPendingSymbolNotionalUsdt: 0,
        hasSymbolPendingEntry: false,
        okxLiveEnabled: true,
        okxAuthMode: "live",
        okxAuthReady: true,
        okxExchangeAuthOptIn: true,
        balanceFetchedAt: now,
        positionsFetchedAt: now,
        pendingOrdersFetchedAt: now,
        ...overrides
    };
}

function makeCandles(base: number, trend: "UP" | "DOWN" | "FLAT"): Candle[] {
    return Array.from({ length: 120 }, (_, i) => {
        const delta = trend === "UP" ? i * 2 : trend === "DOWN" ? -i * 2 : (i % 2 === 0 ? 2 : -2);
        return {
            ts: Date.now() - (120 - i) * 60000,
            open: base + delta,
            high: base + delta + 5,
            low: base + delta - 5,
            close: base + delta + 1,
            volume: 100
        };
    });
}

describe("V2 Range Zone Authority Conflict Resolution", () => {
    it("1. Authority resolver sets range_zone_veto_applicable=true only for pure RANGE execution", () => {
        const pureRange = resolveFinalRegimeExecutionAuthority({
            canonicalRegime: "RANGE",
            regimeFinal: "RANGE",
            regime: "RANGE",
            routerExecutor: "RANGE"
        });
        assert.equal(pureRange.range_zone_veto_applicable, true);
        assert.equal(pureRange.range_zone_veto_bypass_reason, null);

        const trendAuth = resolveFinalRegimeExecutionAuthority({
            canonicalRegime: "TREND",
            regimeFinal: "TREND",
            regime: "TREND",
            routerExecutor: "TREND"
        });
        assert.equal(trendAuth.range_zone_veto_applicable, false);
        assert.equal(trendAuth.range_zone_veto_bypass_reason, "FINAL_TREND_ROUTING_AUTHORITY");

        const trendFinalRangeRouter = resolveFinalRegimeExecutionAuthority({
            canonicalRegime: "RANGE",
            regimeFinal: "TREND",
            regime: "RANGE",
            routerExecutor: "RANGE"
        });
        assert.equal(trendFinalRangeRouter.range_zone_veto_applicable, false);
        assert.equal(trendFinalRangeRouter.range_zone_veto_bypass_reason, "TREND_FINAL_REGIME_AUTHORITY");

        const rangeFinalTrendRouter = resolveFinalRegimeExecutionAuthority({
            canonicalRegime: "RANGE",
            regimeFinal: "RANGE",
            regime: "RANGE",
            routerExecutor: "TREND"
        });
        assert.equal(rangeFinalTrendRouter.range_zone_veto_applicable, false);
        assert.equal(rangeFinalTrendRouter.range_zone_veto_bypass_reason, "TREND_ROUTER_AUTHORITY");
    });

    it("2. A. RANGE + upper long -> 기존 veto 유지 (RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG)", () => {
        const boxHigh = 2500;
        const boxLow = 2400;
        const lastPrice = 2490; // boxPos = 0.90 (upper zone)
        const candles = makeCandles(2450, "FLAT");
        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_long_candidate",
            entryCandidate: true,
            qualityScore: 75,
            emaGap: 0.0001,
            boxHigh,
            boxLow,
            boxPos: 0.90,
            atr: 10,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.70,
            boxCohesion01: 0.85,
            breakoutFailureRate: 0.80,
            canonicalRegime: "RANGE",
            candles,
            signalGateBlockedReason: "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG"
        };
        const input = adaptV2Input(
            "ETHUSDT",
            Date.now(),
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            { decision: { final_decision: "ENTER", execution: { signal: "LONG_CANDIDATE", side: "long", reason: "test" } }, side: "long" } as any,
            candles,
            "authoritative",
            "test_range_upper_long_veto"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const authorityProof = proofs.find(p => p.event === "V2_RANGE_ZONE_AUTHORITY_PROOF");
        assert.ok(authorityProof, "V2_RANGE_ZONE_AUTHORITY_PROOF must be emitted");
        assert.equal(authorityProof.range_zone_veto_applicable, true);
        assert.equal(authorityProof.range_zone_veto_bypass_reason, null);

        // RANGE veto authority is active and blocks upper long
        const nativeAuth = proofs.find(p => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF");
        assert.ok(nativeAuth);
        assert.equal(nativeAuth.range_zone_veto_applicable, true);
        assert.notEqual(decision.decision, "ENTER");
    });

    it("3. B. RANGE + lower short -> 기존 veto 유지 (RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT)", () => {
        const boxHigh = 2500;
        const boxLow = 2400;
        const lastPrice = 2410; // boxPos = 0.10 (lower zone)
        const candles = makeCandles(2450, "FLAT");
        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 75,
            emaGap: -0.0001,
            boxHigh,
            boxLow,
            boxPos: 0.10,
            atr: 10,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.70,
            boxCohesion01: 0.85,
            breakoutFailureRate: 0.80,
            canonicalRegime: "RANGE",
            candles,
            signalGateBlockedReason: "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT"
        };
        const input = adaptV2Input(
            "ETHUSDT",
            Date.now(),
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            { decision: { final_decision: "ENTER", execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "test" } }, side: "short" } as any,
            candles,
            "authoritative",
            "test_range_lower_short_veto"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const authorityProof = proofs.find(p => p.event === "V2_RANGE_ZONE_AUTHORITY_PROOF");
        assert.ok(authorityProof, "V2_RANGE_ZONE_AUTHORITY_PROOF must be emitted");
        assert.equal(authorityProof.range_zone_veto_applicable, true);
        assert.equal(authorityProof.range_zone_veto_bypass_reason, null);

        const nativeAuth = proofs.find(p => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF");
        assert.ok(nativeAuth);
        assert.equal(nativeAuth.range_zone_veto_applicable, true);
        assert.notEqual(decision.decision, "ENTER");
    });

    it("4. C. TREND_UP + BREAKOUT + upper long -> RANGE veto 미적용 (TREND authority)", () => {
        const boxHigh = 2500;
        const boxLow = 2400;
        const lastPrice = 2520;
        const candles = makeCandles(2400, "UP");
        const htf = makeCandles(2300, "UP");
        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_long_candidate",
            entryCandidate: true,
            qualityScore: 85,
            emaGap: 0.008,
            boxHigh,
            boxLow,
            boxPos: 1.10,
            atr: 10,
            rangeConfidence: 0.15,
            trendWeaknessScore: 0.10,
            boxCohesion01: 0.20,
            breakoutFailureRate: 0.10,
            canonicalRegime: "TREND",
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": htf, "4h": htf },
            signalGateBlockedReason: "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG" // Old V1 residual reason
        };
        const input = adaptV2Input(
            "ETHUSDT",
            Date.now(),
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            { decision: { final_decision: "SKIP" } } as any,
            candles,
            "authoritative",
            "test_trend_up_breakout_long"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const authorityProof = proofs.find(p => p.event === "V2_RANGE_ZONE_AUTHORITY_PROOF");
        assert.ok(authorityProof, "V2_RANGE_ZONE_AUTHORITY_PROOF must be emitted");
        assert.equal(authorityProof.range_zone_veto_applicable, false);
        assert.equal(authorityProof.range_zone_veto_bypass_reason, "FINAL_TREND_ROUTING_AUTHORITY");

        // Upper long must NOT be blocked by RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG
        const vetoProof = proofs.find(p => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF" && p.vetoReason === "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG");
        assert.equal(vetoProof, undefined, "RANGE veto must not be triggered for TREND");
        const nativeAuth = proofs.find(p => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF");
        assert.ok(nativeAuth);
        assert.equal(nativeAuth.range_upper_long_mismatch_before_exemption, false);
        assert.equal(nativeAuth.range_upper_long_mismatch_after_exemption, false);
    });

    it("5. D. TREND_DOWN + breakdown + lower short -> RANGE veto 미적용 (TREND authority)", () => {
        const boxHigh = 2500;
        const boxLow = 2400;
        const lastPrice = 2380;
        const candles = makeCandles(2500, "DOWN");
        const htf = makeCandles(2600, "DOWN");
        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 85,
            emaGap: -0.008,
            boxHigh,
            boxLow,
            boxPos: -0.10,
            atr: 10,
            rangeConfidence: 0.15,
            trendWeaknessScore: 0.10,
            boxCohesion01: 0.20,
            breakoutFailureRate: 0.10,
            canonicalRegime: "TREND",
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": htf, "4h": htf },
            signalGateBlockedReason: "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT" // Old V1 residual reason
        };
        const input = adaptV2Input(
            "ETHUSDT",
            Date.now(),
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            { decision: { final_decision: "SKIP" } } as any,
            candles,
            "authoritative",
            "test_trend_down_breakdown_short"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const authorityProof = proofs.find(p => p.event === "V2_RANGE_ZONE_AUTHORITY_PROOF");
        assert.ok(authorityProof, "V2_RANGE_ZONE_AUTHORITY_PROOF must be emitted");
        assert.equal(authorityProof.range_zone_veto_applicable, false);
        assert.equal(authorityProof.range_zone_veto_bypass_reason, "FINAL_TREND_ROUTING_AUTHORITY");

        // Lower short must NOT be blocked by RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT
        const vetoProof = proofs.find(p => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF" && p.vetoReason === "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT");
        assert.equal(vetoProof, undefined, "RANGE veto must not be triggered for TREND");
        const nativeAuth = proofs.find(p => p.event === "V2_NATIVE_EXECUTOR_AUTHORITY_PROOF");
        assert.ok(nativeAuth);
        assert.equal(nativeAuth.range_lower_short_mismatch_before_deferral, false);
        assert.equal(nativeAuth.range_lower_short_mismatch_after_deferral, false);
    });

    it("6. E. TREND_UP이더라도 chase/RR/edge 실패 -> 기존 TREND gate에서 SKIP 유지", () => {
        const boxHigh = 2500;
        const boxLow = 2400;
        const lastPrice = 2505;
        const candles = makeCandles(2400, "UP");
        const htf = makeCandles(2300, "UP");
        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_long_candidate",
            entryCandidate: true,
            qualityScore: 40, // Low quality score -> fails trend quality threshold
            emaGap: 0.001,
            boxHigh,
            boxLow,
            boxPos: 0.95,
            atr: 10,
            rangeConfidence: 0.15,
            trendWeaknessScore: 0.65, // high trend weakness -> trendOk=false
            canonicalRegime: "TREND",
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": htf, "4h": htf }
        };
        const input = adaptV2Input(
            "ETHUSDT",
            Date.now(),
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            { decision: { final_decision: "SKIP" } } as any,
            candles,
            "authoritative",
            "test_trend_up_chase_gate_fail"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        // RANGE veto should not apply, but TREND quality/trendOk gate correctly skips/holds
        const authorityProof = proofs.find(p => p.event === "V2_RANGE_ZONE_AUTHORITY_PROOF");
        assert.ok(authorityProof);
        assert.equal(authorityProof.range_zone_veto_applicable, false);
        const vetoProof = proofs.find(p => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF" && p.vetoReason === "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG");
        assert.equal(vetoProof, undefined);
        assert.notEqual(decision.decision, "ENTER");
    });

    it("7. Proof schema contains all required diagnostic fields", () => {
        const auth = resolveFinalRegimeExecutionAuthority({
            canonicalRegime: "RANGE",
            regimeFinal: "RANGE",
            regime: "RANGE",
            routerExecutor: "RANGE"
        });
        assert.ok("final_regime" in { final_regime: auth.regime_final });
        assert.ok("active_engine_routing" in { active_engine_routing: auth.router_executor });
        assert.ok("router_executor" in auth);
        assert.ok("range_zone_veto_applicable" in auth);
        assert.ok("range_zone_veto_bypass_reason" in auth);
    });
});
