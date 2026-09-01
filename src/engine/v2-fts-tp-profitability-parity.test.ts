/**
 * FAST_TREND_SHIFT TP Profitability Authority Parity Regressions (End-to-End).
 *
 * Production Parity Helper: evaluatePreEntryTpParity (pre-entry-tp-provenance.ts)
 *
 * Required Test Coverage:
 * A. ETH FTS short 2454 exact parity -> PASS
 * B. Profitability authority missing in approved/escalation context -> BLOCK (V2_TP_PROFITABILITY_AUTHORITY_MISSING)
 * C. Profitability TP != committed TP -> BLOCK (V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE)
 * D. Committed TP != attached TP -> BLOCK (V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE)
 * E. Canonical provenance missing/invalid in approved context -> BLOCK (V2_TP_PROFITABILITY_PROVENANCE_INVALID)
 * F. Ordinary RANGE unaffected (approval not required -> PASS)
 * G. TREND unaffected (approval not required -> PASS)
 * H. BTC FTS long symmetric PASS
 * I. Dedicated authority vs generic transport divergence -> BLOCK (V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE)
 * J. FTS escalation + profitabilityTpApproved marker lost + provenance none -> BLOCK (V2_TP_PROFITABILITY_PROVENANCE_INVALID)
 * K. Approval expected + committedTpSource="none" -> BLOCK (V2_TP_PROFITABILITY_PROVENANCE_INVALID)
 */

import assert from "node:assert/strict";
import {
    buildV2PreEntryRiskPlanCommitted
} from "./paper-engine";
import type { EntryExecutionAuthority } from "../engine-v2/types";
import { evaluateTpProfitabilityAuthority } from "../engine-v2/execution/tp-profitability-authority";
import {
    resolvePreEntryPolicySlPrice,
    resolveV2PreEntryExecutableTpBundle,
    evaluatePreEntryTpParity
} from "../engine-v2/execution/pre-entry-tp-provenance";
import { evaluatePreEntryProtectionPlan } from "../engine-v2/execution/pre-entry-protection-plan";
import { buildV2NewEntryAttachAlgoOrds } from "../engine-v2/execution/entry-protection-attach";

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
// TEST A: Exact Production ETH Short FAST_TREND_SHIFT Reproduction (E2E Exact Parity)
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
        takeProfitPlan: { tp1: bundle.rawCanonicalTp1Price, executableTp1: bundle.executableTp1Price },
        profitabilityTpApproved: true,
        profitabilityCanonicalTpSource: bundle.canonicalTp1Source,
        profitabilityTpSource: bundle.tpSource,
        profitabilityExecutableTp1Price: bundle.executableTp1Price,
        profitabilityRawCanonicalTp1Price: bundle.rawCanonicalTp1Price,
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

    // 6. Production Parity Helper Call (Using dedicated authority fields)
    const parityProof = evaluatePreEntryTpParity({
        symbol,
        side,
        regime,
        marketSubtype,
        tickSz,
        profitabilityTpApproved: authority.profitabilityTpApproved,
        profitabilityCanonicalTpSource: authority.profitabilityCanonicalTpSource,
        profitabilityTpSource: authority.profitabilityTpSource,
        profitabilityTpRaw: authority.profitabilityRawCanonicalTp1Price,
        profitabilityTpExecutable: authority.profitabilityExecutableTp1Price,
        committedTpRaw: committed.plan.initial_tp_price,
        committedTpExecutable: preEntryPlan.tpPrice,
        committedTpSource: committed.plan.take_profit_source,
        attachedTp
    });

    assert.equal(parityProof.entry_allowed, true, "Production parity check must pass");
    assert.equal(parityProof.price_match, true, "Price match must be true");
    assert.equal(parityProof.source_match, true, "Source match must be true");
    assert.equal(parityProof.block_reason, null, "Block reason must be null");

    pass("TEST_A_ETH_FTS_SHORT_EXACT_PARITY_E2E", {
        symbol: parityProof.symbol,
        side: parityProof.side,
        marketSubtype: parityProof.marketSubtype,
        profitability_canonical_tp_source: parityProof.profitability_canonical_tp_source,
        profitability_tp_source: parityProof.profitability_tp_source,
        committed_tp_source: parityProof.committed_tp_source,
        profitability_tp_executable: parityProof.profitability_tp_executable,
        committed_tp_executable: parityProof.committed_tp_executable,
        attached_tp: parityProof.attached_tp,
        entry_allowed: parityProof.entry_allowed
    });
}

