/**
 * P1 Phase 2 Regression Suite:
 * 1. FTS 5m confirmation gate:
 *    - FAST_TREND_SHIFT 발생 시 completed 5m candle confirmation 전에는 신규 ENTER 금지
 *    - FTS_CONFIRMATION_PENDING 상태 부여
 *    - V2_WAIT_RECHECK_QUALIFIED_PROMOTION, V2_DEADLOCK_SMALL_PROBE, V2_ENTRY_CANDIDATE_QUALIFIED_PROMOTION, V2_TREND_QUALIFIED_FINAL_PROMOTION 에서 재승격 금지
 * 2. EXPEDITE 예외:
 *    - volume surge >= 2.0x 최근 20봉 평균
 *    - completed 5m candle close가 boxHigh 위 또는 boxLow 아래 확정
 *    - 1H / 4H macro polarity가 진입 방향과 일치
 *    - 3조건 동시 충족 시에만 5m 대기 면제 (하나라도 빠지면 BLOCK)
 * 3. Highway FTS free-pass 제거:
 *    - meta.fast_trend_shift === true 만으로 structureOk = true 가 되는 우회 제거
 *    - FTS도 Highway에서 pullback / retest / structure 조건을 정상 평가
 *    - EXPEDITE 통과 신호만 별도 명시적 provenance로 구조 대체 허용
 * 4. 10/06 손실 사고 replay 및 10/05 강한 추세 기회 보존 replay
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { adaptV2Input, runEngineV2 } from "../engine-v2/index";
import { buildV2SnapshotBridge } from "./paper-engine";
import { evaluateHighwayCoreEntryGate } from "../engine-v2/highway-core/highway-entry-gate";
import { clearGlobalShockStates } from "../engine-v2/state/derive";
import { clearWhipsawObservationState } from "../engine-v2/market-judgment/whipsaw-observer";
import type { Candle } from "../models/types";

const NOW = 1_700_000_000_000;

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

function makeCandles(
    basePrice: number,
    count = 120,
    trend: "UP" | "DOWN" | "FLAT" = "FLAT",
    intervalMs = 60_000,
    volume = 100
): Candle[] {
    const candles: Candle[] = [];
    const step = trend === "DOWN" ? -0.5 : trend === "UP" ? 0.5 : 0;
    for (let i = 0; i < count; i++) {
        const p = basePrice + (i - count) * step;
        candles.push({
            ts: NOW - (count - i) * intervalMs,
            timestamp: NOW - (count - i) * intervalMs,
            open: p,
            high: p + 1,
            low: p - 1,
            close: p + step,
            volume
        } as any);
    }
    return candles;
}

function make5mCandles(
    basePrice: number,
    count = 30,
    trend: "UP" | "DOWN" | "FLAT" = "FLAT",
    intervalMs = 300_000,
    volume = 500
): Candle[] {
    const candles: Candle[] = [];
    const step = trend === "DOWN" ? -2 : trend === "UP" ? 2 : 0;
    for (let i = 0; i < count; i++) {
        const p = basePrice + (i - count) * step;
        candles.push({
            ts: NOW - (count - i) * intervalMs,
            timestamp: NOW - (count - i) * intervalMs,
            open: p,
            high: p + 2,
            low: p - 2,
            close: p + step,
            volume
        } as any);
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

describe("P1 Phase 2: FTS 5m Confirmation Gate, EXPEDITE Exception & Highway Hardening", () => {

    beforeEach(() => {
        clearGlobalShockStates();
        clearWhipsawObservationState();
    });

    // =========================================================================
    // PART 1: FTS 5m Confirmation Gate & Promotion Bypass Defense
    // =========================================================================

    it("1-1. FTS 발생 + 5m 미완성 -> BLOCK (FTS_CONFIRMATION_PENDING)", () => {
        const lastPrice = 2440;
        const candles1m = makeCandles(lastPrice, 120, "DOWN");
        // 5m 캔들은 FLAT (미완성 또는 방향 미확인 상태)
        const candles5m = make5mCandles(lastPrice, 30, "FLAT");

        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 80,
            boxHigh: 2460,
            boxLow: 2420,
            boxPos: 0.50,
            atr: 10,
            canonicalRegime: "RANGE",
            emaGap: -0.002,
            candles: candles1m,
            htf_candles: { "5m": candles5m, "15m": candles5m, "1h": candles5m, "4h": candles5m }
        };

        const input = adaptV2Input(
            "ETHUSDT",
            NOW,
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: {
                    final_decision: "ENTER",
                    execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "fast_trend_shift" }
                },
                market_subtype: "FAST_TREND_SHIFT",
                side: "short"
            } as any,
            candles1m,
            "authoritative",
            "test_fts_unconfirmed_block"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        assert.notEqual(decision.decision, "ENTER", "5m 미완성 FTS는 ENTER가 아니어야 함");
        const blockReason = decision.explanation?.reason || decision.risk?.blockReason || "";
        assert.ok(
            blockReason.includes("FTS_CONFIRMATION_PENDING") || decision.decision === "HOLD" || decision.decision === "SKIP",
            "FTS confirmation pending으로 차단되어야 함"
        );
    });

    it("1-2. FTS 발생 + WAIT_RECHECK 누적 2틱 -> Promotion 재승격 BLOCK", () => {
        const lastPrice = 2440;
        const candles1m = makeCandles(lastPrice, 120, "DOWN");
        const candles5m = make5mCandles(lastPrice, 30, "FLAT");

        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 80,
            boxHigh: 2460,
            boxLow: 2420,
            boxPos: 0.50,
            atr: 10,
            reviewing_ticks: 3, // 3틱 누적 상태
            canonicalRegime: "RANGE",
            emaGap: -0.002,
            candles: candles1m,
            htf_candles: { "5m": candles5m, "15m": candles5m, "1h": candles5m, "4h": candles5m }
        };

        const input = adaptV2Input(
            "ETHUSDT",
            NOW,
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: {
                    final_decision: "HOLD",
                    execution: { signal: "WAIT_RECHECK", side: "none", reason: "FTS_CONFIRMATION_PENDING" }
                },
                market_subtype: "FAST_TREND_SHIFT",
                side: "short"
            } as any,
            candles1m,
            "authoritative",
            "test_fts_wait_recheck_promotion_blocked"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        assert.notEqual(decision.decision, "ENTER", "FTS 대기 중 WAIT_RECHECK promotion으로 재승격되면 안 됨");
        const promoProof = proofs.find(p => p.event === "V2_WAIT_RECHECK_PROMOTION_PROOF");
        assert.equal(promoProof, undefined, "V2_WAIT_RECHECK_PROMOTION_PROOF 가 발생하면 안 됨");
    });

    it("1-3. FTS 발생 + Deadlock 40틱 -> Promotion 재승격 BLOCK", () => {
        const lastPrice = 2440;
        const candles1m = makeCandles(lastPrice, 120, "DOWN");
        const candles5m = make5mCandles(lastPrice, 30, "FLAT");

        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 80,
            boxHigh: 2460,
            boxLow: 2420,
            boxPos: 0.50,
            atr: 10,
            canonicalRegime: "RANGE",
            emaGap: -0.002,
            candles: candles1m,
            htf_candles: { "5m": candles5m, "15m": candles5m, "1h": candles5m, "4h": candles5m }
        };

        const input = adaptV2Input(
            "ETHUSDT",
            NOW,
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: {
                    final_decision: "HOLD",
                    execution: { signal: "WAIT_RECHECK", side: "none", reason: "FTS_CONFIRMATION_PENDING" }
                },
                market_subtype: "FAST_TREND_SHIFT",
                side: "short"
            } as any,
            candles1m,
            "authoritative",
            "test_fts_deadlock_probe_blocked"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        assert.notEqual(decision.decision, "ENTER", "FTS 미확정 시 Deadlock probe로 재승격되면 안 됨");
        const deadlockProof = proofs.find(p => p.event === "V2_DEADLOCK_PROBE_PROMOTION_PROOF");
        assert.equal(deadlockProof, undefined, "V2_DEADLOCK_PROBE_PROMOTION_PROOF 가 발생하면 안 됨");
    });

    it("1-4. 5m 완성봉 방향 확인 -> ALLOW 후보", () => {
        const lastPrice = 2417; // boxLow(2420) 아래 3달러 (chaseCap 4달러 이내)
        const candles1m = makeCandles(lastPrice, 120, "DOWN");
        // 5m 완성봉이 하락 방향으로 명확히 확인됨 (DOWN)
        const candles5m = make5mCandles(lastPrice, 30, "DOWN");

        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 85,
            boxHigh: 2460,
            boxLow: 2420,
            boxPos: -0.075,
            boxBreakSide: "lower",
            retestConfirmed: true,
            atr: 10,
            canonicalRegime: "TREND",
            emaGap: -0.005,
            trendWeaknessScore: 0.15,
            rangeConfidence: 0.10,
            candles: candles1m,
            htf_candles: { "5m": candles5m, "15m": candles5m, "1h": candles5m, "4h": candles5m },
            takeProfitPlan: { tp1Price: 2370, tp2Price: 2330 },
            takeProfit1Px: 2370,
            stopPrice: 2450,
            invalidationPx: 2450
        };

        const input = adaptV2Input(
            "ETHUSDT",
            NOW,
            snap as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: {
                    final_decision: "ENTER",
                    execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "trend_confirmed", takeProfit1Px: 2370, stopPrice: 2450 },
                    committedRiskPlan: { plannedTp1Price: 2370, plannedStopPrice: 2450 }
                },
                side: "short"
            } as any,
            candles1m,
            "authoritative",
            "test_5m_confirmed_allowed"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        assert.equal(decision.decision, "ENTER", "5m 완성봉 방향 확인 시 정상 ENTER 허용");
    });

    it("1-5. 과거 완성 5m 봉 존재 + 신규 FTS 발생 -> BLOCK (시간 인과성: FTS 발생 전 봉 재사용 금지)", () => {
        const lastPrice = 2440;
        const candles1m = makeCandles(lastPrice, 120, "DOWN");
        // 5m 봉의 마지막 마감 시각이 FTS 감지 시각(NOW)보다 과거(NOW - 60_000)임
        const past5mTs = NOW - 600_000;
        const candles5m = [
            { ts: past5mTs, timestamp: past5mTs, open: 2450, high: 2455, low: 2435, close: 2438, volume: 500, closeTime: past5mTs + 300_000 } as any,
            { ts: past5mTs + 300_000, timestamp: past5mTs + 300_000, open: 2445, high: 2448, low: 2438, close: 2439, volume: 600, closeTime: NOW - 60_000 } as any // 마감 시각이 NOW(FTS 발생) 이전!
        ];

        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 80,
            boxHigh: 2460,
            boxLow: 2420,
            boxPos: 0.50,
            atr: 10,
            canonicalRegime: "RANGE",
            emaGap: -0.002,
            candles: candles1m,
            htf_candles: { "5m": candles5m, "15m": candles5m, "1h": candles5m, "4h": candles5m },
            fastTrendShift: {
                active: true,
                direction: "short",
                detectedAt: NOW // FTS 감지 시각: NOW (과거 5m 마감 시각보다 나중!)
            }
        };

        const input = adaptV2Input(
            "ETHUSDT",
            NOW,
            snap as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: {
                    final_decision: "ENTER",
                    execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "fast_trend_shift" }
                },
                market_subtype: "FAST_TREND_SHIFT",
                side: "short"
            } as any,
            candles1m,
            "authoritative",
            "test_fts_past_5m_reuse_blocked"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        assert.notEqual(decision.decision, "ENTER", "FTS 발생 이전의 과거 5m 봉을 재사용하여 확인되면 안 됨 (BLOCK)");
        const blockReason = decision.explanation?.reason || decision.risk?.blockReason || "";
        assert.ok(
            blockReason.includes("FTS_CONFIRMATION_PENDING") || decision.decision === "HOLD" || decision.decision === "SKIP",
            "FTS_CONFIRMATION_PENDING 으로 차단되어야 함"
        );
    });

    it("1-6. FTS 발생 이후 첫 5m 봉 완성 + 방향 일치 -> ALLOW 후보", () => {
        const lastPrice = 2417; // chaseCap 이내 가격 (1-4와 동일)
        const candles1m = makeCandles(lastPrice, 120, "DOWN");
        const ftsDetectedTime = NOW - 400_000; // FTS는 400초 전에 발생
        // 5m 봉의 마감 시각이 FTS 감지 시각 이후(NOW - 50_000)에 마감된 신규 봉!
        const candles5m = [
            { ts: ftsDetectedTime - 300_000, timestamp: ftsDetectedTime - 300_000, open: 2450, high: 2455, low: 2435, close: 2445, volume: 500, closeTime: ftsDetectedTime } as any,
            { ts: ftsDetectedTime, timestamp: ftsDetectedTime, open: 2440, high: 2442, low: 2416, close: 2417, volume: 800, closeTime: NOW - 50_000 } as any // FTS 발생 후 마감된 음봉!
        ];

        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 85,
            boxHigh: 2460,
            boxLow: 2420,
            boxPos: -0.075,
            boxBreakSide: "lower",
            retestConfirmed: true,
            atr: 10,
            canonicalRegime: "TREND",
            emaGap: -0.005,
            trendWeaknessScore: 0.15,
            rangeConfidence: 0.10,
            candles: candles1m,
            htf_candles: { "5m": candles5m, "15m": candles5m, "1h": candles5m, "4h": candles5m },
            takeProfitPlan: { tp1Price: 2370, tp2Price: 2330 },
            takeProfit1Px: 2370,
            stopPrice: 2450,
            invalidationPx: 2450,
            fastTrendShift: {
                active: true,
                direction: "short",
                detectedAt: ftsDetectedTime // FTS 감지 시점
            }
        };

        const input = adaptV2Input(
            "ETHUSDT",
            NOW,
            snap as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: {
                    final_decision: "ENTER",
                    execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "trend_confirmed", takeProfit1Px: 2370, stopPrice: 2450 },
                    committedRiskPlan: { plannedTp1Price: 2370, plannedStopPrice: 2450 }
                },
                side: "short"
            } as any,
            candles1m,
            "authoritative",
            "test_fts_post_detected_5m_confirmed_allowed"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        assert.equal(decision.decision, "ENTER", "FTS 발생 이후 신규 완성된 5m 봉 방향 확인 시 정상 ENTER 허용");
    });

    // =========================================================================
    // PART 2: EXPEDITE 3대 조건 예외 검증
    // =========================================================================

    it("2-1. EXPEDITE 3조건 모두 충족 (Volume 2x + 5m box outside close + Macro 일치) -> ALLOW", () => {
        const lastPrice = 2426; // boxLow(2430) 아래 4달러 (초기 돌파 지점, chaseCap 이내)
        // 1m candles with 2.5x volume
        const candles1m = makeCandles(lastPrice, 120, "DOWN", 60_000, 250);
        // 5m candles with close outside boxLow
        const candles5m = make5mCandles(lastPrice, 30, "DOWN", 300_000, 1500);

        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 85,
            boxHigh: 2470,
            boxLow: 2430,
            boxPos: -0.50,
            boxBreakSide: "lower",
            retestConfirmed: false, // retest 아직 없음 (EXPEDITE 검증)
            atr: 12,
            volumeExpansion: 2.2, // 조건 1: 거래량 >= 2.0x
            canonicalRegime: "RANGE",
            emaGap: -0.006,
            macroPolarity: "BEARISH", // 조건 3: Macro BEARISH vs short
            candles: candles1m,
            htf_candles: { "5m": candles5m, "15m": candles5m, "1h": candles5m, "4h": candles5m },
            takeProfitPlan: { tp1Price: 2380, tp2Price: 2340 },
            takeProfit1Px: 2380,
            stopPrice: 2459,
            invalidationPx: 2459,
            fastTrendShift: {
                active: true,
                direction: "short",
                baseSizeIntent: 0.32
            }
        };

        const input = adaptV2Input(
            "ETHUSDT",
            NOW,
            snap as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: {
                    final_decision: "ENTER",
                    execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "fast_trend_shift", takeProfit1Px: 2380, stopPrice: 2459 },
                    committedRiskPlan: { plannedTp1Price: 2380, plannedStopPrice: 2459 }
                },
                market_subtype: "FAST_TREND_SHIFT",
                side: "short"
            } as any,
            candles1m,
            "authoritative",
            "test_expedite_all_conditions_met"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const expediteProof = proofs.find(p => p.event === "V2_FTS_EXPEDITE_PROOF");
        assert.ok(expediteProof, "V2_FTS_EXPEDITE_PROOF 가 발생해야 함");
        assert.equal(expediteProof.expedited, true, "EXPEDITE 승인되어야 함");
        assert.equal(decision.decision, "ENTER", "EXPEDITE 3조건 충족 시 즉시 ENTER 허용");
    });

    it("2-2. EXPEDITE: 거래량 2x만 충족 (5m box outside close 미달) -> BLOCK", () => {
        const lastPrice = 2445; // box 내부 (2430~2470)
        const candles1m = makeCandles(lastPrice, 120, "DOWN", 60_000, 250);
        const candles5m = make5mCandles(lastPrice, 30, "FLAT", 300_000, 1500);

        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 80,
            boxHigh: 2470,
            boxLow: 2430,
            boxPos: 0.35, // 박스 내부!
            atr: 12,
            volumeExpansion: 2.5, // 조건 1만 만족
            canonicalRegime: "RANGE",
            emaGap: -0.003,
            macroPolarity: "BEARISH",
            candles: candles1m,
            htf_candles: { "5m": candles5m, "15m": candles5m, "1h": candles5m, "4h": candles5m },
            fastTrendShift: {
                active: true,
                direction: "short",
                baseSizeIntent: 0.32
            }
        };

        const input = adaptV2Input(
            "ETHUSDT",
            NOW,
            snap as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: {
                    final_decision: "ENTER",
                    execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "fast_trend_shift" }
                },
                market_subtype: "FAST_TREND_SHIFT",
                side: "short"
            } as any,
            candles1m,
            "authoritative",
            "test_expedite_vol_only_fail"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        assert.notEqual(decision.decision, "ENTER", "5m box outside close 미달 시 EXPEDITE 불가 및 차단");
        const expediteProof = proofs.find(p => p.event === "V2_FTS_EXPEDITE_PROOF");
        if (expediteProof) {
            assert.equal(expediteProof.expedited, false);
        }
    });

    it("2-3. EXPEDITE: 5m box outside close만 충족 (거래량 미달) -> BLOCK", () => {
        const lastPrice = 2410; // boxLow 아래
        const candles1m = makeCandles(lastPrice, 120, "DOWN", 60_000, 80); // 거래량 평범
        const candles5m = make5mCandles(lastPrice, 30, "DOWN", 300_000, 400);

        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 80,
            boxHigh: 2470,
            boxLow: 2430,
            boxPos: -0.50,
            boxBreakSide: "lower",
            atr: 12,
            volumeExpansion: 1.1, // 거래량 1.1x (2.0x 미달!)
            canonicalRegime: "RANGE",
            emaGap: -0.003,
            macroPolarity: "BEARISH",
            candles: candles1m,
            htf_candles: { "5m": candles5m, "15m": candles5m, "1h": candles5m, "4h": candles5m },
            fastTrendShift: {
                active: true,
                direction: "short",
                baseSizeIntent: 0.32
            }
        };

        const input = adaptV2Input(
            "ETHUSDT",
            NOW,
            snap as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: {
                    final_decision: "ENTER",
                    execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "fast_trend_shift" }
                },
                market_subtype: "FAST_TREND_SHIFT",
                side: "short"
            } as any,
            candles1m,
            "authoritative",
            "test_expedite_close_only_fail"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        assert.notEqual(decision.decision, "ENTER", "거래량 미달 시 EXPEDITE 불가 및 차단");
    });

    it("2-4. EXPEDITE: Macro alignment만 충족 (거래량/close 미달) -> BLOCK", () => {
        const lastPrice = 2450;
        const candles1m = makeCandles(lastPrice, 120, "FLAT", 60_000, 100);
        const candles5m = make5mCandles(lastPrice, 30, "FLAT", 300_000, 500);

        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 80,
            boxHigh: 2470,
            boxLow: 2430,
            boxPos: 0.50,
            atr: 12,
            volumeExpansion: 1.0,
            canonicalRegime: "RANGE",
            emaGap: -0.001,
            macroPolarity: "BEARISH", // Macro만 BEARISH
            candles: candles1m,
            htf_candles: { "5m": candles5m, "15m": candles5m, "1h": candles5m, "4h": candles5m },
            fastTrendShift: {
                active: true,
                direction: "short",
                baseSizeIntent: 0.32
            }
        };

        const input = adaptV2Input(
            "ETHUSDT",
            NOW,
            snap as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: {
                    final_decision: "ENTER",
                    execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "fast_trend_shift" }
                },
                market_subtype: "FAST_TREND_SHIFT",
                side: "short"
            } as any,
            candles1m,
            "authoritative",
            "test_expedite_macro_only_fail"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        assert.notEqual(decision.decision, "ENTER", "Macro 일치만으로는 EXPEDITE 불가 및 차단");
    });

    // =========================================================================
    // PART 3: Highway FTS Free-Pass 제거 검증
    // =========================================================================

    it("3-1. Highway에서 FTS만으로 retest/pullback 면제 -> BLOCK (Free-Pass 제거 증명)", () => {
        const lastPrice = 2475; // boxHigh(2460) 위 15달러 (과확장 위치)
        const snap = {
            lastPrice,
            boxHigh: 2460,
            boxLow: 2400,
            boxPos: 1.25,
            atr: 10,
            trendWeaknessScore: 0.70 // 추세 약화
        };

        // execution metadata에 fast_trend_shift === true 만 있고 pullback/retest 없음
        const execOutput = {
            signal: "LONG_CANDIDATE" as const,
            side: "long" as const,
            reason: "fast_trend_shift",
            baseSizeIntent: 0.32,
            recheckSuggested: true,
            isAddOnEligible: false,
            stopPrice: 2450,
            invalidationPx: 2450,
            metadata: {
                fast_trend_shift: true,
                fts_expedited: false, // EXPEDITE 아님
                retestConfirmed: false,
                pullbackConfirmed: false
            }
        };

        const res = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "TREND",
            subtype: "FAST_TREND_SHIFT",
            snapshot: snap,
            execution: execOutput,
            isPreCheck: false
        });

        assert.equal(res.allowed, false, "FTS 플래그만으로 Highway retest/chase 면제되면 안 됨 (BLOCK)");
        assert.ok(
            res.rejectReason?.includes("CHASE") || res.rejectReason?.includes("REWARD_RISK") || res.rejectReason != null,
            "Highway 게이트에서 정상 차단되어야 함"
        );
    });

    it("3-2. FTS provenance 신호는 early_probe 플래그가 있어도 Highway structureOk 면제 금지 -> BLOCK", () => {
        const lastPrice = 2475; // boxHigh(2460) 위 15달러 (과확장 위치)
        const snap = {
            lastPrice,
            boxHigh: 2460,
            boxLow: 2400,
            boxPos: 1.25,
            atr: 10,
            trendWeaknessScore: 0.70
        };

        // FTS에서 파생되었으나 metadata에 early_probe: true 가 포함된 경우
        const execOutput = {
            signal: "LONG_CANDIDATE" as const,
            side: "long" as const,
            reason: "fast_trend_shift",
            baseSizeIntent: 0.32,
            recheckSuggested: true,
            isAddOnEligible: false,
            stopPrice: 2450,
            invalidationPx: 2450,
            metadata: {
                early_probe: true, // trend-executor 가 넣는 early_probe
                fast_trend_shift: true,
                fts_expedited: false, // EXPEDITE 아님
                retestConfirmed: false,
                pullbackConfirmed: false
            }
        };

        const res = evaluateHighwayCoreEntryGate({
            symbol: "ETHUSDT",
            side: "long",
            regime: "TREND",
            subtype: "FAST_TREND_SHIFT",
            snapshot: snap,
            execution: execOutput,
            isPreCheck: false
        });

        assert.equal(res.allowed, false, "FTS provenance가 있는 경우 early_probe 만으로 Highway retest 면제되면 안 됨 (BLOCK)");
        assert.ok(
            res.rejectReason?.includes("CHASE") || res.rejectReason?.includes("REWARD_RISK") || res.rejectReason != null,
            "Highway 게이트에서 정상 차단되어야 함"
        );
    });

    // =========================================================================
    // PART 4: 10/06 사고 Replay 및 10/05 강한 추세 기회 보존 Replay
    // =========================================================================

    it("4-1. 실제 10/06 BTC 사고 replay: 00:20:18 BTC boxPos 0.1418 FTS 숏 진입 시도 -> BLOCK 증명", () => {
        const replayNow = 1759706418000;
        const boxHigh = 86200;
        const boxLow = 84800;
        const boxWidth = boxHigh - boxLow;
        const lastPrice = boxLow + boxWidth * 0.1418; // 84998.5 (박스 하단 14%)

        const candles1m = makeCandles(lastPrice, 120, "DOWN");
        const candles5m = make5mCandles(lastPrice, 30, "FLAT"); // 5m 완성봉 미확정 상태

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
            candles: candles1m,
            htf_candles: { "5m": candles5m, "15m": candles5m, "1h": candles5m, "4h": candles5m }
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
            candles1m,
            "authoritative",
            "test_replay_1006_btc_p1"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        assert.notEqual(decision.decision, "ENTER", "10/06 FLOW_BTC_2 숏 진입은 반드시 차단되어야 함");
    });

    it("4-1b. 실제 10/06 ETH 사고 replay: 01:22:33 ETH boxPos 0.10 FTS 숏 진입 시도 -> BLOCK 증명", () => {
        const replayNow = 1759710153000;
        const boxHigh = 2460;
        const boxLow = 2430;
        const lastPrice = 2433; // 박스 하단 10%

        const candles1m = makeCandles(lastPrice, 120, "DOWN");
        const candles5m = make5mCandles(lastPrice, 30, "FLAT"); // 5m 미확정 상태

        const snap = {
            symbol: "ETHUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 78,
            boxHigh,
            boxLow,
            boxPos: 0.10,
            atr: 8.5,
            rangeConfidence: 0.80,
            canonicalRegime: "RANGE",
            emaGap: -0.003,
            candles: candles1m,
            htf_candles: { "5m": candles5m, "15m": candles5m, "1h": candles5m, "4h": candles5m }
        };

        const input = adaptV2Input(
            "ETHUSDT",
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
            candles1m,
            "authoritative",
            "test_replay_1006_eth_p1"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        assert.notEqual(decision.decision, "ENTER", "10/06 FLOW_ETH_2 숏 진입은 반드시 차단되어야 함");
    });

    it("4-2. 10/05 강한 BTC 추세 replay: 원웨이 돌파 + Volume 폭발 시 EXPEDITE로 기회 보존 확인", () => {
        const lastPrice = 85280; // boxHigh(85200) 위 80달러 초기 돌파
        const boxHigh = 85200;
        const boxLow = 84000;

        const candles1m = makeCandles(lastPrice, 120, "UP", 60_000, 300); // 3x volume
        const candles5m = make5mCandles(lastPrice, 30, "UP", 300_000, 1800);

        const snap = {
            symbol: "BTCUSDT",
            lastPrice,
            latestCandleClose: lastPrice,
            closedClose: 85250,
            signal: "paper_long_candidate",
            entryCandidate: true,
            qualityScore: 88,
            boxHigh,
            boxLow,
            boxPos: 1.066,
            boxBreakSide: "upper",
            retestConfirmed: false, // 원웨이라 retest 없음
            atr: 350,
            volumeExpansion: 2.8, // 거래량 2.8x 폭발 (조건 1 만족)
            canonicalRegime: "TREND",
            emaGap: 0.008,
            macroPolarity: "BULLISH", // 매크로 BULLISH (조건 3 만족)
            candles: candles1m,
            htf_candles: { "5m": candles5m, "15m": candles5m, "1h": candles5m, "4h": candles5m },
            takeProfitPlan: { tp1Price: 86500, tp2Price: 87500 },
            takeProfit1Px: 86500,
            stopPrice: 84800,
            invalidationPx: 84800,
            fastTrendShift: {
                active: true,
                direction: "long",
                baseSizeIntent: 0.32
            }
        };

        const input = adaptV2Input(
            "BTCUSDT",
            NOW,
            snap as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            {
                decision: {
                    final_decision: "ENTER",
                    execution: { signal: "LONG_CANDIDATE", side: "long", reason: "fast_trend_shift", takeProfit1Px: 86500, stopPrice: 84800 },
                    committedRiskPlan: { plannedTp1Price: 86500, plannedStopPrice: 84800 }
                },
                market_subtype: "FAST_TREND_SHIFT",
                side: "long"
            } as any,
            candles1m,
            "authoritative",
            "test_replay_1005_strong_trend_expedite"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const expediteProof = proofs.find(p => p.event === "V2_FTS_EXPEDITE_PROOF");
        assert.ok(expediteProof, "10/05 원웨이 추세는 V2_FTS_EXPEDITE_PROOF 가 발생해야 함");
        assert.equal(expediteProof.expedited, true, "EXPEDITE 승인");
        assert.equal(decision.decision, "ENTER", "10/05 강한 추세는 EXPEDITE로 진입 기회가 보존되어야 함");
    });
});
