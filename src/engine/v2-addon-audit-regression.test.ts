import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    evaluateEquityAdaptiveSizing,
    MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE,
    MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
    MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE,
    MAX_ADVERSE_ADDON_EQUITY_MULTIPLE
} from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import {
    evaluateConfirmedAdverseAddOn,
    MAX_ADVERSE_ADDON_COUNT,
    shouldTriggerProtectionResize,
    protectionSizeMatch,
    isInvalidationReached,
    hasHtfHardPolarityMismatch
} from "../engine-v2/addon/adverse-addon";
import {
    resolveV2AddonBlockReason,
    buildV2AddonEligibilityProof
} from "../engine-v2/addon/eligibility-proof";
import type { EvaluateV2AddOnPolicyArgs, V2AddOnPolicyResult } from "../engine-v2/addon/types";

describe("V2 Add-on (물타기/불타기) Comprehensive Audit Regression Suite", () => {
    const EQUITY = 2440.16;
    const BALANCE = 2440.16;

    // Helper for base adverse addon input
    function makeAdversePolicyArgs(overrides: Record<string, any> = {}): EvaluateV2AddOnPolicyArgs {
        const defaultLongPosition = {
            symbol: "BTCUSDT",
            side: "long",
            entryPrice: 68000,
            sizeUsd: 1500, // < 1.0x equity cap (2440.16) so adverse addon is not blocked by MAX_SYMBOL_CAP
            leverage: 10,
            entryStage: 1,
            addonCount: 0,
            adverseAddonCount: 0,
            pnlPct: -0.005, // -0.5% in loss (adverse)
            adverseMoveAnchorCandleTs: 1000,
            lastAdverseConfirmationCandleTs: 1000
        };

        const defaultV2State = {
            longPosition: defaultLongPosition as any,
            shortPosition: null,
            directionalShockState: "NONE",
            crashState: "NORMAL",
            pumpState: "NORMAL"
        };

        const defaultJudgment = {
            regime_final: "RANGE",
            regime: "RANGE",
            rangePhase: "LOWER",
            trendPhase: "NONE",
            shockPhase: "NONE",
            subtype: "RANGE_OSCILLATION",
            counter_trend_risk: false,
            htf_entry_policy: "LONG_ONLY_OR_NONE"
        };

        const defaultExecution = {
            side: "long",
            signal: "LONG_CANDIDATE",
            invalidationPx: 67000,
            stopPrice: 67200,
            metadata: {}
        };

        const defaultSnapshot = {
            qualityScore: 82,
            reviewing_ticks: 3,
            boxPos: 0.15,
            emaGap: 0.0001,
            trendWeaknessScore: 0.2,
            rangeConfidence: 0.8,
            lastPrice: 67660,
            atr: 200,
            latestCandleTs: 2000 // fresh candle > 1000
        };

        const { v2State: oV2, judgment: oJ, execution: oE, snapshot: oS, ...oRest } = overrides;

        return {
            symbol: "BTCUSDT",
            side: "long",
            accountEquityUsd: EQUITY,
            currentSymbolNotionalUsd: 1500,
            currentGlobalNotionalUsd: 1500,
            currentStopPrice: 67200,
            ...oRest,
            v2State: {
                ...defaultV2State,
                ...(oV2 ?? {}),
                longPosition: {
                    ...defaultLongPosition,
                    ...(oV2?.longPosition ?? {})
                }
            } as any,
            judgment: {
                ...defaultJudgment,
                ...(oJ ?? {})
            } as any,
            execution: {
                ...defaultExecution,
                ...(oE ?? {})
            } as any,
            snapshot: {
                ...defaultSnapshot,
                ...(oS ?? {})
            }
        };
    }

    // -------------------------------------------------------------
    // TEST A: BTC adaptive initial 후 Add-on 정상 제한
    // -------------------------------------------------------------
    it("CASE A: BTC adaptive initial 후 Add-on 정상 제한 (symbol cap 2.75x 및 risk budget 바인딩)", () => {
        // BTC Grade A initial = 5612.37 USDT
        const existingNotional = 5612.37;
        const symbolCap = EQUITY * MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE; // 2440.16 * 2.75 = 6710.44
        const remainingCap = symbolCap - existingNotional; // 1098.07 USDT

        const res = evaluateEquityAdaptiveSizing({
            symbol: "BTCUSDT",
            side: "long",
            orderKind: "ADVERSE_ADDON",
            accountEquityUsdt: EQUITY,
            availableBalanceUsdt: BALANCE,
            entryReferencePrice: 68000,
            lastPrice: 68000,
            effectiveStopPrice: 67500, // ~0.735% stop distance
            appliedLeverage: 10,
            existingSymbolNotionalUsdt: existingNotional,
            existingAccountNotionalUsdt: existingNotional,
            policyRequestedNotionalUsdt: 2000, // requested more than remaining
            adverseRiskBudgetAllowedNotional: 700,
            v2AuthorityEntry: true
        });

        assert.equal(res.sizingPassed, true);
        // Sizing must NOT expand to thousands; must respect min(maxAdverse, symbolCapacity, adverseRiskBudget)
        assert.ok(res.finalOrderNotionalUsdt <= remainingCap + 1e-4, `Expected <= ${remainingCap}, got ${res.finalOrderNotionalUsdt}`);
        assert.ok(res.finalOrderNotionalUsdt <= 700.01, `Expected <= 700, got ${res.finalOrderNotionalUsdt}`);
        assert.ok(existingNotional + res.finalOrderNotionalUsdt <= symbolCap + 1e-4);
    });

    // -------------------------------------------------------------
    // TEST B: ETH 1200 initial 후 Add-on 800 정책 유지
    // -------------------------------------------------------------
    it("CASE B: ETH 1200 initial 후 Add-on 800 정책 유지 및 총 2000 USDT 상한 바인딩", () => {
        const initialEth = 1200;
        const res = evaluateEquityAdaptiveSizing({
            symbol: "ETHUSDT",
            side: "long",
            orderKind: "ADVERSE_ADDON",
            accountEquityUsdt: EQUITY,
            availableBalanceUsdt: BALANCE,
            entryReferencePrice: 2700,
            lastPrice: 2700,
            effectiveStopPrice: 2660,
            appliedLeverage: 10,
            existingSymbolNotionalUsdt: initialEth,
            existingAccountNotionalUsdt: initialEth,
            policyRequestedNotionalUsdt: 800,
            maxAdverseAddonCapUsdt: 800,
            maxSymbolNotionalCapUsdt: 2000,
            adverseRiskBudgetAllowedNotional: 800,
            v2AuthorityEntry: true
        });

        assert.equal(res.sizingPassed, true);
        assert.equal(Math.round(res.finalOrderNotionalUsdt), 800);
        assert.equal(initialEth + res.finalOrderNotionalUsdt, 2000);
    });

    // -------------------------------------------------------------
    // TEST C: Add-on 후 symbol exposure cap 초과 시 정확히 차단
    // -------------------------------------------------------------
    it("CASE C: Add-on 후 symbol exposure cap 도달 시 정확히 차단 (MAX_SYMBOL_NOTIONAL_EXCEEDED)", () => {
        const fullEth = 2000; // already at symbol cap 2000
        const res = evaluateEquityAdaptiveSizing({
            symbol: "ETHUSDT",
            side: "long",
            orderKind: "ADVERSE_ADDON",
            accountEquityUsdt: EQUITY,
            availableBalanceUsdt: BALANCE,
            entryReferencePrice: 2700,
            lastPrice: 2700,
            effectiveStopPrice: 2660,
            appliedLeverage: 10,
            existingSymbolNotionalUsdt: fullEth,
            existingAccountNotionalUsdt: fullEth,
            policyRequestedNotionalUsdt: 800,
            maxAdverseAddonCapUsdt: 800,
            maxSymbolNotionalCapUsdt: 2000,
            adverseRiskBudgetAllowedNotional: 800,
            v2AuthorityEntry: true
        });

        assert.equal(res.sizingPassed, false);
        assert.equal(res.blockReason, "MAX_SYMBOL_NOTIONAL_EXCEEDED");
        assert.equal(res.finalOrderNotionalUsdt, 0);
    });

    // -------------------------------------------------------------
    // TEST D: account open-risk cap (2.5%) 초과 시 Add-on 차단
    // -------------------------------------------------------------
    it("CASE D: account open-risk cap (2.5%) 초과 시 Add-on 차단", () => {
        const hardOpenRiskLimit = EQUITY * 0.025; // 61.004 USDT
        const res = evaluateEquityAdaptiveSizing({
            symbol: "BTCUSDT",
            side: "long",
            orderKind: "ADVERSE_ADDON",
            accountEquityUsdt: EQUITY,
            availableBalanceUsdt: BALANCE,
            entryReferencePrice: 68000,
            lastPrice: 68000,
            effectiveStopPrice: 67500,
            appliedLeverage: 10,
            existingSymbolNotionalUsdt: 3895.35,
            existingAccountNotionalUsdt: 3895.35,
            existingAccountOpenRiskUsdt: hardOpenRiskLimit, // open risk already at 2.5%
            policyRequestedNotionalUsdt: 500,
            adverseRiskBudgetAllowedNotional: 500,
            v2AuthorityEntry: true
        });

        assert.equal(res.sizingPassed, false);
        assert.equal(res.blockReason, "ACCOUNT_TOTAL_OPEN_RISK_CAP_EXCEEDED");
        assert.equal(res.finalOrderNotionalUsdt, 0);
    });

    // -------------------------------------------------------------
    // TEST E: 동일 signal 중복 Add-on 차단 (MAX_ADVERSE_ADDON_COUNT & FRESH_CONFIRMATION)
    // -------------------------------------------------------------
    it("CASE E: 동일 signal 중복 Add-on 차단 (MAX_ADVERSE_ADDON_COUNT=1 도달 시 차단)", () => {
        const args = makeAdversePolicyArgs({
            v2State: {
                longPosition: {
                    adverseAddonCount: 1,
                    addonCount: 1
                } as any
            }
        });

        const base: any = {
            action: "ADDON_WATCH",
            allowed: false,
            reason: "SAME_SIDE_POSITION_WATCH_RECHECK",
            qualityScore: 82,
            reviewingTicks: 3,
            hasSameSidePosition: true
        };

        const res = evaluateConfirmedAdverseAddOn(args, base);
        assert.equal(res.allowed, false);
        assert.equal(res.action, "ADDON_WATCH");
        assert.equal(res.addonBlockedReason, "ADVERSE_ADDON_LIMIT_REACHED");
    });

    it("CASE E-2: Stale candle confirmation (freshTick/candle Ts 미갱신) 중복 진입 차단", () => {
        const args = makeAdversePolicyArgs({
            snapshot: {
                latestCandleTs: 1000 // latestCandleTs (1000) <= adverseMoveAnchorCandleTs (1000) -> stale
            } as any
        });

        const base: any = {
            action: "ADDON_WATCH",
            allowed: false,
            reason: "SAME_SIDE_POSITION_WATCH_RECHECK",
            qualityScore: 82,
            reviewingTicks: 3,
            hasSameSidePosition: true
        };

        const res = evaluateConfirmedAdverseAddOn(args, base);
        assert.equal(res.allowed, false);
        assert.equal(res.addonBlockedReason, "FRESH_CONFIRMATION_NOT_MET");
    });

    // -------------------------------------------------------------
    // TEST F: 손실 물타기 허용 및 금지 조건
    // -------------------------------------------------------------
    it("CASE F: 손실 물타기 - 정상 조건(소액 노출, 리스크 예산 이내)에서 허용 (CONFIRMED_ADVERSE_ADDON_ALLOWED)", () => {
        // With small existing position (200 USDT), riskBeforeAddon is small (< 3.66 USDT budget), allowing adverse addon
        const args = makeAdversePolicyArgs({
            currentSymbolNotionalUsd: 200,
            currentGlobalNotionalUsd: 200,
            v2State: {
                longPosition: {
                    sizeUsd: 200,
                    entryPrice: 68000,
                    pnlPct: -0.005,
                    adverseAddonCount: 0,
                    addonCount: 0,
                    adverseMoveAnchorCandleTs: 1000,
                    lastAdverseConfirmationCandleTs: 1000
                }
            },
            snapshot: {
                lastPrice: 67660,
                atr: 50,
                latestCandleTs: 2000
            }
        });

        const base: any = {
            action: "ADDON_WATCH",
            allowed: false,
            reason: "SAME_SIDE_POSITION_WATCH_RECHECK",
            qualityScore: 82,
            reviewingTicks: 3,
            hasSameSidePosition: true
        };

        const res = evaluateConfirmedAdverseAddOn(args, base);
        assert.equal(res.allowed, true);
        assert.equal(res.action, "ADDON_ALLOWED");
        assert.equal(res.reason, "CONFIRMED_ADVERSE_ADDON_ALLOWED");
        assert.ok(res.requestedAddonNotionalUsdt! > 0);
    });

    it("CASE F-2: 손절가/무효화가 도달 시 물타기 즉시 차단 (INVALIDATION_REACHED)", () => {
        // currentPrice (66900) <= invalidationPx (67000) -> Invalidation reached!
        const args = makeAdversePolicyArgs({
            currentSymbolNotionalUsd: 200,
            currentGlobalNotionalUsd: 200,
            v2State: {
                longPosition: {
                    sizeUsd: 200,
                    entryPrice: 68000,
                    pnlPct: -0.015,
                    adverseAddonCount: 0,
                    addonCount: 0,
                    adverseMoveAnchorCandleTs: 1000,
                    lastAdverseConfirmationCandleTs: 1000
                }
            },
            execution: {
                invalidationPx: 67000,
                stopPrice: 67000
            },
            snapshot: {
                lastPrice: 66900, // < invalidationPx 67000
                atr: 50,
                latestCandleTs: 2000
            }
        });

        const base: any = {
            action: "ADDON_WATCH",
            allowed: false,
            reason: "SAME_SIDE_POSITION_WATCH_RECHECK",
            qualityScore: 82,
            reviewingTicks: 3,
            hasSameSidePosition: true
        };

        const res = evaluateConfirmedAdverseAddOn(args, base);
        assert.equal(res.allowed, false);
        assert.equal(res.addonBlockedReason, "INVALIDATION_REACHED");
    });

    it("CASE F-3: 불타기 실행 후 물타기 시도 시 영구 차단 (ADVERSE_ADD_FORBIDDEN_AFTER_PYRAMID)", () => {
        const args = makeAdversePolicyArgs({
            v2State: {
                longPosition: {
                    addonCount: 1, // pyramid executed
                    adverseAddonCount: 0
                } as any
            }
        });

        const base: any = {
            action: "ADDON_WATCH",
            allowed: false,
            reason: "SAME_SIDE_POSITION_WATCH_RECHECK",
            qualityScore: 82,
            reviewingTicks: 3,
            hasSameSidePosition: true
        };

        const res = evaluateConfirmedAdverseAddOn(args, base);
        assert.equal(res.allowed, false);
        assert.equal(res.addonBlockedReason, "ADVERSE_ADD_FORBIDDEN_AFTER_PYRAMID");
    });

    // -------------------------------------------------------------
    // TEST G: 수익 불타기 허용/금지 조건
    // -------------------------------------------------------------
    it("CASE G: 수익 불타기 - 스톱 미등록/미락킹 시 BREAKEVEN_STOP_NOT_CONFIRMED 차단", () => {
        const proof = resolveV2AddonBlockReason({
            authoritySide: "long",
            positionSide: "long",
            addOnPolicy: {
                allowed: false,
                reason: "BREAKEVEN_STOP_NOT_CONFIRMED",
                addonBlockedReason: "ACTUAL_STOP_NOT_LOCKING_PROFIT",
                addonMode: "PYRAMIDING"
            },
            executionAction: "ADDON",
            finalDecision: "ENTER",
            liveReadinessPassed: true,
            okxPendingOrdersReady: true,
            minOrderBlockReason: null,
            riskBlockReason: null,
            cooldownBlocked: false,
            cooldownReason: null
        });

        assert.equal(proof, "ACTUAL_STOP_NOT_LOCKING_PROFIT");
    });

    // -------------------------------------------------------------
    // TEST H: Shock 중 Add-on 차단
    // -------------------------------------------------------------
    it("CASE H: Stabilized opposing shock 발생 시 물타기 즉시 차단 (STABILIZED_OPPOSING_SHOCK)", () => {
        const args = makeAdversePolicyArgs({
            v2State: {
                directionalShockState: "DOWN"
            } as any,
            judgment: {
                shockPhase: "DOWN_SHOCK"
            } as any
        });

        const base: any = {
            action: "ADDON_WATCH",
            allowed: false,
            reason: "SAME_SIDE_POSITION_WATCH_RECHECK",
            qualityScore: 82,
            reviewingTicks: 3,
            hasSameSidePosition: true
        };

        const res = evaluateConfirmedAdverseAddOn(args, base);
        assert.equal(res.allowed, false);
        assert.equal(res.addonBlockedReason, "STABILIZED_OPPOSING_SHOCK");
    });

    it("CASE H-2: HTF Polarity Mismatch 시 물타기 차단 (HTF_POLARITY_MISMATCH)", () => {
        const args = makeAdversePolicyArgs({
            judgment: {
                counter_trend_risk: true,
                htf_entry_policy: "SHORT_ONLY"
            } as any
        });

        const base: any = {
            action: "ADDON_WATCH",
            allowed: false,
            reason: "SAME_SIDE_POSITION_WATCH_RECHECK",
            qualityScore: 82,
            reviewingTicks: 3,
            hasSameSidePosition: true
        };

        const res = evaluateConfirmedAdverseAddOn(args, base);
        assert.equal(res.allowed, false);
        assert.equal(res.addonBlockedReason, "HTF_POLARITY_MISMATCH");
    });

    // -------------------------------------------------------------
    // TEST I: Manual Takeover 중 Add-on 차단
    // -------------------------------------------------------------
    it("CASE I: Manual Takeover (OPERATOR_MANAGED) 중 Add-on 원천 차단", () => {
        const proof = resolveV2AddonBlockReason({
            authoritySide: "long",
            positionSide: "long",
            addOnPolicy: {
                allowed: true,
                reason: "CONFIRMED_ADVERSE_ADDON_ALLOWED",
                addonBlockedReason: "",
                addonMode: "CONFIRMED_ADVERSE_ADDON"
            },
            executionAction: "NONE", // blocked from mutation
            finalDecision: "HOLD",   // V2 holds during manual takeover
            liveReadinessPassed: false,
            okxPendingOrdersReady: true,
            minOrderBlockReason: "OPERATOR_MANUAL_INTERVENTION_OBSERVE_ONLY",
            riskBlockReason: null,
            cooldownBlocked: false,
            cooldownReason: null
        });

        assert.equal(proof, "OPERATOR_MANUAL_INTERVENTION_OBSERVE_ONLY");
    });

    // -------------------------------------------------------------
    // TEST J: Add-on 체결 후 SL/TP Protection 수량 일치 및 Resize 트리거
    // -------------------------------------------------------------
    it("CASE J: Add-on 체결 후 SL/TP Protection 수량 불일치 감지 및 Resize 트리거", () => {
        // Before Add-on: 0.05 BTC position, 0.05 BTC SL protected -> MATCH
        assert.equal(protectionSizeMatch(0.05, 0.05), true);
        assert.equal(shouldTriggerProtectionResize(0.05, 0.05), false);

        // After Add-on fill: 0.08 BTC actual position, 0.05 BTC SL protected -> MISMATCH! Trigger resize!
        assert.equal(protectionSizeMatch(0.08, 0.05), false);
        assert.equal(shouldTriggerProtectionResize(0.08, 0.05), true);

        // Once rebuilt to 0.08 BTC -> MATCH restored
        assert.equal(protectionSizeMatch(0.08, 0.08), true);
        assert.equal(shouldTriggerProtectionResize(0.08, 0.08), false);
    });
});
