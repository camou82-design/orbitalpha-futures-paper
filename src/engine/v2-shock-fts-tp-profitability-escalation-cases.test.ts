/**
 * Shock / FTS promoted ENTER — TP profitability escalation (no gate bypass).
 */

import assert from "node:assert/strict";
import {
    enumeratePromotedRangeTp1Candidates,
    isShockOrFtsPromotedTpEscalationContext,
    resolveV2PreEntryExecutableTpBundle
} from "../engine-v2/execution/pre-entry-tp-provenance";
import { evaluateTpProfitabilityAuthority } from "../engine-v2/execution/tp-profitability-authority";

function pass(label: string, detail?: Record<string, unknown>): void {
    const extra = detail ? ` — ${JSON.stringify(detail)}` : "";
    console.log(`[SHOCK-FTS-TP-ESCALATION][${label}] PASS${extra}`);
}

// Context detection
{
    assert.equal(
        isShockOrFtsPromotedTpEscalationContext({
            marketSubtype: "WHIPSAW_SOFT_WATCH",
            promotionReason: "SHOCK_REACTION_lower_breakdown_continuation_short"
        }),
        true
    );
    assert.equal(
        isShockOrFtsPromotedTpEscalationContext({
            marketSubtype: "RANGE_FLAT",
            promotionReason: null
        }),
        false
    );
    pass("context detection");
}

// CASE A — narrow structural primary fails floor; ATR-cap candidate escalates => ALLOW
{
    const entry = 2500;
    const atr = 5;
    const boxHigh = 2580;
    const boxLow = 2460;
    const stop = 2490;
    const narrowPrimary = entry * 1.0016; // 0.16% < ~0.28% floor
    const bundle = resolveV2PreEntryExecutableTpBundle({
        side: "long",
        regime: "RANGE",
        entryPrice: entry,
        rawStructuralSl: stop,
        rawPolicySlPrice: stop,
        execMetaTakeProfitPlanTp1: narrowPrimary,
        marketSubtype: "WHIPSAW_SOFT_WATCH",
        promotionReason: "SHOCK_REACTION_lower_breakdown_continuation_short",
        routingEngine: "RANGE",
        atr,
        boxHigh,
        boxLow,
        feeRate: 0.0005,
        paperSlippageEstimateBps: 8,
        snapshotTickSz: 0.01,
        symbol: "ETHUSDT"
    });
    assert.equal(bundle.ok, true, "must escalate to profitable TP authority");
    if (!bundle.ok) throw new Error("bundle failed");
    assert.notEqual(bundle.tpSource, "authority_tp_price", "must not keep unprofitable primary");
    assert.ok(
        bundle.tpSource === "adaptive_range_atr_cap" ||
            bundle.tpSource === "adaptive_range_box_target",
        "must select next legitimate structural/ATR/box authority"
    );
    const primaryProf = evaluateTpProfitabilityAuthority({
        symbol: "ETHUSDT",
        side: "long",
        regime: "RANGE",
        entryPrice: entry,
        canonicalTp1Price: narrowPrimary,
        feeRate: 0.0005,
        paperSlippageEstimateBps: 8,
        tickSz: 0.01
    });
    assert.equal(primaryProf.entryAllowed, false, "primary must fail profitability floor");
    const prof = evaluateTpProfitabilityAuthority({
        symbol: "ETHUSDT",
        side: "long",
        regime: "RANGE",
        entryPrice: entry,
        canonicalTp1Price: bundle.rawCanonicalTp1Price,
        canonicalTp1Source: bundle.canonicalTp1Source,
        feeRate: 0.0005,
        paperSlippageEstimateBps: 8,
        tickSz: bundle.tpTickSize
    });
    assert.equal(prof.entryAllowed, true);
    pass("CASE-A escalate to legitimate TP", {
        primary: narrowPrimary,
        selected: bundle.rawCanonicalTp1Price,
        source: bundle.tpSource
    });
}

// CASE B — all allowed candidates below floor => block ENTER
{
    const entry = 2503.37;
    const atr = 1;
    const boxHigh = 2504;
    const boxLow = 2502;
    const stop = 2502.5;
    const bundle = resolveV2PreEntryExecutableTpBundle({
        side: "long",
        regime: "RANGE",
        entryPrice: entry,
        rawStructuralSl: stop,
        rawPolicySlPrice: stop,
        execMetaTakeProfitPlanTp1: entry * 1.0002,
        marketSubtype: "FAST_TREND_SHIFT",
        routingEngine: "RANGE",
        atr,
        boxHigh,
        boxLow,
        feeRate: 0.0005,
        paperSlippageEstimateBps: 8,
        snapshotTickSz: 0.01,
        symbol: "ETHUSDT"
    });
    assert.equal(bundle.ok, false);
    if (bundle.ok) throw new Error("expected block");
    assert.equal(bundle.blockReason, "V2_TP1_NET_EDGE_INSUFFICIENT");
    pass("CASE-B all candidates insufficient", { blockReason: bundle.blockReason });
}

// CASE C — ordinary RANGE (non shock/FTS) keeps single-authority path (no profitability escalation)
{
    const entry = 2500;
    const narrowPrimary = entry * 1.0016;
    const bundle = resolveV2PreEntryExecutableTpBundle({
        side: "long",
        regime: "RANGE",
        entryPrice: entry,
        rawStructuralSl: 2490,
        rawPolicySlPrice: 2490,
        execMetaTakeProfitPlanTp1: narrowPrimary,
        marketSubtype: "RANGE_FLAT",
        routingEngine: "RANGE",
        confirmedBreakout: true,
        atr: 5,
        boxHigh: 2580,
        boxLow: 2460,
        feeRate: 0.0005,
        snapshotTickSz: 0.01
    });
    assert.equal(bundle.ok, true);
    if (!bundle.ok) throw new Error("expected ok");
    assert.equal(bundle.rawCanonicalTp1Price, narrowPrimary);
    const prof = evaluateTpProfitabilityAuthority({
        symbol: "ETHUSDT",
        side: "long",
        regime: "RANGE",
        entryPrice: entry,
        canonicalTp1Price: bundle.rawCanonicalTp1Price,
        feeRate: 0.0005,
        paperSlippageEstimateBps: 8,
        tickSz: bundle.tpTickSize
    });
    assert.equal(prof.entryAllowed, false, "non-escalation path leaves gate to outer profitability check");
    pass("CASE-C non-shock keeps primary without escalation", {
        primary: narrowPrimary,
        outerGateWouldBlock: true
    });
}

// CASE D — candidate enumeration respects structural SL direction (no redundant min_profit row)
{
    const entry = 2445.68;
    const stop = 2458.09;
    const candidates = enumeratePromotedRangeTp1Candidates({
        side: "short",
        entryPrice: entry,
        rawStructuralSl: stop,
        atr: 4,
        boxHigh: 2462,
        boxLow: 2430,
        primaryTp: entry * 0.9984
    });
    assert.ok(candidates.length > 0);
    assert.equal(
        candidates.some((c) => c.source === "adaptive_range_min_profit"),
        false,
        "redundant min_profit floor must not appear as separate escalation candidate"
    );
    for (const c of candidates) {
        assert.ok(c.price < entry, "short tp below entry");
        assert.ok(c.price < stop, "short tp below stop");
    }
    pass("CASE-D candidate direction invariant", { count: candidates.length });
}

console.log("[SHOCK-FTS-TP-ESCALATION] all cases passed");
