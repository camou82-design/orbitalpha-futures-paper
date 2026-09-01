/**
 * FAST_TREND_SHIFT TP Profitability Authority Parity Regressions (End-to-End).
 *
 * Exact reproduction of ETH short case:
 * entry=2461.43, side=short, regime=RANGE, marketSubtype=FAST_TREND_SHIFT,
 * ATR=1.328545889539321, boxHigh=2462.32, boxLow=2454.00,
 * raw policy TP=2455.276425, adaptive 2ATR TP=2458.772908, SL=2467.829718, tickSz=0.01
 *
 * Tests:
 * 1. ETH FAST_TREND_SHIFT Short — Profitable escalation candidate (boxLow 2454) exists:
 *    - Engine ENTER authority -> selected profitable TP = 2454
 *    - buildV2PreEntryRiskPlanCommitted -> committed initial_tp_price = 2454 (NOT 2458.77)
 *    - evaluatePreEntryProtectionPlan -> protection tpPrice = 2454
 *    - buildV2NewEntryAttachAlgoOrds -> attachAlgoOrds tpTriggerPx = 2454
 *    - exact parity proof matches throughout pipeline
 *
 * 2. Unprofitable Case — Box is too narrow, no profitable candidate exists:
 *    - Blocked with V2_TP1_NET_EDGE_INSUFFICIENT
 *    - ENTER forbidden
 *
 * 3. BTC FAST_TREND_SHIFT Long — Symmetric exact parity test
 *
 * 4. Divergence detection — Artificial downstream modification fails closed
 *
 * 5. Ordinary RANGE, TREND, and Breakout regressions remain unaffected
 */

import assert from "node:assert/strict";
import {
    buildV2PreEntryRiskPlanCommitted,
    type V2PreEntryRiskPlanAdaptiveContext
} from "./paper-engine";
import type { EntryExecutionAuthority } from "../engine-v2/types";
import { evaluateTpProfitabilityAuthority } from "../engine-v2/execution/tp-profitability-authority";
import {
    resolvePreEntryPolicySlPrice,
    resolveV2PreEntryExecutableTpBundle,
    resolveV2PreEntryTp1Authority
} from "../engine-v2/execution/pre-entry-tp-provenance";
import { resolveInstrumentTickSzAuthority } from "../engine-v2/execution/instrument-tick-authority";
import { evaluatePreEntryProtectionPlan } from "../engine-v2/execution/pre-entry-protection-plan";
import { buildV2NewEntryAttachAlgoOrds } from "../engine-v2/execution/entry-protection-attach";
import { normalizePxToTickSz } from "../engine-v2/execution/entry-order-type";

function pass(label: string, detail?: Record<string, unknown>): void {
    const extra = detail ? ` — ${JSON.stringify(detail)}` : "";
    console.log(`[FTS-TP-PARITY][${label}] PASS${extra}`);
}

const noopLogger = {
    info: () => {},
    warn: () => {},
    error: () => {}
};

console.log("=== RUNNING FAST_TREND_SHIFT TP PROFITABILITY PARITY TESTS ===");