// -----------------------------------------------------------------------------
// TEST B: Missing Profitability Authority in Approved Context -> Fail-Closed BLOCK
// -----------------------------------------------------------------------------
{
    const parityProof = evaluatePreEntryTpParity({
        symbol: "ETHUSDT",
        side: "short",
        regime: "RANGE",
        marketSubtype: "FAST_TREND_SHIFT",
        tickSz: 0.01,
        profitabilityTpApproved: true,
        profitabilityCanonicalTpSource: "adaptive_range_box_target",
        profitabilityTpSource: "adaptive_range_box_target",
        profitabilityTpRaw: null, // Dedicated authority missing!
        profitabilityTpExecutable: null, // Dedicated authority missing!
        committedTpRaw: 2454,
        committedTpExecutable: 2454,
        committedTpSource: "authority_tp_price",
        attachedTp: 2454
    });

    assert.equal(parityProof.entry_allowed, false, "Must block when profitability authority is missing");
    assert.equal(
        parityProof.block_reason,
        "V2_TP_PROFITABILITY_AUTHORITY_MISSING",
        "Must fail-closed with V2_TP_PROFITABILITY_AUTHORITY_MISSING"
    );

    pass("TEST_B_MISSING_PROFITABILITY_AUTHORITY_BLOCKS", {
        block_reason: parityProof.block_reason
    });
}

// -----------------------------------------------------------------------------
// TEST C: Profitability TP != Committed TP -> Fail-Closed BLOCK
// -----------------------------------------------------------------------------
{
    const parityProof = evaluatePreEntryTpParity({
        symbol: "ETHUSDT",
        side: "short",
        regime: "RANGE",
        marketSubtype: "FAST_TREND_SHIFT",
        tickSz: 0.01,
        profitabilityTpApproved: true,
        profitabilityCanonicalTpSource: "adaptive_range_box_target",
        profitabilityTpSource: "adaptive_range_box_target",
        profitabilityTpRaw: 2454,
        profitabilityTpExecutable: 2454,
        committedTpRaw: 2458.77, // Diverged (collapsed to 2ATR cap)!
        committedTpExecutable: 2458.77,
        committedTpSource: "adaptive_range_atr_cap",
        attachedTp: 2458.77
    });

    assert.equal(parityProof.entry_allowed, false, "Must block when profitability TP != committed TP");
    assert.equal(
        parityProof.block_reason,
        "V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE",
        "Must fail-closed with V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE"
    );

    pass("TEST_C_PROFITABILITY_TP_COMMITTED_TP_DIVERGENCE_BLOCKS", {
        block_reason: parityProof.block_reason
    });
}

// -----------------------------------------------------------------------------
// TEST D: Committed TP != Attached TP -> Fail-Closed BLOCK
// -----------------------------------------------------------------------------
{
    const parityProof = evaluatePreEntryTpParity({
        symbol: "ETHUSDT",
        side: "short",
        regime: "RANGE",
        marketSubtype: "FAST_TREND_SHIFT",
        tickSz: 0.01,
        profitabilityTpApproved: true,
        profitabilityCanonicalTpSource: "adaptive_range_box_target",
        profitabilityTpSource: "adaptive_range_box_target",
        profitabilityTpRaw: 2454,
        profitabilityTpExecutable: 2454,
        committedTpRaw: 2454,
        committedTpExecutable: 2454,
        committedTpSource: "authority_tp_price",
        attachedTp: 2450 // Attached order modified downstream!
    });

    assert.equal(parityProof.entry_allowed, false, "Must block when committed TP != attached TP");
    assert.equal(
        parityProof.block_reason,
        "V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE",
        "Must fail-closed with V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE"
    );

    pass("TEST_D_COMMITTED_TP_ATTACHED_TP_DIVERGENCE_BLOCKS", {
        block_reason: parityProof.block_reason
    });
}

// -----------------------------------------------------------------------------
// TEST E: Canonical Provenance Missing/Invalid in Approved Context -> Fail-Closed BLOCK
// -----------------------------------------------------------------------------
{
    const parityProof = evaluatePreEntryTpParity({
        symbol: "ETHUSDT",
        side: "short",
        regime: "RANGE",
        marketSubtype: "FAST_TREND_SHIFT",
        tickSz: 0.01,
        profitabilityTpApproved: true,
        profitabilityCanonicalTpSource: "none", // Provenance lost!
        profitabilityTpSource: "",
        profitabilityTpRaw: 2454,
        profitabilityTpExecutable: 2454,
        committedTpRaw: 2454,
        committedTpExecutable: 2454,
        committedTpSource: "authority_tp_price",
        attachedTp: 2454
    });

    assert.equal(parityProof.entry_allowed, false, "Must block when canonical provenance is missing");
    assert.equal(
        parityProof.block_reason,
        "V2_TP_PROFITABILITY_PROVENANCE_INVALID",
        "Must fail-closed with V2_TP_PROFITABILITY_PROVENANCE_INVALID"
    );

    pass("TEST_E_CANONICAL_PROVENANCE_INVALID_BLOCKS", {
        block_reason: parityProof.block_reason
    });
}

