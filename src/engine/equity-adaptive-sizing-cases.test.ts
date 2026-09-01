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
    symbol?: string;
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
    entryProbeSizeMultiplier?: number | null;
    entryProbeSizingSource?: string | null;
    htfSizeMultiplier?: number;
}) {
    return evaluateEquityAdaptiveSizing({
        symbol: input.symbol ?? "BTCUSDT",
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
        instrumentSizing: input.instrumentSizing ?? null,
        entryProbeSizeMultiplier: input.entryProbeSizeMultiplier,
        entryProbeSizingSource: input.entryProbeSizingSource,
        htfSizeMultiplier: input.htfSizeMultiplier
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

    // CASE O — non-V2 emergency cap still binds when equity-adaptive sizing would exceed it
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
        assertClose(capped.finalOrderNotionalUsdt, 500, 0.01, "CASE O non-V2 emergency cap at 500");
        assertTrue(capped.emergencyCapUsdt === 500, "CASE O emergencyCapUsdt recorded");
        assertTrue(capped.effectiveLiveCapUsdt === 500, "CASE O effectiveLiveCapUsdt recorded for non-V2");
    }

    // CASE O2 — V2 failsafe emergency cap binds when explicitly active
    {
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
            v2AuthorityEntry: true,
            emergencyFailsafeActive: true,
            roundTripFeeRate: 0,
            lastPrice: 100_000
        });
        assertClose(capped.finalOrderNotionalUsdt, 500, 0.01, "CASE O2 V2 failsafe emergency cap at 500");
        assertTrue(capped.emergencyCapApplied === true, "CASE O2 emergencyCapApplied");
    }

    // CASE P — ETH 2503.37 / 10x regression: Full canonical sizing 100 USDT -> 25% probe = 25 USDT
    // Legacy 7.51011 USDT (from baseSizeUsd≈3 * 0.25 * 10x) MUST NEVER reappear
    {
        const ethPrice = 2503.37;
        const stopPrice = 2478.3363; // ~1% stop distance
        const rFull = entrySizing({
            symbol: "ETHUSDT",
            equity: 100, // 1% risk = 1.0 USDT / 0.01 stop = 100 USDT risk-based notional
            entryPrice: ethPrice,
            stopPrice: stopPrice,
            leverage: 10,
            grade: "A"
        });
        assertClose(rFull.riskBasedNotionalUsdt, 100, 1, "CASE P full riskBasedNotional");
        assertClose(rFull.finalOrderNotionalUsdt, 100, 1, "CASE P full finalOrderNotional");

        const rProbe25 = entrySizing({
            symbol: "ETHUSDT",
            equity: 100,
            entryPrice: ethPrice,
            stopPrice: stopPrice,
            leverage: 10,
            grade: "A",
            entryProbeSizeMultiplier: 0.25
        });
        assertClose(rProbe25.cappedFullEntryNotionalUsdt, 100, 1, "CASE P probe cappedFullEntryNotional");
        assertClose(rProbe25.probeMultiplierApplied, 0.25, 0.001, "CASE P probe probeMultiplierApplied");
        assertClose(rProbe25.probeAdjustedPreLotNotionalUsdt, 25, 0.5, "CASE P probe preLotNotional ~25 USDT");
        assertClose(rProbe25.finalOrderNotionalUsdt, 25, 0.5, "CASE P probe finalOrderNotional ~25 USDT");
        assertClose(rProbe25.finalRequiredMarginUsdt, 2.5, 0.05, "CASE P probe margin = notional / 10x");
        assertTrue(rProbe25.legacyAbsoluteProbeCapApplied === false, "CASE P legacyAbsoluteProbeCapApplied must be false");
        assertTrue(rProbe25.finalOrderNotionalUsdt > 20, "CASE P probe must NOT be collapsed to legacy 7.51011 USDT");
    }

    // CASE Q — Canonical full sizing 300 USDT -> 25%=75, 20%=60, 50%=150 scaling
    {
        const price = 1000;
        const stop = 990; // 1% stop
        // equity 300, 1% risk = 3.0 USDT / 0.01 = 300 USDT risk-based notional
        const r25 = entrySizing({
            equity: 300,
            entryPrice: price,
            stopPrice: stop,
            grade: "A",
            entryProbeSizeMultiplier: 0.25
        });
        assertClose(r25.cappedFullEntryNotionalUsdt, 300, 1, "CASE Q 25% full notional");
        assertClose(r25.finalOrderNotionalUsdt, 75, 1, "CASE Q 25% probe = 75 USDT");

        const r20 = entrySizing({
            equity: 300,
            entryPrice: price,
            stopPrice: stop,
            grade: "A",
            entryProbeSizeMultiplier: 0.20
        });
        assertClose(r20.finalOrderNotionalUsdt, 60, 1, "CASE Q 20% probe = 60 USDT");

        const r50 = entrySizing({
            equity: 300,
            entryPrice: price,
            stopPrice: stop,
            grade: "A",
            entryProbeSizeMultiplier: 0.50
        });
        assertClose(r50.finalOrderNotionalUsdt, 150, 1, "CASE Q 50% probe = 150 USDT");
    }

    // CASE R — Multiplier boundary & zero/negative safety values
    // ZERO MULTIPLIER SAFETY — BLOCKING: multiplier <= 0 MUST NEVER be silently promoted to full size.
    {
        const price = 1000;
        const stop = 990;

        // 1) mult = 0 -> MUST BLOCK (sizingPassed = false, blockReason = PROBE_MULTIPLIER_INVALID_ZERO_OR_NEGATIVE)
        const rZero = entrySizing({ equity: 100, entryPrice: price, stopPrice: stop, entryProbeSizeMultiplier: 0 });
        assertTrue(!rZero.sizingPassed, "CASE R multiplier=0 must NOT pass");
        assertTrue(rZero.blockReason === "PROBE_MULTIPLIER_INVALID_ZERO_OR_NEGATIVE", "CASE R multiplier=0 blockReason");
        assertTrue(rZero.finalOrderNotionalUsdt === 0, "CASE R multiplier=0 finalOrderNotional = 0 (never promoted to 100)");

        // 2) mult < 0 -> MUST BLOCK
        const rNeg = entrySizing({ equity: 100, entryPrice: price, stopPrice: stop, entryProbeSizeMultiplier: -0.25 });
        assertTrue(!rNeg.sizingPassed, "CASE R multiplier=-0.25 must NOT pass");
        assertTrue(rNeg.blockReason === "PROBE_MULTIPLIER_INVALID_ZERO_OR_NEGATIVE", "CASE R multiplier=-0.25 blockReason");

        // 3) mult = null / undefined -> full size (100 USDT)
        const rNull = entrySizing({ equity: 100, entryPrice: price, stopPrice: stop, entryProbeSizeMultiplier: null });
        assertClose(rNull.finalOrderNotionalUsdt, 100, 1, "CASE R null multiplier = 100");
        assertTrue(rNull.probeMultiplierApplied === 1, "CASE R null multiplier applied = 1");

        const rUndefined = entrySizing({ equity: 100, entryPrice: price, stopPrice: stop, entryProbeSizeMultiplier: undefined });
        assertClose(rUndefined.finalOrderNotionalUsdt, 100, 1, "CASE R undefined multiplier = 100");

        // 4) mult = 0.20 -> 20 USDT
        const r20 = entrySizing({ equity: 100, entryPrice: price, stopPrice: stop, entryProbeSizeMultiplier: 0.20 });
        assertClose(r20.finalOrderNotionalUsdt, 20, 0.5, "CASE R 0.20 multiplier = 20");

        // 5) mult = 0.25 -> 25 USDT
        const r25 = entrySizing({ equity: 100, entryPrice: price, stopPrice: stop, entryProbeSizeMultiplier: 0.25 });
        assertClose(r25.finalOrderNotionalUsdt, 25, 0.5, "CASE R 0.25 multiplier = 25");

        // 6) mult = 0.50 -> 50 USDT
        const r50 = entrySizing({ equity: 100, entryPrice: price, stopPrice: stop, entryProbeSizeMultiplier: 0.50 });
        assertClose(r50.finalOrderNotionalUsdt, 50, 0.5, "CASE R 0.50 multiplier = 50");

        // 7) mult = 1.00 -> 100 USDT
        const r100 = entrySizing({ equity: 100, entryPrice: price, stopPrice: stop, entryProbeSizeMultiplier: 1.00 });
        assertClose(r100.finalOrderNotionalUsdt, 100, 1, "CASE R 1.00 multiplier = 100");

        // 8) mult > 1 -> 100 USDT (no-op)
        const rGte1 = entrySizing({ equity: 100, entryPrice: price, stopPrice: stop, entryProbeSizeMultiplier: 1.5 });
        assertClose(rGte1.finalOrderNotionalUsdt, 100, 1, "CASE R >=1 multiplier = 100 (no-op)");
        assertTrue(rGte1.probeMultiplierApplied === 1, "CASE R >=1 multiplier applied = 1");
    }

    // CASE S — ADDON orders ignore entryProbeSizeMultiplier
    {
        const rAddon = evaluateEquityAdaptiveSizing({
            symbol: "BTCUSDT",
            side: "long",
            orderKind: "PYRAMIDING_ADDON",
            accountEquityUsdt: 100,
            availableBalanceUsdt: 100,
            entryReferencePrice: 1000,
            effectiveStopPrice: 990,
            appliedLeverage: 10,
            existingSymbolNotionalUsdt: 50,
            existingAccountNotionalUsdt: 50,
            policyRequestedNotionalUsdt: 40,
            roundTripFeeRate: 0,
            lastPrice: 1000,
            entryProbeSizeMultiplier: 0.25 // MUST BE IGNORED for ADDON
        });
        assertClose(rAddon.finalOrderNotionalUsdt, 40, 0.1, "CASE S ADDON ignores entryProbeSizeMultiplier");
        assertTrue(rAddon.probeMultiplierApplied === 1, "CASE S ADDON probeMultiplierApplied = 1");
    }

    // CASE T — Comprehensive Proof Field Structure Audit
    {
        const r = entrySizing({
            equity: 100,
            entryPrice: 2500,
            stopPrice: 2475,
            grade: "A",
            entryProbeSizeMultiplier: 0.25,
            htfSizeMultiplier: 0.8
        });
        assertTrue(r.riskBasedNotionalUsdt > 0, "CASE T riskBasedNotionalUsdt present");
        assertTrue(r.cappedFullEntryNotionalUsdt > 0, "CASE T cappedFullEntryNotionalUsdt present");
        assertTrue(r.probeMultiplierApplied === 0.25, "CASE T probeMultiplierApplied present");
        assertTrue(typeof r.probeSizingSource === "string", "CASE T probeSizingSource present");
        assertTrue(r.probeAdjustedPreLotNotionalUsdt > 0, "CASE T probeAdjustedPreLotNotionalUsdt present");
        assertTrue(r.htfSizeMultiplierApplied === 0.8, "CASE T htfSizeMultiplierApplied present");
        assertTrue(r.finalOrderNotionalUsdt > 0, "CASE T finalOrderNotionalUsdt present");
        assertTrue(r.finalRequiredMarginUsdt > 0, "CASE T finalRequiredMarginUsdt present");
        assertTrue(r.legacyAbsoluteProbeCapApplied === false, "CASE T legacyAbsoluteProbeCapApplied === false");

        console.info(JSON.stringify({
            event: "V2_PROBE_CANONICAL_SIZING_PROOF",
            riskBasedNotionalUsdt: r.riskBasedNotionalUsdt,
            cappedFullEntryNotionalUsdt: r.cappedFullEntryNotionalUsdt,
            probeMultiplierApplied: r.probeMultiplierApplied,
            probeSizingSource: r.probeSizingSource,
            probeAdjustedPreLotNotionalUsdt: r.probeAdjustedPreLotNotionalUsdt,
            htfSizeMultiplierApplied: r.htfSizeMultiplierApplied,
            finalOrderNotionalUsdt: r.finalOrderNotionalUsdt,
            normalizedContracts: r.normalizedContracts,
            finalRequiredMarginUsdt: r.finalRequiredMarginUsdt,
            effectiveLiveCapUsdt: r.effectiveLiveCapUsdt,
            legacyAbsoluteProbeCapApplied: r.legacyAbsoluteProbeCapApplied
        }));
    }

    // CASE U — Historical ETH 2503.37 / 10x with Production Contract Specification (ctVal = 0.1 ETH)
    // Proves:
    // 1. Production metadata: ctVal = 0.1, lotSz = 0.01, minSz = 0.01
    // 2. Historical defect: 0.03 contracts × 0.1 ctVal × 2503.37 = 7.51011 USDT (exact match!)
    // 3. Corrected canonical sizing (Equity 205 USDT):
    //    - Full sizing = min(riskBased, initialCap 410 USDT) -> 410.0 USDT -> raw 1.6377 contracts -> normalized 1.63 contracts -> actual 408.05 USDT
    //    - 25% probe = 102.5 USDT -> raw 0.4094 contracts -> normalized 0.40 contracts -> actual 100.13 USDT (margin 10.01 USDT)
    //    - 20% polarity probe = 82.0 USDT -> raw 0.3275 contracts -> normalized 0.32 contracts -> actual 80.11 USDT (margin 8.01 USDT)
    //    - ZERO collapse to 7.51011 USDT (legacy absolute probe cap NEVER applied)
    {
        const ethPrice = 2503.37;
        const stopPrice = 2496.72; // Historical stop ~0.2656% dist
        const equity = 205; // Live-like equity 200~207 USDT
        const PROD_ETH_INSTRUMENT = { lotSz: 0.01, minSz: 0.01, ctVal: 0.1, ctValCcy: "ETH" };

        // Defect Historical Check: 0.03 contracts with ctVal=0.1 exactly produces 7.51011 USDT
        const defectNotional = 0.03 * PROD_ETH_INSTRUMENT.ctVal * ethPrice;
        assertClose(defectNotional, 7.51011, 0.00001, "CASE U defect reproduction 0.03 contracts = 7.51011 USDT");

        // Full V2 Entry
        const rFull = entrySizing({
            symbol: "ETHUSDT",
            equity,
            entryPrice: ethPrice,
            stopPrice,
            leverage: 10,
            grade: "A",
            instrumentSizing: PROD_ETH_INSTRUMENT,
            entryProbeSizeMultiplier: null,
            entryProbeSizingSource: "NONE"
        });
        assertClose(rFull.cappedFullEntryNotionalUsdt, 410, 1, "CASE U full cappedFullEntryNotional");
        assertClose(rFull.normalizedContracts ?? 0, 1.63, 0.01, "CASE U full normalizedContracts = 1.63 (floor 1.6377)");
        assertClose(rFull.finalOrderNotionalUsdt, 1.63 * 0.1 * ethPrice, 0.01, "CASE U full finalOrderNotional = contracts * ctVal * price");
        assertTrue(rFull.probeMultiplierApplied === 1, "CASE U full probeMultiplierApplied = 1");
        assertTrue(rFull.probeSizingSource === "NONE", "CASE U full probeSizingSource = NONE");

        // 25% Continuation Micro-Probe
        const rProbe25 = entrySizing({
            symbol: "ETHUSDT",
            equity,
            entryPrice: ethPrice,
            stopPrice,
            leverage: 10,
            grade: "A",
            instrumentSizing: PROD_ETH_INSTRUMENT,
            entryProbeSizeMultiplier: 0.25,
            entryProbeSizingSource: "CONTINUATION_MICRO_PROBE"
        });
        assertClose(rProbe25.cappedFullEntryNotionalUsdt, 410, 1, "CASE U 25% cappedFullEntryNotional");
        assertClose(rProbe25.probeMultiplierApplied, 0.25, 0.001, "CASE U 25% probeMultiplierApplied");
        assertClose(rProbe25.probeAdjustedPreLotNotionalUsdt, 102.5, 0.5, "CASE U 25% preLotNotional = 102.5 USDT");
        // 102.5 / (2503.37 * 0.1) = 0.409448... -> floor with lotSz 0.01 -> 0.40 contracts
        assertClose(rProbe25.normalizedContracts ?? 0, 0.40, 0.001, "CASE U 25% normalizedContracts = 0.40 (not 4.09!)");
        assertClose(rProbe25.finalOrderNotionalUsdt, 0.40 * 0.1 * ethPrice, 0.01, "CASE U 25% finalOrderNotional = 0.40 * 0.1 * 2503.37 = 100.1348 USDT");
        assertClose(rProbe25.finalRequiredMarginUsdt, rProbe25.finalOrderNotionalUsdt / 10, 0.01, "CASE U 25% margin = notional / 10x");
        assertTrue(rProbe25.probeSizingSource === "CONTINUATION_MICRO_PROBE", "CASE U 25% probeSizingSource");
        assertTrue(rProbe25.legacyAbsoluteProbeCapApplied === false, "CASE U 25% legacyAbsoluteProbeCapApplied === false");
        assertTrue(rProbe25.finalOrderNotionalUsdt > 90 && rProbe25.finalOrderNotionalUsdt < 105, "CASE U 25% strictly within 90~105 USDT");

        // 20% Polarity Reversal Micro-Probe
        const rProbe20 = entrySizing({
            symbol: "ETHUSDT",
            equity,
            entryPrice: ethPrice,
            stopPrice,
            leverage: 10,
            grade: "A",
            instrumentSizing: PROD_ETH_INSTRUMENT,
            entryProbeSizeMultiplier: 0.20,
            entryProbeSizingSource: "V2_POLARITY_REVERSAL_MICRO_PROBE"
        });
        assertClose(rProbe20.probeMultiplierApplied, 0.20, 0.001, "CASE U 20% probeMultiplierApplied");
        assertClose(rProbe20.probeAdjustedPreLotNotionalUsdt, 82.0, 0.5, "CASE U 20% preLotNotional = 82.0 USDT");
        // 82.0 / (2503.37 * 0.1) = 0.327558... -> floor with lotSz 0.01 -> 0.32 contracts
        assertClose(rProbe20.normalizedContracts ?? 0, 0.32, 0.001, "CASE U 20% normalizedContracts = 0.32");
        assertClose(rProbe20.finalOrderNotionalUsdt, 0.32 * 0.1 * ethPrice, 0.01, "CASE U 20% finalOrderNotional = 0.32 * 0.1 * 2503.37 = 80.1078 USDT");
        assertTrue(rProbe20.probeSizingSource === "V2_POLARITY_REVERSAL_MICRO_PROBE", "CASE U 20% probeSizingSource");

        console.info(JSON.stringify({
            event: "V2_HISTORICAL_ETH_2503_REGRESSION_PROOF",
            symbol: "ETHUSDT",
            equityUsdt: equity,
            entryPrice: ethPrice,
            stopPrice,
            leverage: 10,
            ctVal: PROD_ETH_INSTRUMENT.ctVal,
            lotSz: PROD_ETH_INSTRUMENT.lotSz,
            fullEntryNotionalUsdt: rFull.finalOrderNotionalUsdt,
            fullContracts: rFull.normalizedContracts,
            probe25NotionalUsdt: rProbe25.finalOrderNotionalUsdt,
            probe25Contracts: rProbe25.normalizedContracts,
            probe25MarginUsdt: rProbe25.finalRequiredMarginUsdt,
            probe20NotionalUsdt: rProbe20.finalOrderNotionalUsdt,
            probe20Contracts: rProbe20.normalizedContracts,
            defectHistoricalContracts: 0.03,
            defectHistoricalNotionalUsdt: defectNotional,
            legacyAbsoluteProbeCapApplied: false,
            verdict: "REGRESSION_PASSED"
        }));
    }

    // CASE V — Hard Invariants: (actualFinalNotional == contracts * ctVal * price) && (actualFinalNotional <= emergencyCap) && BTC/ETH Symmetry
    {
        // 1. BTC production test (ctVal: 0.01, lotSz: 0.01, minSz: 0.01)
        const PROD_BTC_INSTRUMENT = { lotSz: 0.01, minSz: 0.01, ctVal: 0.01, ctValCcy: "BTC" };
        const btcPrice = 68000;
        const btcStop = 67320; // 1% stop
        const rBtc = entrySizing({
            symbol: "BTCUSDT",
            equity: 200,
            entryPrice: btcPrice,
            stopPrice: btcStop,
            leverage: 10,
            grade: "A",
            instrumentSizing: PROD_BTC_INSTRUMENT,
            entryProbeSizeMultiplier: 0.25,
            entryProbeSizingSource: "CONTINUATION_MICRO_PROBE"
        });
        // 200 equity * 0.01 risk / 0.01 stop = 200 riskBased -> 25% probe = 50 USDT preLot -> 50 / (68000 * 0.01) = 50 / 680 = 0.07352... -> floor 0.07 contracts
        assertClose(rBtc.normalizedContracts ?? 0, 0.07, 0.001, "CASE V BTC normalizedContracts = 0.07");
        const expectedBtcNotional = 0.07 * PROD_BTC_INSTRUMENT.ctVal * btcPrice;
        assertClose(rBtc.finalOrderNotionalUsdt, expectedBtcNotional, 1e-6, "CASE V BTC invariant: notional == contracts * ctVal * price");
        assertClose(rBtc.finalRequiredMarginUsdt, rBtc.finalOrderNotionalUsdt / 10, 1e-6, "CASE V BTC margin invariant");

        // 2. ETH Post-normalization Emergency 500 Cap Invariant
        const PROD_ETH_INSTRUMENT = { lotSz: 0.01, minSz: 0.01, ctVal: 0.1, ctValCcy: "ETH" };
        const rEthEmergency = evaluateEquityAdaptiveSizing({
            symbol: "ETHUSDT",
            side: "long",
            orderKind: "ENTRY",
            accountEquityUsdt: 600, // Would produce 1200 USDT without cap
            availableBalanceUsdt: 600,
            entryReferencePrice: 2500,
            effectiveStopPrice: 2475,
            appliedLeverage: 10,
            entryQualityGrade: "A",
            existingSymbolNotionalUsdt: 0,
            existingAccountNotionalUsdt: 0,
            emergencyAbsoluteCapUsdt: 500,
            roundTripFeeRate: 0,
            lastPrice: 2500,
            instrumentSizing: PROD_ETH_INSTRUMENT,
            entryProbeSizeMultiplier: null
        });
        // Emergency cap 500 binds -> preLot 500 -> denom 250 -> 500 / 250 = 2.00 contracts -> actual 500 USDT
        assertTrue(rEthEmergency.finalOrderNotionalUsdt <= 500 + 1e-6, "CASE V ETH emergency 500 post-normalization cap respected");
        assertClose(rEthEmergency.normalizedContracts ?? 0, 2.00, 0.001, "CASE V ETH emergency 500 normalizedContracts = 2.00");
        assertClose(rEthEmergency.finalOrderNotionalUsdt, 2.00 * 0.1 * 2500, 1e-6, "CASE V ETH invariant: notional == contracts * ctVal * price");
        assertClose(rEthEmergency.finalRequiredMarginUsdt, rEthEmergency.finalOrderNotionalUsdt / 10, 1e-6, "CASE V ETH margin invariant");
    }

    console.info(JSON.stringify({
        event: "V2_EQUITY_ADAPTIVE_SIZING_CASES_PASS",
        cases: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V"],
        risk_per_trade_pct: RISK_PER_TRADE_PCT,
        initial_cap_multiple: MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE,
        symbol_cap_multiple: MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
        account_cap_multiple: MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE,
        adverse_addon_cap_multiple: MAX_ADVERSE_ADDON_EQUITY_MULTIPLE
    }));
}

runCases();