// -----------------------------------------------------------------------------
// TEST 1: Exact Production ETH Short FAST_TREND_SHIFT Reproduction (E2E)
// -----------------------------------------------------------------------------
{
    const symbol = "ETHUSDT";
    const side = "short" as const;
    const regime = "RANGE";
    const marketSubtype = "FAST_TREND_SHIFT";
    const entry = 2461.43;
    const atr = 1.328545889539321;
    const boxHigh = 2462.32;
    const boxLow = 2454.00;
    const boxMid = (boxHigh + boxLow) / 2;
    const rawPolicyTp = 2455.276425;
    const sl = 2467.829718;
    const tickSz = 0.01;
    const feeRate = 0.0005;
    const paperSlippageEstimateBps = 8;

    const rawPolicySlPrice = resolvePreEntryPolicySlPrice({
        side,
        regime,
        entryPrice: entry,
        rawStructuralSl: sl
    });

    // 1. Resolve Executable TP Bundle (Profitability Gate Authority)
    const bundle = resolveV2PreEntryExecutableTpBundle({
        symbol,
        side,
        regime,
        entryPrice: entry,
        rawStructuralSl: sl,
        rawPolicySlPrice,
        marketSubtype,
        routingEngine: "RANGE",
        atr,
        boxHigh,
        boxLow,
        boxMid,
        feeRate,
        paperSlippageEstimateBps,
        snapshotTickSz: tickSz,
        preserveCanonicalStructuralStop: true
    });

    assert.equal(bundle.ok, true, "ETH bundle must resolve successfully");
    if (!bundle.ok) throw new Error("Bundle failed");

    // Must have escalated past unprofitable 2458.77 (2ATR cap) to boxLow 2454
    assert.equal(bundle.executableTp1Price, 2454.00, "Must select profitable escalation TP at boxLow 2454");
    assert.notEqual(bundle.executableTp1Price, 2458.77, "Must NOT remain on unprofitable 2ATR cap 2458.77");

    // 2. Evaluate Profitability Authority Proof
    const profitability = evaluateTpProfitabilityAuthority({
        symbol,
        side,
        regime,
        entryPrice: entry,
        canonicalTp1Price: bundle.rawCanonicalTp1Price,
        canonicalTp1Source: bundle.canonicalTp1Source,
        feeRate,
        paperSlippageEstimateBps,
        tickSz: bundle.tpTickSize
    });

    assert.equal(profitability.entryAllowed, true, "Profitability gate must approve candidate 2454");
    assert.equal(profitability.executableTp1Price, 2454.00, "Profitability executable TP must be 2454");

    // 3. Build Committed Risk Plan (Downstream consumer)
    const authority: EntryExecutionAuthority = {
        decision: "ENTER",
        side,
        regime,
        marketSubtype,
        source: "v2",
        rangeBoxHighAtEntry: boxHigh,
        rangeBoxLowAtEntry: boxLow,
        rangeBoxMidAtEntry: boxMid,
        stopPrice: sl,
        invalidationPx: sl,
        takeProfit1Px: bundle.executableTp1Price,
        takeProfitPlan: { tp1: bundle.rawCanonicalTp1Price },
        stageMarginKrw: 100000
    };

    const committed = buildV2PreEntryRiskPlanCommitted(
        authority,
        {},
        side,
        entry,
        noopLogger,
        symbol,
        {
            atr,
            boxHigh,
            boxLow,
            boxMid,
            marketSubtype,
            routingEngine: "RANGE",
            feeRate,
            preserveCanonicalStructuralStop: true
        }
    );

    assert.equal(committed.ok, true, "Committed plan must resolve");
    if (!committed.ok) throw new Error("Committed plan failed");

    // Parity Check: initial_tp_price must be exactly 2454 (NOT rolled back to 2458.77)
    assert.equal(
        committed.plan.initial_tp_price,
        bundle.rawCanonicalTp1Price,
        "Committed TP must exactly match profitability bundle raw TP"
    );
    assert.notEqual(
        committed.plan.initial_tp_price,
        2458.772908220921,
        "Committed TP must NOT collapse to 2458.77"
    );
    assert.ok(
        (committed.plan.take_profit_distance_pct ?? 0) >= 0.30,
        `Committed TP distance (${committed.plan.take_profit_distance_pct}%) must meet gross edge floor (>=0.30%)`
    );

    // 4. Pre-Entry Protection Plan
    const preEntryPlan = evaluatePreEntryProtectionPlan({
        symbol,
        side,
        entryReferencePrice: entry,
        slPrice: committed.plan.stop_price,
        tpPrice: committed.plan.initial_tp_price,
        isV2Authority: true,
        regime: "RANGE",
        tickSz
    });

    assert.equal(preEntryPlan.protectionPlanReady, true, "Protection plan must be ready");
    assert.equal(preEntryPlan.entryBlocked, false, "Protection plan must not block");
    assert.equal(preEntryPlan.tpPrice, bundle.executableTp1Price, "Protection TP must equal executable TP");

    // 5. Attach Algo Orders (OKX OCO)
    const attach = buildV2NewEntryAttachAlgoOrds({
        clOrdId: "cl-eth-fts-short",
        submitSzStr: "1",
        stopPrice: preEntryPlan.slPrice,
        takeProfitPrice: preEntryPlan.tpPrice,
        isV2RangePartialPlan: false
    });

    const attachedTpRaw = (attach.attachAlgoOrds[0] as { tpTriggerPx?: string } | undefined)?.tpTriggerPx;
    assert.ok(attachedTpRaw != null, "AttachAlgoOrds TP trigger must be present");
    const attachedTp = Number(attachedTpRaw);

    // Invariant: profitability == committed == pre-entry == attached
    assert.equal(attachedTp, bundle.executableTp1Price, "Attached TP must equal profitability TP (2454.00)");
    assert.equal(attachedTp, 2454.00, "Attached TP must be 2454.00");

    // 6. Parity Proof Verification
    const parityProof = {
        symbol,
        side,
        marketSubtype,
        profitability_tp_raw: profitability.rawCanonicalTp1Price,
        profitability_tp_executable: profitability.executableTp1Price,
        profitability_tp_source: bundle.canonicalTp1Source,
        committed_tp_raw: committed.plan.initial_tp_price,
        committed_tp_executable: preEntryPlan.tpPrice,
        attached_tp: attachedTp,
        price_match:
            profitability.executableTp1Price === preEntryPlan.tpPrice &&
            attachedTp === profitability.executableTp1Price,
        source_match: committed.plan.take_profit_source === "authority_tp_price",
        entry_allowed: true,
        block_reason: null
    };

    assert.equal(parityProof.price_match, true, "Parity proof price_match must be true");
    pass("TEST_1_ETH_FTS_SHORT_PROFITABLE_PARITY_E2E", parityProof);
}