// -----------------------------------------------------------------------------
// TEST F: Ordinary RANGE (Approval Not Required) -> Unaffected PASS
// -----------------------------------------------------------------------------
{
    const parityProof = evaluatePreEntryTpParity({
        symbol: "ETHUSDT",
        side: "long",
        regime: "RANGE",
        marketSubtype: "RANGE_FLAT",
        tickSz: 0.01,
        profitabilityTpApproved: false, // Standard low-vol range
        profitabilityCanonicalTpSource: "none",
        profitabilityTpSource: "none",
        profitabilityTpRaw: null,
        profitabilityTpExecutable: null,
        committedTpRaw: 2505.25,
        committedTpExecutable: 2505.25,
        committedTpSource: "adaptive_range_min_profit",
        attachedTp: 2505.25
    });

    assert.equal(parityProof.entry_allowed, true, "Ordinary RANGE must pass without approval requirement");
    assert.equal(parityProof.block_reason, null);

    pass("TEST_F_ORDINARY_RANGE_UNAFFECTED_PASS", {
        entry_allowed: parityProof.entry_allowed
    });
}

// -----------------------------------------------------------------------------
// TEST G: TREND Regime (Approval Not Required) -> Unaffected PASS
// -----------------------------------------------------------------------------
{
    const parityProof = evaluatePreEntryTpParity({
        symbol: "BTCUSDT",
        side: "long",
        regime: "TREND",
        marketSubtype: "TREND_MOMENTUM",
        tickSz: 0.1,
        profitabilityTpApproved: false,
        profitabilityCanonicalTpSource: "none",
        profitabilityTpSource: "none",
        profitabilityTpRaw: null,
        profitabilityTpExecutable: null,
        committedTpRaw: 70000,
        committedTpExecutable: 70000,
        committedTpSource: "authority_tp_price",
        attachedTp: 70000
    });

    assert.equal(parityProof.entry_allowed, true, "TREND regime must pass");
    assert.equal(parityProof.block_reason, null);

    pass("TEST_G_TREND_REGIME_UNAFFECTED_PASS", {
        entry_allowed: parityProof.entry_allowed
    });
}

// -----------------------------------------------------------------------------
// TEST H: BTC FAST_TREND_SHIFT Long Symmetric Parity Test
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
        takeProfitPlan: { tp1: bundle.rawCanonicalTp1Price, executableTp1: bundle.executableTp1Price },
        profitabilityTpApproved: true,
        profitabilityCanonicalTpSource: bundle.canonicalTp1Source,
        profitabilityTpSource: bundle.tpSource,
        profitabilityExecutableTp1Price: bundle.executableTp1Price,
        profitabilityRawCanonicalTp1Price: bundle.rawCanonicalTp1Price,
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

    const attach = buildV2NewEntryAttachAlgoOrds({
        clOrdId: "cl-btc-fts-long",
        submitSzStr: "1",
        stopPrice: preEntryPlan.slPrice,
        takeProfitPrice: preEntryPlan.tpPrice,
        isV2RangePartialPlan: false
    });

    const attachedTp = Number((attach.attachAlgoOrds[0] as { tpTriggerPx?: string })?.tpTriggerPx);

    const parityProof = evaluatePreEntryTpParity({
        symbol,
        side,
        regime,
        marketSubtype,
        tickSz,
        profitabilityTpApproved: authority.profitabilityTpApproved,
        profitabilityCanonicalTpSource: authority.profitabilityCanonicalTpSource,
        profitabilityTpSource: authority.profitabilityTpSource,
        profitabilityTpRaw: authority.profitabilityRawCanonicalTp1Price,
        profitabilityTpExecutable: authority.profitabilityExecutableTp1Price,
        committedTpRaw: committed.plan.initial_tp_price,
        committedTpExecutable: preEntryPlan.tpPrice,
        committedTpSource: committed.plan.take_profit_source,
        attachedTp
    });

    assert.equal(parityProof.entry_allowed, true, "BTC symmetric test must pass");
    assert.equal(parityProof.price_match, true);
    assert.equal(parityProof.block_reason, null);

    pass("TEST_H_BTC_FTS_LONG_SYMMETRIC_PASS", {
        symbol,
        profitability_tp_executable: parityProof.profitability_tp_executable,
        committed_tp_executable: parityProof.committed_tp_executable,
        attached_tp: parityProof.attached_tp
    });
}

