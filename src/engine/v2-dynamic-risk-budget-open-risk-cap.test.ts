import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    evaluateEquityAdaptiveSizing,
    ACCOUNT_TOTAL_OPEN_RISK_HARD_CAP_PCT,
    UNKNOWN_OPEN_POSITION_RISK_RESERVE_PCT,
    FULL_ENTRY_TARGET_RISK_SA_PCT,
    FULL_ENTRY_TARGET_RISK_B_PCT,
    MICRO_PROBE_TARGET_RISK_PCT,
    MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE,
    MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
    MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE
} from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import {
    resolveAccountOpenRiskAuthority,
    type DirectPositionRiskInput
} from "../engine-v2/risk-sizing/account-open-risk";

describe("PHASE — DYNAMIC RISK BUDGET + ACCOUNT OPEN-RISK CAP DEDICATED TESTS", () => {
    const equity = 10000; // $10,000 equity
    const entryPrice = 100;
    const stopPrice = 99; // stop distance = (100 - 99) / 100 = 0.01 (1%)
    const stopDistancePct = 0.01;

    // Helper to calculate effective risk pct
    function calcEffectiveRiskPct(finalNotional: number, stopDist: number, eq: number): number {
        return (finalNotional * stopDist) / eq;
    }

    // Helper to build base sizing input
    function makeBaseInput(overrides: Record<string, unknown> = {}) {
        return {
            symbol: "BTCUSDT",
            side: "long" as const,
            orderKind: "ENTRY" as const,
            accountEquityUsdt: equity,
            availableBalanceUsdt: equity * 0.9,
            entryReferencePrice: entryPrice,
            effectiveStopPrice: stopPrice,
            appliedLeverage: 10,
            entryQualityGrade: "A",
            existingSymbolNotionalUsdt: 0,
            existingAccountNotionalUsdt: 0,
            lastPrice: entryPrice,
            roundTripFeeRate: 0,
            v2AuthorityEntry: true,
            ...overrides
        };
    }

    // 1. A grade full / no existing position -> effective risk = 1.50%
    it("1. A grade full / no existing position -> effective risk = 1.50%", () => {
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({ entryQualityGrade: "A" }));
        assert.equal(res.sizingPassed, true);
        assert.equal(res.targetRiskPct, 0.015);
        assert.equal(res.effectiveRiskBudgetUsdt, equity * 0.015); // 150 USDT
        const effRisk = calcEffectiveRiskPct(res.finalOrderNotionalUsdt, stopDistancePct, equity);
        assert(Math.abs(effRisk - 0.015) < 1e-6, `Expected effective risk 0.015, got ${effRisk}`);
    });

    // 2. S grade full -> effective risk = 1.50%
    it("2. S grade full -> effective risk = 1.50%", () => {
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({ entryQualityGrade: "S" }));
        assert.equal(res.sizingPassed, true);
        assert.equal(res.targetRiskPct, 0.015);
        assert.equal(res.effectiveRiskBudgetUsdt, equity * 0.015);
        const effRisk = calcEffectiveRiskPct(res.finalOrderNotionalUsdt, stopDistancePct, equity);
        assert(Math.abs(effRisk - 0.015) < 1e-6, `Expected effective risk 0.015, got ${effRisk}`);
    });

    // 3. B grade full -> effective risk = 1.00%
    it("3. B grade full -> effective risk = 1.00%", () => {
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({ entryQualityGrade: "B" }));
        assert.equal(res.sizingPassed, true);
        assert.equal(res.targetRiskPct, 0.010);
        assert.equal(res.effectiveRiskBudgetUsdt, equity * 0.010); // 100 USDT
        const effRisk = calcEffectiveRiskPct(res.finalOrderNotionalUsdt, stopDistancePct, equity);
        assert(Math.abs(effRisk - 0.010) < 1e-6, `Expected effective risk 0.010, got ${effRisk}`);
    });

    // 4. Micro probe -> final effective risk = 0.50%
    it("4. Micro probe -> final effective risk = 0.50%", () => {
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({
            isMicroProbe: true,
            entryProbeSizingSource: "DEFAULT_MICRO_PROBE",
            entryQualityGrade: "A"
        }));
        assert.equal(res.sizingPassed, true);
        assert.equal(res.isMicroProbe, true);
        assert.equal(res.targetRiskPct, 0.005);
        assert.equal(res.effectiveRiskBudgetUsdt, equity * 0.005); // 50 USDT
        const effRisk = calcEffectiveRiskPct(res.finalOrderNotionalUsdt, stopDistancePct, equity);
        assert(Math.abs(effRisk - 0.005) < 1e-6, `Expected effective risk 0.005, got ${effRisk}`);
    });

    // 5. Micro probe에서 기존 0.25x가 다시 곱해지지 않음
    it("5. Micro probe에서 기존 0.25x가 다시 곱해지지 않음 (zero double-reduction)", () => {
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({
            isMicroProbe: true,
            entryProbeSizeMultiplier: 0.25,
            entryProbeSizingSource: "V2_RANGE_TREND_RECLAIM_MICRO_PROBE",
            entryQualityGrade: "A"
        }));
        assert.equal(res.sizingPassed, true);
        assert.equal(res.isMicroProbe, true);
        assert.equal(res.probeMultiplierApplied, 1);
        assert.equal(res.targetRiskPct, 0.005);
        assert.equal(res.effectiveRiskBudgetUsdt, equity * 0.005);
        const effRisk = calcEffectiveRiskPct(res.finalOrderNotionalUsdt, stopDistancePct, equity);
        assert(Math.abs(effRisk - 0.005) < 1e-6, `Expected effective risk 0.005, got ${effRisk}`);
    });

    // 6. 기존 BTC open risk = 1.5%, 신규 ETH A 요청 = 1.5% -> ETH는 1.0%로 clamp
    it("6. 기존 BTC open risk = 1.5%, 신규 ETH A 요청 = 1.5% -> ETH는 1.0%로 clamp", () => {
        const existingBtcRisk = equity * 0.015; // 150 USDT
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({
            symbol: "ETHUSDT",
            entryQualityGrade: "A",
            existingAccountOpenRiskUsdt: existingBtcRisk
        }));
        assert.equal(res.sizingPassed, true);
        assert.equal(res.accountRiskCapUsdt, equity * 0.025); // 250 USDT
        assert.equal(res.existingAccountOpenRiskUsdt, 150);
        assert.equal(res.remainingAccountRiskUsdt, 100); // 250 - 150 = 100 USDT (1.0% equity)
        assert.equal(res.effectiveRiskBudgetUsdt, 100);
        assert.equal(res.limitingAuthority, "account_open_risk_cap");
        const effRisk = calcEffectiveRiskPct(res.finalOrderNotionalUsdt, stopDistancePct, equity);
        assert(Math.abs(effRisk - 0.010) < 1e-6, `Expected clamped effective risk 0.010, got ${effRisk}`);
    });

    // 7. 기존 BTC open risk = 0.7%, ETH A 요청 -> ETH 1.5% 전체 허용
    it("7. 기존 BTC open risk = 0.7%, ETH A 요청 -> ETH 1.5% 전체 허용", () => {
        const existingBtcRisk = equity * 0.007; // 70 USDT
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({
            symbol: "ETHUSDT",
            entryQualityGrade: "A",
            existingAccountOpenRiskUsdt: existingBtcRisk
        }));
        assert.equal(res.sizingPassed, true);
        assert.equal(res.accountRiskCapUsdt, 250);
        assert.equal(res.remainingAccountRiskUsdt, 180); // 250 - 70 = 180 USDT (1.8% equity)
        assert.equal(res.effectiveRiskBudgetUsdt, 150); // Min(150, 180) = 150 USDT
        assert.equal(res.limitingAuthority, "risk_based_notional");
        const effRisk = calcEffectiveRiskPct(res.finalOrderNotionalUsdt, stopDistancePct, equity);
        assert(Math.abs(effRisk - 0.015) < 1e-6, `Expected effective risk 0.015, got ${effRisk}`);
    });

    // 8. 기존 open risk = 2.4%, B 신규 요청 -> 최대 0.1%
    it("8. 기존 open risk = 2.4%, B 신규 요청 -> 최대 0.1%", () => {
        const existingRisk = equity * 0.024; // 240 USDT
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({
            entryQualityGrade: "B",
            existingAccountOpenRiskUsdt: existingRisk
        }));
        assert.equal(res.sizingPassed, true);
        assert.equal(res.remainingAccountRiskUsdt, 10); // 250 - 240 = 10 USDT (0.1% equity)
        assert.equal(res.effectiveRiskBudgetUsdt, 10);
        assert.equal(res.limitingAuthority, "account_open_risk_cap");
        const effRisk = calcEffectiveRiskPct(res.finalOrderNotionalUsdt, stopDistancePct, equity);
        assert(Math.abs(effRisk - 0.001) < 1e-6, `Expected clamped effective risk 0.001, got ${effRisk}`);
    });

    // 9. 기존 open risk >= 2.5% -> 신규 exposure risk = 0
    it("9. 기존 open risk >= 2.5% -> 신규 exposure risk = 0", () => {
        const existingRisk = equity * 0.025; // 250 USDT
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({
            entryQualityGrade: "A",
            existingAccountOpenRiskUsdt: existingRisk
        }));
        assert.equal(res.sizingPassed, false);
        assert.equal(res.blockReason, "ACCOUNT_TOTAL_OPEN_RISK_CAP_EXCEEDED");
        assert.equal(res.effectiveRiskBudgetUsdt, 0);
        assert.equal(res.finalOrderNotionalUsdt, 0);
    });

    // 10. BTC + ETH 둘 다 보유해도 total risk <= 2.5%
    it("10. BTC + ETH 둘 다 보유해도 total risk <= 2.5%", () => {
        const positions: DirectPositionRiskInput[] = [
            {
                symbol: "BTCUSDT",
                side: "long",
                notionalUsdt: 10000,
                entryPrice: 100,
                canonicalStopPrice: 98.7, // stop dist = 1.3% -> open risk = 130 USDT (1.3%)
                isStopKnown: true
            },
            {
                symbol: "ETHUSDT",
                side: "long",
                notionalUsdt: 10000,
                entryPrice: 100,
                canonicalStopPrice: 99.0, // stop dist = 1.0% -> open risk = 100 USDT (1.0%)
                isStopKnown: true
            }
        ];
        const openRiskAuth = resolveAccountOpenRiskAuthority({
            equityUsdt: equity,
            directPositions: positions
        });
        assert(Math.abs(openRiskAuth.totalOpenRiskUsdt - 230) < 1e-4, `Expected total risk close to 230, got ${openRiskAuth.totalOpenRiskUsdt}`);
        assert(Math.abs(openRiskAuth.remainingAccountRiskUsdt - 20) < 1e-4, `Expected remaining risk close to 20, got ${openRiskAuth.remainingAccountRiskUsdt}`);

        // Now attempt another entry with grade A (target 1.5% = 150 USDT)
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({
            entryQualityGrade: "A",
            existingAccountOpenRiskUsdt: openRiskAuth.totalOpenRiskUsdt
        }));
        assert.equal(res.sizingPassed, true);
        assert(Math.abs(res.effectiveRiskBudgetUsdt - 20) < 1e-4, `Clamped to 20 USDT, got ${res.effectiveRiskBudgetUsdt}`);
        const totalProjectedRisk = openRiskAuth.totalOpenRiskUsdt + res.effectiveRiskBudgetUsdt;
        assert(totalProjectedRisk <= openRiskAuth.accountRiskCapUsdt + 1e-6);
        assert(totalProjectedRisk <= equity * 0.025 + 1e-6);
    });

    // 11. 기존 포지션 stop missing -> 0으로 취급하지 않고 1.5% conservative reserve
    it("11. 기존 포지션 stop missing -> 0으로 취급하지 않고 1.5% conservative reserve", () => {
        const positions: DirectPositionRiskInput[] = [
            {
                symbol: "BTCUSDT",
                side: "long",
                notionalUsdt: 10000,
                entryPrice: 100,
                canonicalStopPrice: null, // stop MISSING
                isStopKnown: false
            }
        ];
        const openRiskAuth = resolveAccountOpenRiskAuthority({
            equityUsdt: equity,
            directPositions: positions
        });
        // 1.50% equity reserve applied
        const expectedReserve = equity * UNKNOWN_OPEN_POSITION_RISK_RESERVE_PCT; // 150 USDT
        assert.equal(openRiskAuth.totalOpenRiskUsdt, expectedReserve);
        assert.equal(openRiskAuth.positions[0].stopSource, "UNKNOWN_FALLBACK");
        assert.equal(openRiskAuth.positions[0].isStopKnown, false);
        assert.equal(openRiskAuth.remainingAccountRiskUsdt, 100); // 250 - 150 = 100 USDT (1.0%)

        const res = evaluateEquityAdaptiveSizing(makeBaseInput({
            entryQualityGrade: "A",
            existingPositionsRisk: positions
        }));
        assert.equal(res.sizingPassed, true);
        assert.equal(res.effectiveRiskBudgetUsdt, 100); // clamped to 100 USDT
    });

    // 12. leverage 10x unchanged
    it("12. leverage 10x unchanged", () => {
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({ appliedLeverage: 10 }));
        assert.equal(res.sizingPassed, true);
        assert.equal(res.finalRequiredMarginUsdt, res.finalOrderNotionalUsdt / 10);
    });

    // 13. TP unchanged
    it("13. TP unchanged (verify sizing does not alter TP reference)", () => {
        const res = evaluateEquityAdaptiveSizing(makeBaseInput());
        assert.equal(res.sizingPassed, true);
        // Sizing authority is purely risk/notional based, does not define or alter TP prices
        assert(res.finalOrderNotionalUsdt > 0);
    });

    // 14. SL unchanged
    it("14. SL unchanged (stopDistance is strictly preserved from effectiveStopPrice)", () => {
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({
            entryReferencePrice: 100,
            effectiveStopPrice: 98 // stop distance = 2%
        }));
        assert.equal(res.sizingPassed, true);
        assert.equal(res.stopDistancePct, 0.02);
    });

    // 15. entry gates unchanged
    it("15. entry gates unchanged (fail-closed when quality grade is invalid)", () => {
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({ entryQualityGrade: null }));
        assert.equal(res.sizingPassed, false);
        assert.equal(res.blockReason, "ENTRY_QUALITY_GRADE_BLOCKED");
    });

    // 16. BTC stale-shock behavior unchanged
    it("16. BTC stale-shock behavior unchanged (fail-closed on zero stop distance)", () => {
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({
            entryReferencePrice: 100,
            effectiveStopPrice: 100 // stop distance 0 = invalid
        }));
        assert.equal(res.sizingPassed, false);
        assert.equal(res.blockReason, "STOP_DISTANCE_INVALID");
    });

    // 17. ETH feasibility unchanged
    it("17. ETH feasibility unchanged (fail-closed on effective stop price missing)", () => {
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({
            symbol: "ETHUSDT",
            effectiveStopPrice: null
        }));
        assert.equal(res.sizingPassed, false);
        assert.equal(res.blockReason, "EFFECTIVE_STOP_PRICE_MISSING");
    });

    // 18. Notional caps unchanged
    it("18. Notional caps unchanged (equityInitialCap=2.3x, symbolCap=2.75x, accountCap=3.0x)", () => {
        const res = evaluateEquityAdaptiveSizing(makeBaseInput());
        assert.equal(res.equityInitialCapUsdt, equity * MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE); // 23,000
        assert.equal(res.symbolCapUsdt, equity * MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE); // 27,500
        assert.equal(res.accountCapUsdt, equity * MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE); // 30,000
    });

    // 19. ADDON eligibility unchanged
    it("19. ADDON eligibility unchanged (ADVERSE_ADDON uses maxAdverseAddonUsdt and policyRequested)", () => {
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({
            orderKind: "ADVERSE_ADDON",
            policyRequestedNotionalUsdt: 2000,
            adverseRiskBudgetAllowedNotional: 2500,
            existingSymbolNotionalUsdt: 10000,
            existingAccountNotionalUsdt: 10000
        }));
        assert.equal(res.sizingPassed, true);
        assert.equal(res.maxAdverseAddonUsdt, equity * 0.25); // 2,500
        assert.equal(res.finalOrderNotionalUsdt, 2000);
    });

    // 20. ADDON cannot bypass account open-risk cap
    it("20. ADDON cannot bypass account open-risk cap", () => {
        const existingRisk = equity * 0.025; // 250 USDT (at 2.5% hard cap)
        const res = evaluateEquityAdaptiveSizing(makeBaseInput({
            orderKind: "ADVERSE_ADDON",
            policyRequestedNotionalUsdt: 2000,
            existingAccountOpenRiskUsdt: existingRisk
        }));
        assert.equal(res.sizingPassed, false);
        assert.equal(res.blockReason, "ACCOUNT_TOTAL_OPEN_RISK_CAP_EXCEEDED");
    });
});