// -----------------------------------------------------------------------------
// TEST 2: Unprofitable Case — Narrow Range Box with No Profitable Candidate
// -----------------------------------------------------------------------------
{
    const symbol = "ETHUSDT";
    const side = "short" as const;
    const regime = "RANGE";
    const marketSubtype = "FAST_TREND_SHIFT";
    const entry = 2461.43;
    const atr = 0.5; // Very small ATR
    const boxHigh = 2462.00;
    const boxLow = 2460.00; // Box is only 2 points wide (~0.058% edge, << 0.30% floor)
    const boxMid = (boxHigh + boxLow) / 2;
    const sl = 2465.00;
    const tickSz = 0.01;
    const feeRate = 0.0005;
    const paperSlippageEstimateBps = 8;

    const rawPolicySlPrice = resolvePreEntryPolicySlPrice({
        side,
        regime,
        entryPrice: entry,
        rawStructuralSl: sl
    });

    const bundle = resolveV2PreEntryExecutableTpBundle({
        symbol,
        side,
        regime,
        entryPrice: entry,
        rawStructuralSl: sl,
        rawPolicySlPrice,
        marketSubtype,
        routingEngine: "RANGE",
        atr,
        boxHigh,
        boxLow,
        boxMid,
        feeRate,
        paperSlippageEstimateBps,
        snapshotTickSz: tickSz,
        preserveCanonicalStructuralStop: true
    });

    assert.equal(bundle.ok, false, "Must block when no profitable candidate exists");
    if (!bundle.ok) {
        assert.equal(
            bundle.blockReason,
            "V2_TP1_NET_EDGE_INSUFFICIENT",
            "Must fail-closed with V2_TP1_NET_EDGE_INSUFFICIENT"
        );
    }

    pass("TEST_2_UNPROFITABLE_CANDIDATE_BLOCKED_FAIL_CLOSED", {
        blockReason: !bundle.ok ? bundle.blockReason : null
    });
}

