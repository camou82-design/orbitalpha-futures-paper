import {
    evaluateEquityAdaptiveSizing,
    evaluateEquitySizingAuthority,
    RISK_PER_TRADE_PCT,
    MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE,
    MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
    MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE,
    MAX_ADVERSE_ADDON_EQUITY_MULTIPLE
} from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import { normalizeOkxSwapContractsFromNotional } from "../engine-v2/okx-swap-sizing";
import { resolveLiveExposureAuthority } from "../engine-v2/live-account/exposure-authority";

const BTC_INSTRUMENT = { lotSz: 0.01, minSz: 0.01, ctVal: 0.01, ctValCcy: "BTC" };

function assertClose(actual: number, expected: number, tol = 0.5, label = ""): void {
    if (Math.abs(actual - expected) > tol) {
        throw new Error(`${label} expected ~${expected}, got ${actual}`);
    }
}

function assertTrue(value: boolean, label: string): void {
    if (!value) throw new Error(`${label}: expected true`);
}

function entrySizing(input: {
    equity: number;
    available?: number;
    entryPrice: number;
    stopPrice: number;
    side?: "long" | "short";
    existingSymbol?: number;
    existingAccount?: number;
    grade?: "A" | "B" | "S";
    leverage?: number;
    instrumentSizing?: { lotSz: number; minSz: number; ctVal: number; ctValCcy: string } | null;
    roundTripFeeRate?: number;
}) {
    return evaluateEquityAdaptiveSizing({
        symbol: "BTCUSDT",
        side: input.side ?? "long",
        orderKind: "ENTRY",
        accountEquityUsdt: input.equity,
        availableBalanceUsdt: input.available ?? input.equity,
        entryReferencePrice: input.entryPrice,
        effectiveStopPrice: input.stopPrice,
        appliedLeverage: input.leverage ?? 10,
        entryQualityGrade: input.grade ?? "A",
        existingSymbolNotionalUsdt: input.existingSymbol ?? 0,
        existingAccountNotionalUsdt: input.existingAccount ?? input.existingSymbol ?? 0,
        roundTripFeeRate: input.roundTripFeeRate ?? 0,
        lastPrice: input.entryPrice,
        instrumentSizing: input.instrumentSizing ?? null
    });
}

function evaluateLegacyPolicySizing(input: {
    equity: number;
    entryPrice: number;
    stopPrice: number;
    grade?: "A" | "B" | "S";
    instrumentSizing?: typeof BTC_INSTRUMENT | null;
}) {
    const grade = input.grade ?? "B";
    const qualityMultiplier = grade === "B" ? 0.8 : 1.0;
    const legacyRiskPct = 0.005 * qualityMultiplier;
    const stopDistancePct = Math.abs(input.entryPrice - input.stopPrice) / input.entryPrice;
    const riskBudgetUsdt = input.equity * legacyRiskPct;
    const riskBasedNotionalUsdt = riskBudgetUsdt / stopDistancePct;
    const equityInitialCapUsdt = input.equity * 0.8;
    const preLotNotionalUsdt = Math.min(
        riskBasedNotionalUsdt,
        equityInitialCapUsdt,
        input.equity * 1.0,
        input.equity * 1.5
    );
    if (input.instrumentSizing == null) {
        return { preLotNotionalUsdt, finalOrderNotionalUsdt: preLotNotionalUsdt };
    }
    const norm = normalizeOkxSwapContractsFromNotional({
        desiredNotionalUsdt: preLotNotionalUsdt,
        lastPrice: input.entryPrice,
        sizing: input.instrumentSizing
    });
    return {
        preLotNotionalUsdt,
        finalOrderNotionalUsdt: norm.actualNotional,
        normalizedContracts: norm.normalized_contracts
    };
}

