/**
 * P0 Regression Suite:
 * 1. Opposite-side Reentry Gate (SL/손절 직후 반대방향 43초 재진입 차단, 최소 300초 + 5m 완성 + 반대방향 구조 확인 시 허용)
 * 2. RANGE Edge Directional Hard Veto (RANGE authority 하에서 boxPos < 0.25 SHORT 차단, boxPos > 0.75 LONG 차단; 진짜 breakout/breakdown + retest + TREND authority 확정 시 허용)
 * 3. 10/06 실제 자동매매 손실 플로우 (FLOW_ETH_2, FLOW_BTC_2) 재현 검증
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import {
    evaluateOppositeSideLossReentryGate,
    type LastLossReentryState
} from "../engine-v2/state/loss-reentry-gate";
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

function makeCandles(basePrice: number, count = 120, trend: "UP" | "DOWN" | "FLAT" = "FLAT", intervalMs = 60_000, startTs = 1000000): Candle[] {
    const candles: Candle[] = [];
    let p = basePrice;
    for (let i = 0; i < count; i++) {
        const delta = trend === "UP" ? 2 : trend === "DOWN" ? -2 : 0;
        const open = p;
        const close = p + delta;
        const high = Math.max(open, close) + 1;
        const low = Math.min(open, close) - 1;
        candles.push({
            ts: startTs + i * intervalMs,
            timestamp: startTs + i * intervalMs,
            open,
            high,
            low,
            close,
            volume: 100
        } as any);
        p = close;
    }
    return candles;
}

function makeLiveBridge(overrides: Record<string, unknown> = {}) {
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
        ...overrides
    };
}

describe("P0 Phase 1: Opposite-side Reentry Gate & RANGE Edge Hard Veto", () => {

    // =========================================================================
    // PART 1: Opposite-side Reentry Gate Unit Tests
    // =========================================================================

    it("1-1. LONG SL 후 43초 만에 SHORT 진입 시도 -> BLOCK (최소 300초 미달)", () => {
        const exitAt = 1_700_000_000_000;
        const now = exitAt + 43_000; // 43초 후

        const lossState: LastLossReentryState = {
            symbol: "ETHUSDT",
            lastLossExitAt: exitAt,
            lastLossExitSide: "long",
            lastLossExitPrice: 2450,
            lastLossEntryPrice: 2470,
            lastLossExitReason: "stop_loss_algo",
            realizedLossNetUsd: -15.5
        };

        const res = evaluateOppositeSideLossReentryGate({
            symbol: "ETHUSDT",
            requestedSide: "short",
            currentPrice: 2445,
            now,
            lastLossState: lossState,
            atr: 10,
            reversalConfirmed: false
        });

        assert.equal(res.allowed, false, "LONG SL 후 43초 SHORT는 반드시 BLOCK되어야 함");
        assert.equal(res.reason, "OPPOSITE_SIDE_LOSS_COOLDOWN_ACTIVE");
    });

    it("1-2. LONG SL 후 300초 경과 + 5m 완성 + reversalConfirmed -> ALLOW", () => {
        const exitAt = 1_700_000_000_000;
        const now = exitAt + 360_000; // 360초 후

        const lossState: LastLossReentryState = {
            symbol: "ETHUSDT",
            lastLossExitAt: exitAt,
            lastLossExitSide: "long",
            lastLossExitPrice: 2450,
            lastLossEntryPrice: 2470,
            lastLossExitReason: "stop_loss_algo",
            realizedLossNetUsd: -15.5
        };

        const candles = makeCandles(2450, 20, "DOWN", 60_000, exitAt - 60_000 * 5);

        const res = evaluateOppositeSideLossReentryGate({
            symbol: "ETHUSDT",
            requestedSide: "short",
            currentPrice: 2440,
            now,
            lastLossState: lossState,
            candles: candles as any,
            atr: 10,
            reversalConfirmed: true,
            structuralEvent: "confirmed_reversal"
        });

        assert.equal(res.allowed, true, "300초 경과 + 5m 완성 + reversalConfirmed는 ALLOW되어야 함");
        assert.equal(res.reason, "OPPOSITE_SIDE_STRUCTURAL_REVERSAL_ALLOWED");
    });

    it("1-3. LONG SL 후 300초 경과했지만 반대방향 구조 확인 없음 -> BLOCK", () => {
        const exitAt = 1_700_000_000_000;
        const now = exitAt + 360_000;

        const lossState: LastLossReentryState = {
            symbol: "ETHUSDT",
            lastLossExitAt: exitAt,
            lastLossExitSide: "long",
            lastLossExitPrice: 2450,
            lastLossEntryPrice: 2470,
            lastLossExitReason: "stop_loss_algo",
            realizedLossNetUsd: -15.5
        };

        const candles = makeCandles(2450, 20, "FLAT", 60_000, exitAt - 60_000 * 5);

        const res = evaluateOppositeSideLossReentryGate({
            symbol: "ETHUSDT",
            requestedSide: "short",
            currentPrice: 2448,
            now,
            lastLossState: lossState,
            candles: candles as any,
            atr: 10,
            reversalConfirmed: false,
            structuralEvent: "none"
        });

        assert.equal(res.allowed, false, "구조 확인 없이는 반대방향 진입 BLOCK되어야 함");
        assert.equal(res.reason, "OPPOSITE_SIDE_STRUCTURAL_CONFIRMATION_REQUIRED");
    });

    // =========================================================================
    // PART 2: RANGE Edge Directional Hard Veto Integration Tests
    // =========================================================================

    it("2-1. RANGE 상태에서 boxPos 0.14 (하단) SHORT 시도 -> BLOCK (Hard Veto)", () => {
        const boxHigh = 2500;
        const boxLow = 2400;
        const lastPrice = boxLow + (boxHigh - boxLow) * 0.14; // boxPos = 0.14
        const candles = makeCandles(2450, 120, "FLAT");

        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 85,
            emaGap: -0.0006,
            boxHigh,
            boxLow,
            boxPos: 0.14,
            atr: 10,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.30,
            boxCohesion01: 0.85,
            breakoutFailureRate: 0.80,
            canonicalRegime: "RANGE",
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": candles, "4h": candles }
        };

        const input = adaptV2Input(
            "ETHUSDT",
            Date.now(),
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: {
                    final_decision: "ENTER",
                    execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "test" }
                },
                side: "short"
            } as any,
            candles,
            "authoritative",
            "test_range_lower_short_block"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        assert.equal(decision.decision, "SKIP", "RANGE boxPos 0.14 SHORT는 SKIP으로 차단되어야 함");
        const vetoProof = proofs.find(p => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF");
        assert.ok(vetoProof, "V2_RANGE_SIDE_ZONE_VETO_PROOF가 반드시 발생해야 함");
        assert.equal(vetoProof.vetoReason, "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT");
    });

    it("2-2. RANGE 상태에서 FTS(Fast Trend Shift)가 발생해도 boxPos 0.14 SHORT -> BLOCK (FTS 예외 금지)", () => {
        const boxHigh = 2500;
        const boxLow = 2400;
        const lastPrice = boxLow + (boxHigh - boxLow) * 0.14; // boxPos = 0.14
        const candles = makeCandles(2450, 120, "DOWN");

        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 85,
            emaGap: -0.0006,
            boxHigh,
            boxLow,
            boxPos: 0.14,
            atr: 10,
            rangeConfidence: 0.70,
            trendWeaknessScore: 0.30,
            boxCohesion01: 0.70,
            canonicalRegime: "RANGE",
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": candles, "4h": candles }
        };

        const input = adaptV2Input(
            "ETHUSDT",
            Date.now(),
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: {
                    final_decision: "ENTER",
                    side: "short",
                    execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "fts" }
                },
                market_subtype: "FAST_TREND_SHIFT",
                side: "short"
            } as any,
            candles,
            "authoritative",
            "test_range_fts_lower_short_block"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        assert.notEqual(decision.decision, "ENTER", "FTS가 발생해도 RANGE 하단 0.14 SHORT는 차단되어야 함");
        const vetoProof = proofs.find(p => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF");
        assert.ok(vetoProof, "V2_RANGE_SIDE_ZONE_VETO_PROOF가 발생해야 함");
        assert.equal(vetoProof.vetoReason, "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT");
    });

    it("2-3. RANGE 상태에서 boxPos 0.85 (상단) LONG 시도 -> BLOCK (Hard Veto)", () => {
        const boxHigh = 2500;
        const boxLow = 2400;
        const lastPrice = boxLow + (boxHigh - boxLow) * 0.85; // boxPos = 0.85
        const candles = makeCandles(2450, 120, "FLAT");

        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_long_candidate",
            entryCandidate: true,
            qualityScore: 85,
            emaGap: 0.0006,
            boxHigh,
            boxLow,
            boxPos: 0.85,
            atr: 10,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.30,
            boxCohesion01: 0.85,
            canonicalRegime: "RANGE",
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": candles, "4h": candles }
        };

        const input = adaptV2Input(
            "ETHUSDT",
            Date.now(),
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: {
                    final_decision: "ENTER",
                    execution: { signal: "LONG_CANDIDATE", side: "long", reason: "test" }
                },
                side: "long"
            } as any,
            candles,
            "authoritative",
            "test_range_upper_long_block"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        assert.equal(decision.decision, "SKIP", "RANGE boxPos 0.85 LONG은 SKIP으로 차단되어야 함");
        const vetoProof = proofs.find(p => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF");
        assert.ok(vetoProof, "V2_RANGE_SIDE_ZONE_VETO_PROOF가 발생해야 함");
        assert.equal(vetoProof.vetoReason, "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG");
    });

    it("2-4. 진짜 breakdown + retest + TREND authority 확정 -> SHORT 허용", () => {
        const boxHigh = 65000;
        const boxLow = 63000;
        const lastPrice = 62700; // boxLow 아래 300달러
        const candles = makeCandles(lastPrice, 120, "DOWN");

        const snap = {
            symbol: "BTCUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 85,
            emaGap: -0.008,
            boxHigh,
            boxLow,
            boxPos: -0.15,
            boxBreakSide: "lower",
            retestConfirmed: true,
            atr: 200,
            rangeConfidence: 0.10,
            trendWeaknessScore: 0.10,
            boxCohesion01: 0.20,
            breakoutFailureRate: 0.10,
            canonicalRegime: "TREND", // 진짜 TREND authority
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": candles, "4h": candles }
        };

        const input = adaptV2Input(
            "BTCUSDT",
            Date.now(),
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: { final_decision: "ENTER", side: "short" },
                retestConfirmed: true,
                boxBreakSide: "lower"
            } as any,
            candles,
            "authoritative",
            "test_trend_breakdown_retest_short_allowed"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const authorityProof = proofs.find(p => p.event === "V2_RANGE_ZONE_AUTHORITY_PROOF" && p.final_regime !== undefined);
        assert.ok(authorityProof, "V2_RANGE_ZONE_AUTHORITY_PROOF 발생");
        assert.equal(authorityProof.range_zone_veto_applicable, false, "TREND authority에서는 RANGE veto 비적용");
    });

    it("2-5. 진짜 breakout + retest + TREND authority 확정 -> LONG 허용", () => {
        const boxHigh = 65000;
        const boxLow = 63000;
        const lastPrice = 65300; // boxHigh 위 300달러
        const candles = makeCandles(lastPrice, 120, "UP");

        const snap = {
            symbol: "BTCUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_long_candidate",
            entryCandidate: true,
            qualityScore: 85,
            emaGap: 0.008,
            boxHigh,
            boxLow,
            boxPos: 1.15,
            boxBreakSide: "upper",
            retestConfirmed: true,
            atr: 200,
            rangeConfidence: 0.10,
            trendWeaknessScore: 0.10,
            boxCohesion01: 0.20,
            breakoutFailureRate: 0.10,
            canonicalRegime: "TREND",
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": candles, "4h": candles }
        };

        const input = adaptV2Input(
            "BTCUSDT",
            Date.now(),
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: { final_decision: "ENTER", side: "long" },
                retestConfirmed: true,
                boxBreakSide: "upper"
            } as any,
            candles,
            "authoritative",
            "test_trend_breakout_retest_long_allowed"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const authorityProof = proofs.find(p => p.event === "V2_RANGE_ZONE_AUTHORITY_PROOF" && p.final_regime !== undefined);
        assert.ok(authorityProof, "V2_RANGE_ZONE_AUTHORITY_PROOF 발생");
        assert.equal(authorityProof.range_zone_veto_applicable, false, "TREND authority에서는 RANGE veto 비적용");
    });

    // =========================================================================
    // PART 3: 10/06 Real Incident Replay Verification
    // =========================================================================

    it("3-1. FLOW_ETH_2 Replay: 01:21:50 롱 SL 후 01:22:33 (43초 경과) 숏 진입 시도 -> BLOCK 증명", () => {
        const slExitAt = 1759710110000; // 01:21:50
        const replayNow = slExitAt + 43000; // 01:22:33 (43초 후)

        const ethLossState: LastLossReentryState = {
            symbol: "ETHUSDT",
            lastLossExitAt: slExitAt,
            lastLossExitSide: "long",
            lastLossExitPrice: 2435.5,
            lastLossEntryPrice: 2452.0,
            lastLossExitReason: "stop_loss_algo",
            realizedLossNetUsd: -14.22
        };

        // 1) 실제 FLOW_ETH_2 위치 (boxPos = 0.10, RANGE 하단) -> RANGE Edge Hard Veto로 1차 차단
        const candles = makeCandles(2433, 120, "DOWN", 60_000, slExitAt - 60_000 * 110);
        const snap = {
            symbol: "ETHUSDT",
            lastPrice: 2433.0,
            latestCandleClose: 2433.0,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 78,
            boxHigh: 2460,
            boxLow: 2430,
            boxPos: 0.10,
            atr: 8.5,
            canonicalRegime: "RANGE",
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": candles, "4h": candles }
        };

        const liveBridge = makeLiveBridge({
            lastLossReentryState: ethLossState
        });

        const input = adaptV2Input(
            "ETHUSDT",
            replayNow,
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            liveBridge as any,
            {
                decision: {
                    final_decision: "ENTER",
                    execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "test" }
                },
                side: "short"
            } as any,
            candles,
            "authoritative",
            "test_replay_flow_eth_2"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        assert.notEqual(
            decision.decision,
            "ENTER",
            "10/06 FLOW_ETH_2: 롱 SL 43초 후 숏 진입은 반드시 차단되어야 함"
        );

        // 2) Opposite Gate 단독 통합 검증:
        // 정상 TREND 호환 모멘텀에서도 43초 경과 상태에서는 Opposite Gate에 의해 HOLD로 차단되어야 함
        const flatCandles = makeCandles(2433, 120, "FLAT");
        const snapTrend = {
            symbol: "ETHUSDT",
            lastPrice: 2433.0,
            latestCandleClose: 2433.0,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 85,
            boxHigh: 2460,
            boxLow: 2430,
            boxPos: 0.40,
            boxBreakSide: "none",
            atr: 8.5,
            rangeConfidence: 0.10,
            trendWeaknessScore: 0.10,
            canonicalRegime: "TREND",
            emaGap: -0.003,
            candles: flatCandles,
            htf_candles: { "5m": flatCandles, "15m": flatCandles, "1h": flatCandles, "4h": flatCandles }
        };

        const inputTrend = adaptV2Input(
            "ETHUSDT",
            replayNow,
            buildV2SnapshotBridge(snapTrend as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            liveBridge as any,
            {
                decision: { final_decision: "ENTER", side: "short" },
                retestConfirmed: true,
                boxBreakSide: "none"
            } as any,
            flatCandles,
            "authoritative",
            "test_replay_flow_eth_2_trend"
        );

        let trendDecision!: ReturnType<typeof runEngineV2>["decision"];
        const trendProofs = captureProofLogs(() => {
            ({ decision: trendDecision } = runEngineV2(inputTrend));
        });

        assert.equal(trendDecision.decision, "HOLD", "SL 43초 후 반대방향 진입은 HOLD로 차단되어야 함");
        const oppositeProof = trendProofs.find(p => p.event === "V2_OPPOSITE_SIDE_LOSS_REENTRY_PROOF");
        assert.ok(oppositeProof, "V2_OPPOSITE_SIDE_LOSS_REENTRY_PROOF 발생");
        assert.equal(oppositeProof.action, "BLOCK");
        assert.equal(oppositeProof.reason, "OPPOSITE_SIDE_LOSS_COOLDOWN_ACTIVE");

        // 3) 손절 43초 시점 Gate 함수 단위 상태 검증
        const gateCheck = evaluateOppositeSideLossReentryGate({
            symbol: "ETHUSDT",
            requestedSide: "short",
            currentPrice: 2433.0,
            now: replayNow,
            lastLossState: ethLossState,
            candles: flatCandles as any,
            atr: 8.5,
            reversalConfirmed: false,
            structuralEvent: "none"
        });
        assert.equal(gateCheck.allowed, false, "43초 경과 시 Opposite Gate 불허");
        assert.equal(gateCheck.reason, "OPPOSITE_SIDE_LOSS_COOLDOWN_ACTIVE");
        assert.equal(gateCheck.elapsedMs, 43000);
    });

    it("3-2. FLOW_BTC_2 Replay: 00:20:18 BTC boxPos 0.1418에서 FTS 숏 진입 시도 -> BLOCK 증명", () => {
        const replayNow = 1759706418000;
        const boxHigh = 86200;
        const boxLow = 84800;
        const boxWidth = boxHigh - boxLow;
        const lastPrice = boxLow + boxWidth * 0.1418; // boxPos = 0.1418

        const candles = makeCandles(lastPrice, 120, "DOWN");
        const snap = {
            symbol: "BTCUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 82,
            boxHigh,
            boxLow,
            boxPos: 0.1418,
            atr: 280,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.30,
            boxCohesion01: 0.85,
            breakoutFailureRate: 0.80,
            canonicalRegime: "RANGE",
            emaGap: -0.003,
            candles,
            htf_candles: { "5m": candles, "15m": candles, "1h": candles, "4h": candles }
        };

        const input = adaptV2Input(
            "BTCUSDT",
            replayNow,
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: {
                    final_decision: "ENTER",
                    side: "short",
                    execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "fts" }
                },
                market_subtype: "FAST_TREND_SHIFT",
                side: "short"
            } as any,
            candles,
            "authoritative",
            "test_replay_flow_btc_2"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const vetoProof = proofs.find(p => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF");

        assert.equal(
            decision.decision,
            "SKIP",
            "10/06 FLOW_BTC_2: RANGE boxPos 0.1418 FTS 숏 진입은 반드시 SKIP으로 차단되어야 함"
        );
        assert.ok(vetoProof, "V2_RANGE_SIDE_ZONE_VETO_PROOF가 발생해야 함");
        assert.equal(vetoProof.vetoReason, "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT");
    });
});