// -----------------------------------------------------------------------------
// TEST I: Dedicated Authority vs Generic Transport Divergence -> Fail-Closed BLOCK
// (Ensures parity references dedicated profitability authority, NOT generic takeProfit1Px)
// -----------------------------------------------------------------------------
{
    const parityProof = evaluatePreEntryTpParity({
        symbol: "ETHUSDT",
        side: "short",
        regime: "RANGE",
        marketSubtype: "FAST_TREND_SHIFT",
        tickSz: 0.01,
        profitabilityTpApproved: true,
        profitabilityCanonicalTpSource: "adaptive_range_box_target",
        profitabilityTpSource: "adaptive_range_box_target",
        // Dedicated profitability authority is 2454
        profitabilityTpRaw: 2454,
        profitabilityTpExecutable: 2454,
        // Downstream committed/transport erroneously rolled back to 2458.77
        committedTpRaw: 2458.77,
        committedTpExecutable: 2458.77,
        committedTpSource: "adaptive_range_atr_cap",
        attachedTp: 2458.77
    });

    assert.equal(parityProof.entry_allowed, false, "Must block when dedicated authority diverges from committed TP");
    assert.equal(
        parityProof.block_reason,
        "V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE",
        "Must fail-closed with V2_TP_PROFITABILITY_AUTHORITY_DIVERGENCE"
    );

    pass("TEST_I_DEDICATED_AUTHORITY_VS_GENERIC_TRANSPORT_DIVERGENCE_BLOCKS", {
        profitability_tp_executable: parityProof.profitability_tp_executable,
        committed_tp_executable: parityProof.committed_tp_executable,
        block_reason: parityProof.block_reason
    });
}

// -----------------------------------------------------------------------------
// TEST J: FTS Escalation + profitabilityTpApproved Marker Lost + Provenance None -> Fail-Closed BLOCK
// -----------------------------------------------------------------------------
{
    const parityProof = evaluatePreEntryTpParity({
        symbol: "ETHUSDT",
        side: "short",
        regime: "RANGE",
        marketSubtype: "FAST_TREND_SHIFT",
        tickSz: 0.01,
        profitabilityTpApproved: false, // Marker lost during propagation!
        profitabilityCanonicalTpSource: "none", // Provenance lost!
        profitabilityTpSource: "none",
        profitabilityTpRaw: 2454,
        profitabilityTpExecutable: 2454,
        committedTpRaw: 2454,
        committedTpExecutable: 2454,
        committedTpSource: "authority_tp_price",
        attachedTp: 2454
    });

    assert.equal(parityProof.entry_allowed, false, "Must block in escalation context when provenance is none");
    assert.equal(
        parityProof.block_reason,
        "V2_TP_PROFITABILITY_PROVENANCE_INVALID",
        "Must fail-closed with V2_TP_PROFITABILITY_PROVENANCE_INVALID"
    );

    pass("TEST_J_FTS_ESCALATION_MARKER_LOST_PROVENANCE_NONE_BLOCKS", {
        block_reason: parityProof.block_reason
    });
}

// -----------------------------------------------------------------------------
// TEST K: Approval Expected + committedTpSource="none" -> Fail-Closed BLOCK
// -----------------------------------------------------------------------------
{
    const parityProof = evaluatePreEntryTpParity({
        symbol: "ETHUSDT",
        side: "short",
        regime: "RANGE",
        marketSubtype: "FAST_TREND_SHIFT",
        tickSz: 0.01,
        profitabilityTpApproved: true,
        profitabilityCanonicalTpSource: "adaptive_range_box_target",
        profitabilityTpSource: "adaptive_range_box_target",
        profitabilityTpRaw: 2454,
        profitabilityTpExecutable: 2454,
        committedTpRaw: 2454,
        committedTpExecutable: 2454,
        committedTpSource: "none", // Committed TP source is none/unknown!
        attachedTp: 2454
    });

    assert.equal(parityProof.entry_allowed, false, "Must block when committedTpSource is none");
    assert.equal(
        parityProof.block_reason,
        "V2_TP_PROFITABILITY_PROVENANCE_INVALID",
        "Must fail-closed with V2_TP_PROFITABILITY_PROVENANCE_INVALID"
    );

    pass("TEST_K_APPROVAL_EXPECTED_COMMITTED_SOURCE_NONE_BLOCKS", {
        block_reason: parityProof.block_reason
    });
}

console.log("=== ALL 11 FAST_TREND_SHIFT TP PROFITABILITY PARITY TESTS PASSED ===");