function runCases(): void {
    // CASE A — A-grade risk budget at equity 68; initial cap now binds at equity×2.0
    {
        const r = entrySizing({ equity: 68, entryPrice: 100_000, stopPrice: 99_500 });
        assertClose(r.riskPct, 0.010, 0.0001, "CASE A riskPct");
        assertClose(r.riskBudgetUsdt, 0.68, 0.01, "CASE A riskBudget");
        assertClose(r.riskBasedNotionalUsdt, 136, 1, "CASE A riskBased");
        assertClose(r.equityInitialCapUsdt, 136, 0.01, "CASE A initial cap");
        assertClose(r.finalOrderNotionalUsdt, 136, 1, "CASE A final");
    }

    // CASE B — larger equity scales final notional with initial cap
    {
        const r = entrySizing({ equity: 200, entryPrice: 100_000, stopPrice: 99_500 });
        assertClose(r.riskBudgetUsdt, 2.0, 0.01, "CASE B riskBudget");
        assertClose(r.finalOrderNotionalUsdt, 400, 1, "CASE B final");
    }

    // CASE C — wider stop distance reduces risk-based notional below initial cap
    {
        const r = entrySizing({ equity: 68, entryPrice: 100_000, stopPrice: 99_000 });
        assertClose(r.finalOrderNotionalUsdt, 68, 1, "CASE C final");
    }

    // CASE D — tight stop raises risk-based notional; initial cap binds
    {
        const r = entrySizing({ equity: 68, entryPrice: 100_000, stopPrice: 99_800 });
        assertClose(r.riskBasedNotionalUsdt, 340, 2, "CASE D riskBased");
        assertClose(r.finalOrderNotionalUsdt, 136, 1, "CASE D final");
    }

    // CASE E — existing symbol exposure reduces remaining symbol capacity
    {
        const r = entrySizing({
            equity: 68,
            entryPrice: 100_000,
            stopPrice: 99_500,
            existingSymbol: 50,
            existingAccount: 50
        });
        assertClose(r.symbolCapUsdt, 170, 0.01, "CASE E symbol cap");
        assertClose(r.finalOrderNotionalUsdt, 120, 1, "CASE E final");
    }

    // CASE F — existing account exposure reduces remaining account capacity
    {
        const r = entrySizing({
            equity: 68,
            entryPrice: 100_000,
            stopPrice: 99_500,
            existingSymbol: 50,
            existingAccount: 95
        });
        assertClose(r.accountCapUsdt, 204, 0.01, "CASE F account cap");
        assertClose(r.finalOrderNotionalUsdt, 109, 1, "CASE F final");
    }

    // CASE G — available margin guard unchanged
    {
        const r = entrySizing({
            equity: 68,
            available: 2,
            entryPrice: 100_000,
            stopPrice: 99_500
        });
        if (r.blockReason !== "AVAILABLE_MARGIN_INSUFFICIENT") {
            throw new Error(`CASE G expected AVAILABLE_MARGIN_INSUFFICIENT, got ${r.blockReason}`);
        }
    }

    // CASE H — min lot normalization pushes actual risk above budget tolerance
    {
        const r = entrySizing({
            equity: 8,
            entryPrice: 100_000,
            stopPrice: 99_000,
            instrumentSizing: BTC_INSTRUMENT
        });
        if (r.blockReason !== "MIN_LOT_RISK_BUDGET_EXCEEDED") {
            throw new Error(`CASE H expected MIN_LOT_RISK_BUDGET_EXCEEDED, got ${r.blockReason}`);
        }
    }

    // CASE I — equity increase raises cap; no resize of existing (sizing module only checks new order)
    {
        const r68 = entrySizing({ equity: 68, entryPrice: 100_000, stopPrice: 99_500 });
        const r168 = entrySizing({ equity: 168, entryPrice: 100_000, stopPrice: 99_500 });
        if (!(r168.finalOrderNotionalUsdt > r68.finalOrderNotionalUsdt)) {
            throw new Error("CASE I cap should increase with equity deposit");
        }
    }

    // CASE J — adverse addon cap unchanged at equity×0.25
    {
        const r = evaluateEquityAdaptiveSizing({
            symbol: "BTCUSDT",
            side: "long",
            orderKind: "ADVERSE_ADDON",
            accountEquityUsdt: 68,
            availableBalanceUsdt: 68,
            entryReferencePrice: 100_000,
            effectiveStopPrice: 99_000,
            appliedLeverage: 10,
            existingSymbolNotionalUsdt: 20,
            existingAccountNotionalUsdt: 20,
            policyRequestedNotionalUsdt: 30,
            roundTripFeeRate: 0,
            lastPrice: 100_000
        });
        assertClose(r.finalOrderNotionalUsdt, 17, 0.5, "CASE J adverse addon cap");
        assertClose(r.maxAdverseAddonUsdt, 17, 0.01, "CASE J adverse addon cap source");
    }

    // CASE K — manual/external position included in account exposure
    {
        const exposure = resolveLiveExposureAuthority({
            symbol: "BTCUSDT",
            okxPositions: [
                { symbol: "BTCUSDT", sizeUsd: 30, side: "LONG" },
                { symbol: "ETHUSDT", sizeUsd: 20, side: "SHORT" }
            ],
            paperPositions: [],
            pendingSymbolNotionalUsdt: 0,
            pendingOrdersNotionalUsdt: 0,
            isLiveAuthority: true
        });
        if (exposure.final_account_notional_usdt !== 50) {
            throw new Error(`CASE K account exposure expected 50, got ${exposure.final_account_notional_usdt}`);
        }
        if (exposure.final_symbol_notional_usdt !== 30) {
            throw new Error(`CASE K symbol exposure expected 30, got ${exposure.final_symbol_notional_usdt}`);
        }
    }

    // CASE L — equity authority fail-closed
    {
        const auth = evaluateEquitySizingAuthority({
            symbol: "BTCUSDT",
            accountEquityUsdt: null,
            availableBalanceUsdt: null,
            liveBalanceReady: false,
            okxAuthReady: false,
            equityFresh: false,
            equitySource: "okx_total_eq"
        });
        if (auth.sizingAuthorityReady) {
            throw new Error("CASE L should fail closed");
        }
    }

    // CASE M — live-like BTC short B-grade regression (equity 68, ~64k, ~0.26% stop, 10x)
    {
        const equity = 68;
        const entryPrice = 64_057.5;
        const stopPrice = 64_224.15;
        const norm = normalizeOkxSwapContractsFromNotional({
            desiredNotionalUsdt: 128.728,
            lastPrice: entryPrice,
            sizing: BTC_INSTRUMENT
        });

        const r = entrySizing({
            equity,
            available: 66,
            entryPrice,
            stopPrice,
            side: "short",
            grade: "B",
            leverage: 10,
            instrumentSizing: BTC_INSTRUMENT,
            roundTripFeeRate: 0.001
        });

        assertClose(r.riskPct, 0.008, 0.0001, "CASE M B-grade riskPct");
        assertClose(r.riskBudgetUsdt, 0.544, 0.01, "CASE M riskBudget");
        assertClose(r.equityInitialCapUsdt, 136, 0.01, "CASE M equityInitialCap");
        assertClose(r.symbolCapUsdt, 170, 0.01, "CASE M symbolCap");
        assertClose(r.accountCapUsdt, 204, 0.01, "CASE M accountCap");
        assertClose(r.stopDistancePct, Math.abs(entryPrice - stopPrice) / entryPrice, 0.000001, "CASE M stopDistancePct");
        assertClose(r.riskBasedNotionalUsdt, 128.728, 0.5, "CASE M riskBasedNotional");
        assertClose(r.preLotNotionalUsdt, 128.728, 0.5, "CASE M preLotNotional");
        assertClose(r.normalizedContracts ?? 0, norm.normalized_contracts, 0, "CASE M normalizedContracts");
        assertClose(r.finalOrderNotionalUsdt, norm.actualNotional, 0.5, "CASE M finalOrderNotional");
        assertClose(r.finalRequiredMarginUsdt, r.finalOrderNotionalUsdt / 10, 0.01, "CASE M finalRequiredMargin");
        assertTrue(
            r.finalRequiredMarginUsdt === r.finalOrderNotionalUsdt / 10,
            "CASE M leverage applies to margin only"
        );
        assertTrue(
            r.equityInitialCapUsdt === equity * MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE,
            "CASE M initial cap is equity multiple not leverage-scaled"
        );
        assertTrue(r.actualRiskPct != null && r.actualRiskPct > 0, "CASE M actualRiskPct present");
        assertTrue(r.sizingPassed, "CASE M sizingPassed");

        const legacy = evaluateLegacyPolicySizing({
            equity,
            entryPrice,
            stopPrice,
            grade: "B",
            instrumentSizing: BTC_INSTRUMENT
        });
        assertTrue(
            r.finalOrderNotionalUsdt > legacy.finalOrderNotionalUsdt * 1.5,
            "CASE M materially larger than legacy policy"
        );
        assertClose(legacy.finalOrderNotionalUsdt, 51.246, 0.5, "CASE M legacy baseline");
        assertClose(legacy.normalizedContracts ?? 0, 0.08, 0, "CASE M legacy contracts");
        assertClose(r.normalizedContracts ?? 0, 0.2, 0, "CASE M new contracts");
    }

    // CASE N — emergency absolute cap still binds
    {
        const r = evaluateEquityAdaptiveSizing({
            symbol: "BTCUSDT",
            side: "long",
            orderKind: "ENTRY",
            accountEquityUsdt: 68,
            availableBalanceUsdt: 68,
            entryReferencePrice: 100_000,
            effectiveStopPrice: 99_500,
            appliedLeverage: 10,
            entryQualityGrade: "A",
            existingSymbolNotionalUsdt: 0,
            existingAccountNotionalUsdt: 0,
            emergencyAbsoluteCapUsdt: 90,
            roundTripFeeRate: 0,
            lastPrice: 100_000
        });
        assertClose(r.finalOrderNotionalUsdt, 90, 0.01, "CASE N emergency cap");
    }

    // CASE O — V2 emergency failsafe 500 binds even when equity-adaptive sizing would exceed it
    {
        const uncapped = entrySizing({ equity: 600, entryPrice: 100_000, stopPrice: 99_500 });
        if (!(uncapped.finalOrderNotionalUsdt > 500)) {
            throw new Error(
                `CASE O setup: uncapped sizing should exceed 500, got ${uncapped.finalOrderNotionalUsdt}`
            );
        }
        const capped = evaluateEquityAdaptiveSizing({
            symbol: "BTCUSDT",
            side: "long",
            orderKind: "ENTRY",
            accountEquityUsdt: 600,
            availableBalanceUsdt: 600,
            entryReferencePrice: 100_000,
            effectiveStopPrice: 99_500,
            appliedLeverage: 10,
            entryQualityGrade: "A",
            existingSymbolNotionalUsdt: 0,
            existingAccountNotionalUsdt: 0,
            emergencyAbsoluteCapUsdt: 500,
            roundTripFeeRate: 0,
            lastPrice: 100_000
        });
        if (capped.finalOrderNotionalUsdt > 500) {
            throw new Error(
                `CASE O emergency cap: finalOrderNotionalUsdt must be <= 500, got ${capped.finalOrderNotionalUsdt}`
            );
        }
        assertClose(capped.finalOrderNotionalUsdt, 500, 0.01, "CASE O emergency cap at 500");
        assertTrue(capped.emergencyCapUsdt === 500, "CASE O emergencyCapUsdt recorded");
        assertTrue(capped.effectiveLiveCapUsdt === 500, "CASE O effectiveLiveCapUsdt recorded");
    }

    console.info(JSON.stringify({
        event: "V2_EQUITY_ADAPTIVE_SIZING_CASES_PASS",
        cases: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O"],
        risk_per_trade_pct: RISK_PER_TRADE_PCT,
        initial_cap_multiple: MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE,
        symbol_cap_multiple: MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
        account_cap_multiple: MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE,
        adverse_addon_cap_multiple: MAX_ADVERSE_ADDON_EQUITY_MULTIPLE
    }));
}

runCases();
