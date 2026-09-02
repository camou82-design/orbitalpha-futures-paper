/**
 * TREND pre-entry TP authority — engine mirror fallback when explicit TP missing.
 */

import assert from "node:assert/strict";
import { engineMirrorTpPrice } from "./position-ops-monitor";
import { takeProfitPctForRegime } from "../strategy/regime-exit";
import {
    resolveV2PreEntryExecutableTpBundle,
    resolveV2PreEntryTp1Authority
} from "../engine-v2/execution/pre-entry-tp-provenance";

function pass(label: string, detail?: Record<string, unknown>): void {
    const extra = detail ? ` — ${JSON.stringify(detail)}` : "";
    console.log(`[V2-TREND-TP-PRICE-AUTHORITY][${label}] PASS${extra}`);
}

const ENTRY = 100_000;
const EXPLICIT_LONG_TP = 102_000;
const EXPLICIT_SHORT_TP = 97_500;

assert.equal(takeProfitPctForRegime("TREND"), 0.0105, "TREND TP policy = 1.05%");

// CASE A — TREND LONG, explicit TP null -> engine mirror
{
    const mirrorTp = engineMirrorTpPrice(ENTRY, "long", "TREND");
    assert.ok(mirrorTp != null && Math.abs(mirrorTp - 101_050) < 1e-9);

    const result = resolveV2PreEntryTp1Authority({
        side: "long",
        regime: "TREND",
        entryPrice: ENTRY,
        rawStructuralSl: 98_500,
        rawPolicySlPrice: 98_500
    });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("expected ok");
    assert.ok(Math.abs(result.rawTp1Price - 101_050) < 1e-9);
    assert.equal(result.tpSource, "engine_calculated_fallback");
    assert.equal(result.adaptiveApplied, false);

    pass("CASE_A_TREND_LONG_MIRROR_TP", {
        entry: ENTRY,
        tp: result.rawTp1Price,
        tpSource: result.tpSource
    });
}

// CASE B — TREND SHORT, explicit TP null -> engine mirror
{
    const mirrorTp = engineMirrorTpPrice(ENTRY, "short", "TREND");
    assert.ok(mirrorTp != null && Math.abs(mirrorTp - 98_950) < 1e-9);

    const result = resolveV2PreEntryTp1Authority({
        side: "short",
        regime: "TREND",
        entryPrice: ENTRY,
        rawStructuralSl: 101_500,
        rawPolicySlPrice: 101_500
    });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("expected ok");
    assert.ok(Math.abs(result.rawTp1Price - 98_950) < 1e-9);
    assert.equal(result.tpSource, "engine_calculated_fallback");
    assert.equal(result.adaptiveApplied, false);

    pass("CASE_B_TREND_SHORT_MIRROR_TP", {
        entry: ENTRY,
        tp: result.rawTp1Price,
        tpSource: result.tpSource
    });
}

// CASE C — explicit TP precedence over engine mirror
{
    const longResult = resolveV2PreEntryTp1Authority({
        side: "long",
        regime: "TREND",
        entryPrice: ENTRY,
        rawStructuralSl: 98_500,
        rawPolicySlPrice: 98_500,
        authorityTakeProfit1Px: EXPLICIT_LONG_TP
    });
    assert.equal(longResult.ok, true);
    if (!longResult.ok) throw new Error("expected ok");
    assert.equal(longResult.rawTp1Price, EXPLICIT_LONG_TP);
    assert.equal(longResult.tpSource, "authority_tp_price");

    const shortResult = resolveV2PreEntryTp1Authority({
        side: "short",
        regime: "TREND",
        entryPrice: ENTRY,
        rawStructuralSl: 101_500,
        rawPolicySlPrice: 101_500,
        decisionTakeProfit: EXPLICIT_SHORT_TP
    });
    assert.equal(shortResult.ok, true);
    if (!shortResult.ok) throw new Error("expected ok");
    assert.equal(shortResult.rawTp1Price, EXPLICIT_SHORT_TP);
    assert.equal(shortResult.tpSource, "authority_tp_price");

    pass("CASE_C_EXPLICIT_TP_PRECEDENCE", {
        longTp: EXPLICIT_LONG_TP,
        shortTp: EXPLICIT_SHORT_TP
    });
}

// CASE D — invalid entry / mirror unavailable -> fail-closed
{
    const invalidEntry = resolveV2PreEntryTp1Authority({
        side: "long",
        regime: "TREND",
        entryPrice: 0,
        rawStructuralSl: 98_500,
        rawPolicySlPrice: 98_500
    });
    assert.equal(invalidEntry.ok, false);
    if (invalidEntry.ok) throw new Error("expected block");
    assert.equal(invalidEntry.blockReason, "V2_TREND_TP_PRICE_UNAVAILABLE");

    const wrongDirectionExplicit = resolveV2PreEntryTp1Authority({
        side: "short",
        regime: "TREND",
        entryPrice: ENTRY,
        rawStructuralSl: 101_500,
        rawPolicySlPrice: 101_500,
        authorityTakeProfit1Px: 101_050
    });
    assert.equal(wrongDirectionExplicit.ok, true);
    if (!wrongDirectionExplicit.ok) throw new Error("expected mirror fallback");
    assert.equal(wrongDirectionExplicit.tpSource, "engine_calculated_fallback");
    assert.ok(Math.abs(wrongDirectionExplicit.rawTp1Price - 98_950) < 1e-9);

    pass("CASE_D_FAIL_CLOSED_ONLY_WHEN_NO_VALID_TP", {
        invalidEntryBlock: invalidEntry.blockReason,
        invalidExplicitFallsBackToMirror: wrongDirectionExplicit.rawTp1Price
    });
}

// CASE E — BTC production reproduction shape (TREND / SHOCK_REACTION_DOWN / promoted short)
{
    const btcEntry = 77_823.8;
    const btcSl = 78_051.72270384943;
    const tpAuthority = resolveV2PreEntryTp1Authority({
        side: "short",
        regime: "TREND",
        entryPrice: btcEntry,
        rawStructuralSl: btcSl,
        rawPolicySlPrice: btcSl,
        marketSubtype: "SHOCK_REACTION_DOWN",
        promotionReason: "V2_TREND_QUALIFIED_FINAL_PROMOTION",
        symbol: "BTCUSDT",
        snapshotTickSz: 0.1
    });

    assert.equal(tpAuthority.ok, true);
    if (!tpAuthority.ok) throw new Error("expected ok");

    const bundle = resolveV2PreEntryExecutableTpBundle({
        side: "short",
        regime: "TREND",
        entryPrice: btcEntry,
        rawStructuralSl: btcSl,
        rawPolicySlPrice: btcSl,
        marketSubtype: "SHOCK_REACTION_DOWN",
        promotionReason: "V2_TREND_QUALIFIED_FINAL_PROMOTION",
        symbol: "BTCUSDT",
        snapshotTickSz: 0.1,
        feeRate: 0.0005
    });

    assert.equal(bundle.ok, true);
    if (!bundle.ok) throw new Error("expected executable TP bundle");
    assert.ok(bundle.executableTp1Price > 0);
    assert.equal(bundle.tpSource, "engine_calculated_fallback");

    pass("CASE_E_BTC_TREND_SHOCK_REACTION_DOWN_PROMOTED_SHORT", {
        entry: btcEntry,
        tp: bundle.executableTp1Price,
        tpSource: bundle.tpSource,
        blockReason: null
    });
}

console.log("[V2-TREND-TP-PRICE-AUTHORITY] ALL PASS");
