/**
 * Comprehensive Authority Conflict & Integration Regression Tests:
 * 1. Authority resolver sets range_zone_veto_applicable=true only for pure RANGE execution
 * 2. A. 실제 index integration: RANGE + lower + short + no reversal/no relax
 *       -> SKIP (RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT)
 * 3. B. RANGE + upper + long + no reversal/no relax
 *       -> SKIP (RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG)
 * 4. C. RANGE + lower + short + 정당한 reversal/relax 조건
 *       -> 기존 semantics 그대로 (reversal probe / relaxed flow)
 * 5. D. TREND_DOWN + lower short
 *       -> RANGE veto bypass (이후 TREND chase/RR/edge 판단)
 * 6. E. TREND_UP + upper long
 *       -> RANGE veto bypass (이후 TREND chase/RR/edge 판단)
 * 7. F. DOWN_SHOCK 해제 직후에도 RANGE lower에서 raw short ENTER가 바로 살아나지 않는지 확인
 * 8. Expanded Proof schema validation
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

describe("V2 Range Zone Authority Conflict & Integration Regression", () => {
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

    it("2. A. RANGE + lower + short + no reversal/no relax -> SKIP (RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT)", () => {
        const boxHigh = 2500;
        const boxLow = 2400;
        const lastPrice = 2420; // boxPos = 0.20 (lower threshold <= 0.26)
        const candles = makeCandles(2450, "FLAT");
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
            boxPos: 0.20,
            atr: 10,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.30,
            boxCohesion01: 0.85,
            breakoutFailureRate: 0.80,
            canonicalRegime: "RANGE",
            candles,
            signalGateBlockedReason: null // Real runtime: V1 signalGateBlockedReason is null
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
            "test_range_lower_short_integration"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const authorityProof = proofs.find(p => p.event === "V2_RANGE_ZONE_AUTHORITY_PROOF" && p.final_regime !== undefined);
        assert.ok(authorityProof, "V2_RANGE_ZONE_AUTHORITY_PROOF must be emitted");
        assert.equal(authorityProof.range_zone_veto_applicable, true);
        assert.equal(authorityProof.range_zone_veto_bypass_reason, null);
        assert.equal(authorityProof.range_lower_short_mismatch_raw, true);
        assert.equal(authorityProof.range_mismatch_after_exemption, true);
        assert.equal(authorityProof.veto_reason_pre_apply, "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT");
        assert.equal(authorityProof.decision_after, "SKIP");

        assert.equal(decision.decision, "SKIP");
        const vetoProof = proofs.find(p => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF");
        assert.ok(vetoProof, "V2_RANGE_SIDE_ZONE_VETO_PROOF must be emitted");
        assert.equal(vetoProof.vetoReason, "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT");
    });

    it("3. B. RANGE + upper + long + no reversal/no relax -> SKIP (RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG)", () => {
        const boxHigh = 2500;
        const boxLow = 2400;
        const lastPrice = 2480; // boxPos = 0.80 (upper threshold >= 0.74)
        const candles = makeCandles(2450, "FLAT");
        const snap = {
            symbol: "ETHUSDT_B",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_long_candidate",
            entryCandidate: true,
            qualityScore: 85,
            emaGap: 0.0006,
            boxHigh,
            boxLow,
            boxPos: 0.80,
            atr: 10,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.30,
            boxCohesion01: 0.85,
            breakoutFailureRate: 0.80,
            canonicalRegime: "RANGE",
            candles,
            signalGateBlockedReason: null // Real runtime: V1 signalGateBlockedReason is null
        };
        const input = adaptV2Input(
            "ETHUSDT_B",
            Date.now(),
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge({ shortAllow: false }) as any,
            { decision: { final_decision: "ENTER", execution: { signal: "LONG_CANDIDATE", side: "long", reason: "test" } }, side: "long" } as any,
            candles,
            "authoritative",
            "test_range_upper_long_integration"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const authorityProof = proofs.find(p => p.event === "V2_RANGE_ZONE_AUTHORITY_PROOF" && p.final_regime !== undefined);
        assert.ok(authorityProof, "V2_RANGE_ZONE_AUTHORITY_PROOF must be emitted");
        assert.equal(authorityProof.range_zone_veto_applicable, true);
        assert.equal(authorityProof.range_zone_veto_bypass_reason, null);
        assert.equal(authorityProof.zone, "upper");
        assert.equal(authorityProof.range_upper_long_mismatch_raw, true);
        assert.equal(authorityProof.range_mismatch_after_exemption, true);
        assert.equal(authorityProof.veto_reason_pre_apply, "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG");
        assert.equal(authorityProof.decision_after, "SKIP");

        assert.equal(decision.decision, "SKIP");
        const vetoProof = proofs.find(p => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF");
        assert.ok(vetoProof, "V2_RANGE_SIDE_ZONE_VETO_PROOF must be emitted");
        assert.equal(vetoProof.vetoReason, "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG");
    });

    it("4. C. RANGE + lower + short + 정당한 reversal/relax 조건 -> 기존 semantics 유지", () => {
        const boxHigh = 2500;
        const boxLow = 2400;
        const lastPrice = 2420;
        const candles = makeCandles(2450, "FLAT");
        const snap = {
            symbol: "ETHUSDT_C",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 85,
            emaGap: -0.0006,
            boxHigh,
            boxLow,
            boxPos: 0.20,
            atr: 10,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.30,
            boxCohesion01: 0.85,
            breakoutFailureRate: 0.80,
            canonicalRegime: "RANGE",
            reversal_confirmed: true,
            candles
        };
        const input = adaptV2Input(
            "ETHUSDT_C",
            Date.now(),
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            { decision: { final_decision: "ENTER", execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "test" } }, side: "short" } as any,
            candles,
            "authoritative",
            "test_range_lower_short_reversal"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const authorityProof = proofs.find(p => p.event === "V2_RANGE_ZONE_AUTHORITY_PROOF" && p.final_regime !== undefined);
        assert.ok(authorityProof);
        assert.equal(authorityProof.reversal_confirmed, true);
    });

    it("5. D. TREND_DOWN + lower short -> RANGE veto 미적용 (TREND authority)", () => {
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
            "test_trend_down_breakdown_short"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const authorityProof = proofs.find(p => p.event === "V2_RANGE_ZONE_AUTHORITY_PROOF" && p.final_regime !== undefined);
        assert.ok(authorityProof, "V2_RANGE_ZONE_AUTHORITY_PROOF must be emitted");
        assert.equal(authorityProof.range_zone_veto_applicable, false);
        assert.equal(authorityProof.range_zone_veto_bypass_reason, "FINAL_TREND_ROUTING_AUTHORITY");

        // Lower short must NOT be blocked by RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT
        const vetoProof = proofs.find(p => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF" && p.vetoReason === "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT");
        assert.equal(vetoProof, undefined, "RANGE veto must not be triggered for TREND");
    });

    it("6. E. TREND_UP + upper long -> RANGE veto 미적용 (TREND authority)", () => {
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
            "test_trend_up_breakout_long"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const authorityProof = proofs.find(p => p.event === "V2_RANGE_ZONE_AUTHORITY_PROOF" && p.final_regime !== undefined);
        assert.ok(authorityProof, "V2_RANGE_ZONE_AUTHORITY_PROOF must be emitted");
        assert.equal(authorityProof.range_zone_veto_applicable, false);
        assert.equal(authorityProof.range_zone_veto_bypass_reason, "FINAL_TREND_ROUTING_AUTHORITY");

        // Upper long must NOT be blocked by RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG
        const vetoProof = proofs.find(p => p.event === "V2_RANGE_SIDE_ZONE_VETO_PROOF" && p.vetoReason === "RANGE_SIDE_ZONE_MISMATCH_UPPER_LONG");
        assert.equal(vetoProof, undefined, "RANGE veto must not be triggered for TREND");
    });

    it("7. F. RANGE인데 isTrendAuthorityCandidate=true 잔존 -> lower short/upper long veto exemption 금지", () => {
        const boxHigh = 2500;
        const boxLow = 2400;
        const lastPrice = 2420; // boxPos = 0.20 (lower zone)
        const candles = makeCandles(2450, "FLAT");
        const snap = {
            symbol: "ETHUSDT_F",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 85,
            emaGap: -0.0006,
            boxHigh,
            boxLow,
            boxPos: 0.20,
            atr: 10,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.30,
            boxCohesion01: 0.85,
            breakoutFailureRate: 0.80,
            canonicalRegime: "RANGE",
            directionalShockState: "NONE",
            candles
        };
        const input = adaptV2Input(
            "ETHUSDT_F",
            Date.now(),
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            { decision: { final_decision: "ENTER", execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "test" } }, side: "short" } as any,
            candles,
            "authoritative",
            "test_range_lower_short_trend_cand_residue"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const authorityProof = proofs.find(p => p.event === "V2_RANGE_ZONE_AUTHORITY_PROOF" && p.final_regime !== undefined);
        assert.ok(authorityProof);
        assert.equal(authorityProof.range_zone_veto_applicable, true);
        assert.equal(authorityProof.zone, "lower");
        assert.equal(authorityProof.range_lower_short_mismatch_raw, true);
        assert.equal(authorityProof.range_mismatch_after_exemption, true);
        assert.equal(authorityProof.veto_reason_pre_apply, "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT");
        assert.equal(authorityProof.decision_after, "SKIP");
        assert.equal(decision.decision, "SKIP");
    });

    it("8. G. RANGE인데 trend promotionReason 잔존 -> final RANGE authority 우선", () => {
        const boxHigh = 2500;
        const boxLow = 2400;
        const lastPrice = 2420; // boxPos = 0.20 (lower zone)
        const candles = makeCandles(2450, "FLAT");
        const snap = {
            symbol: "ETHUSDT_G",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 85,
            emaGap: -0.0006,
            boxHigh,
            boxLow,
            boxPos: 0.20,
            atr: 10,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.30,
            boxCohesion01: 0.85,
            breakoutFailureRate: 0.80,
            canonicalRegime: "RANGE",
            candles
        };
        const input = adaptV2Input(
            "ETHUSDT_G",
            Date.now(),
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            { decision: { final_decision: "ENTER", execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "V2_TREND_QUALIFIED_FINAL_PROMOTION" } }, side: "short" } as any,
            candles,
            "authoritative",
            "test_range_lower_short_trend_promo_residue"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const authorityProof = proofs.find(p => p.event === "V2_RANGE_ZONE_AUTHORITY_PROOF" && p.final_regime !== undefined);
        assert.ok(authorityProof);
        assert.equal(authorityProof.range_zone_veto_applicable, true);
        assert.equal(authorityProof.zone, "lower");
        assert.equal(authorityProof.range_lower_short_mismatch_raw, true);
        assert.equal(authorityProof.range_mismatch_after_exemption, true);
        assert.equal(authorityProof.veto_reason_pre_apply, "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT");
        assert.equal(authorityProof.decision_after, "SKIP");
        assert.equal(decision.decision, "SKIP");
    });

    it("9. H. Proof: decision_before=ENTER, veto_reason_pre_apply, decision_after=SKIP truthful correlation", () => {
        const boxHigh = 2500;
        const boxLow = 2400;
        const lastPrice = 2420;
        const candles = makeCandles(2450, "FLAT");
        const snap = {
            symbol: "ETHUSDT_H",
            lastPrice,
            latestCandleClose: lastPrice,
            signal: "paper_short_candidate",
            entryCandidate: true,
            qualityScore: 85,
            emaGap: -0.0006,
            boxHigh,
            boxLow,
            boxPos: 0.20,
            atr: 10,
            rangeConfidence: 0.85,
            trendWeaknessScore: 0.30,
            boxCohesion01: 0.85,
            breakoutFailureRate: 0.80,
            canonicalRegime: "RANGE",
            candles
        };
        const input = adaptV2Input(
            "ETHUSDT_H",
            Date.now(),
            buildV2SnapshotBridge(snap as any) as any,
            { paperQualityMinScore: 60, paperTakerFeeRate: 0.0005, paperGateMinMoveMultiplier: 1.5 } as any,
            makeLiveBridge() as any,
            { decision: { final_decision: "ENTER", execution: { signal: "SHORT_CANDIDATE", side: "short", reason: "test" } }, side: "short" } as any,
            candles,
            "authoritative",
            "test_proof_truthful_correlation"
        );

        let decision!: ReturnType<typeof runEngineV2>["decision"];
        const proofs = captureProofLogs(() => {
            ({ decision } = runEngineV2(input));
        });

        const authorityProof = proofs.find(p => p.event === "V2_RANGE_ZONE_AUTHORITY_PROOF" && p.final_regime !== undefined);
        assert.ok(authorityProof);
        assert.equal(authorityProof.decision_before, "ENTER");
        assert.equal(authorityProof.decision_before_veto, "ENTER");
        assert.equal(authorityProof.veto_reason_pre_apply, "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT");
        assert.equal(authorityProof.decision_after, "SKIP");
        assert.equal(authorityProof.final_decision, "SKIP");
        assert.equal(authorityProof.final_selected_side, "none");
        assert.equal(authorityProof.final_reject_reason, "RANGE_SIDE_ZONE_MISMATCH_LOWER_SHORT");

        // Expand field presence check
        assert.ok("range_lower_short_mismatch_raw" in authorityProof);
        assert.ok("range_upper_long_mismatch_raw" in authorityProof);
        assert.ok("range_mismatch_after_exemption" in authorityProof);
        assert.ok("relaxed_range_entry" in authorityProof);
        assert.ok("reversal_confirmed" in authorityProof);
        assert.ok("range_edge_extreme" in authorityProof);
        assert.ok("range_signal_downgraded" in authorityProof);
        assert.ok("range_signal_kept_by_relax" in authorityProof);
        assert.ok("native_executor_enter_authority" in authorityProof);
        assert.ok("promotion_applied" in authorityProof);
    });
});