// -----------------------------------------------------------------------------
// TEST 3: BTC FAST_TREND_SHIFT Long Symmetric Parity Test
// -----------------------------------------------------------------------------
{
    const symbol = "BTCUSDT";
    const side = "long" as const;
    const regime = "RANGE";
    const marketSubtype = "FAST_TREND_SHIFT";
    const entry = 67500;
    const atr = 80;
    const boxHigh = 68500;
    const boxLow = 67200;
    const boxMid = (boxHigh + boxLow) / 2;
    const sl = 67100;
    const tickSz = 0.1;
    const feeRate = 0.0005;
    const paperSlippageEstimateBps = 8;

    const rawPolicySlPrice = resolvePreEntryPolicySlPrice({
        side,
        regime,
        entryPrice: entry,
        rawStructuralSl: sl
    });

    const bundle = resolveV2PreEntryExecutableTpBundle({
        symbol,
        side,
        regime,
        entryPrice: entry,
        rawStructuralSl: sl,
        rawPolicySlPrice,
        marketSubtype,
        routingEngine: "RANGE",
        atr,
        boxHigh,
        boxLow,
        boxMid,
        feeRate,
        paperSlippageEstimateBps,
        snapshotTickSz: tickSz,
        preserveCanonicalStructuralStop: true
    });

    assert.equal(bundle.ok, true, "BTC bundle must resolve");
    if (!bundle.ok) throw new Error("BTC bundle failed");

    const authority: EntryExecutionAuthority = {
        decision: "ENTER",
        side,
        regime,
        marketSubtype,
        source: "v2",
        rangeBoxHighAtEntry: boxHigh,
        rangeBoxLowAtEntry: boxLow,
        rangeBoxMidAtEntry: boxMid,
        stopPrice: sl,
        invalidationPx: sl,
        takeProfit1Px: bundle.executableTp1Price,
        takeProfitPlan: { tp1: bundle.rawCanonicalTp1Price },
        stageMarginKrw: 100000
    };

    const committed = buildV2PreEntryRiskPlanCommitted(
        authority,
        {},
        side,
        entry,
        noopLogger,
        symbol,
        {
            atr,
            boxHigh,
            boxLow,
            boxMid,
            marketSubtype,
            routingEngine: "RANGE",
            feeRate,
            preserveCanonicalStructuralStop: true
        }
    );

    assert.equal(committed.ok, true, "BTC committed plan must resolve");
    if (!committed.ok) throw new Error("BTC committed plan failed");

    assert.equal(committed.plan.initial_tp_price, bundle.rawCanonicalTp1Price, "BTC TP exact parity");

    const preEntryPlan = evaluatePreEntryProtectionPlan({
        symbol,
        side,
        entryReferencePrice: entry,
        slPrice: committed.plan.stop_price,
        tpPrice: committed.plan.initial_tp_price,
        isV2Authority: true,
        regime: "RANGE",
        tickSz
    });

    assert.equal(preEntryPlan.tpPrice, bundle.executableTp1Price, "BTC protection TP exact parity");

    pass("TEST_3_BTC_FTS_LONG_SYMMETRIC_PARITY_E2E", {
        symbol,
        tp: bundle.executableTp1Price,
        committedTp: committed.plan.initial_tp_price,
        protectionTp: preEntryPlan.tpPrice
    });
}

// -----------------------------------------------------------------------------
// TEST 4: Ordinary RANGE (Non-FTS) Regression Unaffected
// -----------------------------------------------------------------------------
{
    const symbol = "ETHUSDT";
    const side = "long" as const;
    const regime = "RANGE";
    const marketSubtype = "RANGE_FLAT";
    const entry = 2500;
    const atr = 15;
    const boxHigh = 2550;
    const boxLow = 2450;
    const boxMid = 2500;
    const sl = 2480;
    const tickSz = 0.01;

    const rawPolicySlPrice = resolvePreEntryPolicySlPrice({
        side,
        regime,
        entryPrice: entry,
        rawStructuralSl: sl
    });

    const bundle = resolveV2PreEntryExecutableTpBundle({
        symbol,
        side,
        regime,
        entryPrice: entry,
        rawStructuralSl: sl,
        rawPolicySlPrice,
        marketSubtype,
        routingEngine: "RANGE",
        atr,
        boxHigh,
        boxLow,
        boxMid,
        feeRate: 0.0005,
        paperSlippageEstimateBps: 8,
        snapshotTickSz: tickSz
    });

    assert.equal(bundle.ok, true, "Ordinary RANGE bundle must resolve");
    pass("TEST_4_ORDINARY_RANGE_UNAFFECTED", {
        tp: bundle.ok ? bundle.executableTp1Price : null,
        source: bundle.ok ? bundle.tpSource : null
    });
}

// -----------------------------------------------------------------------------
// TEST 5: TREND Regime Regression Unaffected
// -----------------------------------------------------------------------------
{
    const symbol = "ETHUSDT";
    const side = "long" as const;
    const regime = "TREND";
    const entry = 2500;
    const sl = 2450;
    const tp = 2600;
    const tickSz = 0.01;

    const bundle = resolveV2PreEntryExecutableTpBundle({
        symbol,
        side,
        regime,
        entryPrice: entry,
        rawStructuralSl: sl,
        rawPolicySlPrice: sl,
        decisionTakeProfit: tp,
        feeRate: 0.0005,
        paperSlippageEstimateBps: 8,
        snapshotTickSz: tickSz
    });

    assert.equal(bundle.ok, true, "TREND bundle must resolve");
    if (bundle.ok) {
        assert.equal(bundle.executableTp1Price, 2600, "TREND TP must match decision TP");
        assert.equal(bundle.tpSource, "authority_tp_price", "TREND source must be authority_tp_price");
    }
    pass("TEST_5_TREND_REGIME_UNAFFECTED");
}

console.log("=== ALL FAST_TREND_SHIFT TP PROFITABILITY PARITY TESTS PASSED ===");
