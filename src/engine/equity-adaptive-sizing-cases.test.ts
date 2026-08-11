import {
    evaluateEquityAdaptiveSizing,
    evaluateEquitySizingAuthority,
    RISK_PER_TRADE_PCT,
    MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE,
    MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
    MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE,
    MAX_ADVERSE_ADDON_EQUITY_MULTIPLE
} from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import { resolveLiveExposureAuthority } from "../engine-v2/live-account/exposure-authority";

function assertClose(actual: number, expected: number, tol = 0.5, label = ""): void {
    if (Math.abs(actual - expected) > tol) {
        throw new Error(`${label} expected ~${expected}, got ${actual}`);
    }
}

function entrySizing(input: {
    equity: number;
    available?: number;
    entryPrice: number;
    stopPrice: number;
    existingSymbol?: number;
    existingAccount?: number;
    grade?: "A" | "B" | "S";
    instrumentSizing?: { lotSz: number; minSz: number; ctVal: number; ctValCcy: string } | null;
}) {
    const stopDistancePct = Math.abs(input.entryPrice - input.stopPrice) / input.entryPrice;
    return evaluateEquityAdaptiveSizing({
        symbol: "BTCUSDT",
        side: "long",
        orderKind: "ENTRY",
        accountEquityUsdt: input.equity,
        availableBalanceUsdt: input.available ?? input.equity,
        entryReferencePrice: input.entryPrice,
        effectiveStopPrice: input.stopPrice,
        appliedLeverage: 10,
        entryQualityGrade: input.grade ?? "A",
        existingSymbolNotionalUsdt: input.existingSymbol ?? 0,
        existingAccountNotionalUsdt: input.existingAccount ?? input.existingSymbol ?? 0,
        roundTripFeeRate: 0,
        lastPrice: input.entryPrice,
        instrumentSizing: input.instrumentSizing ?? null
    });
}

function runCases(): void {
    // CASE A
    {
        const r = entrySizing({ equity: 68, entryPrice: 100_000, stopPrice: 99_500 });
        assertClose(r.riskBudgetUsdt, 0.34, 0.01, "CASE A riskBudget");
        assertClose(r.riskBasedNotionalUsdt, 68, 1, "CASE A riskBased");
        assertClose(r.finalOrderNotionalUsdt, 54.4, 1, "CASE A final");
    }

    // CASE B
    {
        const r = entrySizing({ equity: 200, entryPrice: 100_000, stopPrice: 99_500 });
        assertClose(r.riskBudgetUsdt, 1.0, 0.01, "CASE B riskBudget");
        assertClose(r.finalOrderNotionalUsdt, 160, 1, "CASE B final");
    }

    // CASE C
    {
        const r = entrySizing({ equity: 68, entryPrice: 100_000, stopPrice: 99_000 });
        assertClose(r.finalOrderNotionalUsdt, 34, 1, "CASE C final");
    }

    // CASE D
    {
        const r = entrySizing({ equity: 68, entryPrice: 100_000, stopPrice: 99_800 });
        assertClose(r.riskBasedNotionalUsdt, 170, 2, "CASE D riskBased");
        assertClose(r.finalOrderNotionalUsdt, 54.4, 1, "CASE D final");
    }

    // CASE E
    {
        const r = entrySizing({
            equity: 68,
            entryPrice: 100_000,
            stopPrice: 99_500,
            existingSymbol: 50,
            existingAccount: 50
        });
        assertClose(r.finalOrderNotionalUsdt, 18, 1, "CASE E final");
    }

    // CASE F
    {
        const r = entrySizing({
            equity: 68,
            entryPrice: 100_000,
            stopPrice: 99_500,
            existingSymbol: 50,
            existingAccount: 95
        });
        assertClose(r.finalOrderNotionalUsdt, 7, 1, "CASE F final");
    }

    // CASE G
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
            equity: 10,
            entryPrice: 100_000,
            stopPrice: 99_000,
            instrumentSizing: { lotSz: 0.01, minSz: 0.01, ctVal: 0.01, ctValCcy: "BTC" }
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

    // CASE J
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

    // CASE L
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

    console.info(JSON.stringify({
        event: "V2_EQUITY_ADAPTIVE_SIZING_CASES_PASS",
        cases: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"],
        risk_per_trade_pct: RISK_PER_TRADE_PCT,
        initial_cap_multiple: MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE,
        symbol_cap_multiple: MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
        account_cap_multiple: MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE,
        adverse_addon_cap_multiple: MAX_ADVERSE_ADDON_EQUITY_MULTIPLE
    }));
}

runCases();
