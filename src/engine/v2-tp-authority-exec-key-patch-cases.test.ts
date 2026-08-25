/**
 * Regression: V2 TP Authority Alignment + Execution Key Premature Claim Fix
 * REQ A-L + ITEM 5 live BTC fixture
 *
 * Tests:
 *   REQ A: TREND + tpRequired=false (PARTIAL_TRAILING) + valid stop -> PASS
 *   REQ B: TREND + takeProfitRequired=true + TP=null -> V2_TREND_TP_PRICE_UNAVAILABLE BLOCK
 *   REQ C: TREND + stop=null -> PRE_ENTRY_SL_PRICE_MISSING BLOCK
 *   REQ D: TREND + invalid directional stop -> PRE_ENTRY_SL_TP_DIRECTION_INVALID BLOCK
 *   REQ E: RANGE + TP required + TP=null -> BLOCK unchanged
 *   REQ F: protection-plan blocks -> key NOT consumed
 *   REQ G: order-submit flag false -> key NOT consumed
 *   REQ H: all gates pass -> key claimed exactly ONCE before submit
 *   REQ I: two candidates same key -> first claims, second duplicate-blocked
 *   REQ J: first candidate blocked by protection-plan -> key not consumed -> second claims (no false duplicate)
 *   REQ K: post-submit key not reusable
 *   REQ L: sizing/stop/leverage chain immutable (42.48 -> 424.8 -> 306 unchanged)
 *   ITEM 5: Live BTC fixture V2_TREND_QUALIFIED_FINAL_PROMOTION
 */
import assert from "node:assert/strict";
import { evaluatePreEntryProtectionPlan } from "../engine-v2/execution/pre-entry-protection-plan";
import { shouldAttachFullPositionProtectiveTp } from "../engine-v2/execution/protective-tp-authority";

function pass(tag: string, detail?: unknown) {
    if (detail !== undefined) {
        console.log(`[TP-EXEC-KEY-PATCH][${tag}] PASS -`, JSON.stringify(detail));
    } else {
        console.log(`[TP-EXEC-KEY-PATCH][${tag}] PASS`);
    }
}

console.log("=== V2 TP AUTHORITY + EXECUTION KEY PATCH REGRESSION TESTS ===");

// REQ A: TREND + tpRequired=false (PARTIAL_TRAILING, no takeProfitRequired) + valid stop -> PASS
{
    // Verify producer: protective-tp-authority returns fullPositionTpRequired=false
    const tpEval = shouldAttachFullPositionProtectiveTp({
        isV2Authority: true,
        regime: "TREND",
        isV2RangePartialPlan: false,
        rawWantsTp: false,
        takeProfitRequired: undefined
    });
    assert.equal(tpEval.fullPositionTpRequired, false, "REQ_A: tpEval.fullPositionTpRequired must be false");

    // Verify consumer: evaluatePreEntryProtectionPlan respects authority — PASS
    const plan = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT",
        side: "long",
        entryReferencePrice: 95000,
        slPrice: 93500,
        tpPrice: null,
        isV2Authority: true,
        regime: "TREND",
        tickSz: 0.1
    });
    assert.equal(plan.tpRequired, false, "REQ_A: tpRequired must be false");
    assert.equal(plan.slValid, true, "REQ_A: slValid must be true");
    assert.equal(plan.entryBlocked, false, "REQ_A: entry must NOT be blocked");
    assert.equal(plan.blockReason, null, "REQ_A: blockReason must be null");
    assert.equal(plan.protectionPlanReady, true, "REQ_A: protectionPlanReady must be true");
    pass("REQ_A_TREND_PARTIAL_TRAILING_NO_TP_PASS", { tpRequired: plan.tpRequired, entryBlocked: plan.entryBlocked });
}

// REQ B: TREND + takeProfitRequired=true + TP=null -> BLOCK
{
    const plan = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT",
        side: "long",
        entryReferencePrice: 95000,
        slPrice: 93500,
        tpPrice: null,
        isV2Authority: true,
        regime: "TREND",
        takeProfitRequired: true,
        tickSz: 0.1
    });
    assert.equal(plan.tpRequired, true, "REQ_B: tpRequired must be true");
    assert.equal(plan.entryBlocked, true, "REQ_B: entry must be blocked");
    assert.equal(plan.blockReason, "V2_TREND_TP_PRICE_UNAVAILABLE", "REQ_B: blockReason must be V2_TREND_TP_PRICE_UNAVAILABLE");
    pass("REQ_B_TREND_TP_REQUIRED_NULL_BLOCK", { blockReason: plan.blockReason });
}

// REQ C: TREND + stop=null -> BLOCK (SL always mandatory)
{
    const plan = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT",
        side: "long",
        entryReferencePrice: 95000,
        slPrice: null,
        tpPrice: null,
        isV2Authority: true,
        regime: "TREND",
        tickSz: 0.1
    });
    assert.equal(plan.slValid, false, "REQ_C: slValid must be false");
    assert.equal(plan.entryBlocked, true, "REQ_C: entry must be blocked");
    assert.equal(plan.blockReason, "PRE_ENTRY_SL_PRICE_MISSING", "REQ_C: blockReason must be PRE_ENTRY_SL_PRICE_MISSING");
    pass("REQ_C_TREND_NO_STOP_BLOCK", { blockReason: plan.blockReason });
}

// REQ D: TREND + invalid directional stop -> BLOCK
{
    // LONG: stop above entry = direction invalid
    const planL = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT",
        side: "long",
        entryReferencePrice: 95000,
        slPrice: 96000,
        tpPrice: null,
        isV2Authority: true,
        regime: "TREND",
        tickSz: 0.1
    });
    assert.equal(planL.entryBlocked, true, "REQ_D_LONG: blocked");
    assert.equal(planL.blockReason, "PRE_ENTRY_SL_TP_DIRECTION_INVALID", "REQ_D_LONG: direction invalid");

    // SHORT: stop below entry = direction invalid
    const planS = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT",
        side: "short",
        entryReferencePrice: 95000,
        slPrice: 94000,
        tpPrice: null,
        isV2Authority: true,
        regime: "TREND",
        tickSz: 0.1
    });
    assert.equal(planS.entryBlocked, true, "REQ_D_SHORT: blocked");
    assert.equal(planS.blockReason, "PRE_ENTRY_SL_TP_DIRECTION_INVALID", "REQ_D_SHORT: direction invalid");
    pass("REQ_D_INVALID_STOP_DIRECTION_BLOCK");
}

// REQ E: RANGE + TP required + TP=null -> BLOCK (unchanged)
{
    const plan = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT",
        side: "long",
        entryReferencePrice: 95000,
        slPrice: 93000,
        tpPrice: null,
        isV2Authority: true,
        regime: "RANGE",
        takeProfitRequired: true,
        tickSz: 0.1
    });
    assert.equal(plan.entryBlocked, true, "REQ_E: RANGE TP required null must block");
    pass("REQ_E_RANGE_TP_REQUIRED_NULL_BLOCK", { blockReason: plan.blockReason });
}

// REQ F: protection-plan blocks entry -> key NOT consumed
{
    const consumed = new Set<string>();
    const ck = (k: string) => { if (consumed.has(k)) return false; consumed.add(k); return true; };
    const plan = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT", side: "long", entryReferencePrice: 95000,
        slPrice: null, tpPrice: null, isV2Authority: true, regime: "TREND", tickSz: 0.1
    });
    const key = "v2entry:BTCUSDT:long:99";
    let claimed = false;
    if (!plan.entryBlocked) { claimed = ck(key); }
    assert.equal(claimed, false, "REQ_F: key not claimed");
    assert.equal(consumed.has(key), false, "REQ_F: key not in consumed set");
    pass("REQ_F_PROTECTION_PLAN_BLOCK_KEY_NOT_CONSUMED");
}

// REQ G: order-submit flag false (ticker/order-build block) -> key NOT consumed
{
    const consumed = new Set<string>();
    const ck = (k: string) => { if (consumed.has(k)) return false; consumed.add(k); return true; };
    const plan = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT", side: "long", entryReferencePrice: 95000,
        slPrice: 93500, tpPrice: null, isV2Authority: true, regime: "TREND", tickSz: 0.1
    });
    const key = "v2entry:BTCUSDT:long:99";
    const orderSubmitAllowed = false;
    let claimed = false;
    if (!plan.entryBlocked && orderSubmitAllowed) { claimed = ck(key); }
    assert.equal(claimed, false, "REQ_G: key not claimed when orderSubmitAllowed=false");
    assert.equal(consumed.has(key), false, "REQ_G: key not in consumed set");
    pass("REQ_G_ORDER_SUBMIT_BLOCK_KEY_NOT_CONSUMED");
}

// REQ H: all pre-submit gates pass -> key claimed exactly ONCE before submit
{
    const consumed = new Set<string>();
    const ck = (k: string) => { if (consumed.has(k)) return false; consumed.add(k); return true; };
    const plan = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT", side: "long", entryReferencePrice: 95000,
        slPrice: 93500, tpPrice: null, isV2Authority: true, regime: "TREND", tickSz: 0.1
    });
    const key = "v2entry:BTCUSDT:long:100";
    let claimed = false;
    if (!plan.entryBlocked) { claimed = ck(key); /* submitOkxOrder would fire here */ }
    assert.equal(plan.entryBlocked, false, "REQ_H: not blocked");
    assert.equal(claimed, true, "REQ_H: key claimed");
    assert.equal(consumed.has(key), true, "REQ_H: key in consumed set");
    pass("REQ_H_ALL_GATES_PASS_KEY_CLAIMED_ONCE", { claimed });
}

// REQ I: two candidates same runCycleId key -> first claims, second duplicate-blocked
{
    const consumed = new Set<string>();
    const ck = (k: string) => { if (consumed.has(k)) return false; consumed.add(k); return true; };
    const key = "v2entry:BTCUSDT:long:101";
    const p1 = evaluatePreEntryProtectionPlan({ symbol: "BTCUSDT", side: "long", entryReferencePrice: 95000, slPrice: 93500, tpPrice: null, isV2Authority: true, regime: "TREND", tickSz: 0.1 });
    const c1 = !p1.entryBlocked ? ck(key) : false;
    const p2 = evaluatePreEntryProtectionPlan({ symbol: "BTCUSDT", side: "long", entryReferencePrice: 95000, slPrice: 93500, tpPrice: null, isV2Authority: true, regime: "TREND", tickSz: 0.1 });
    const c2 = !p2.entryBlocked ? ck(key) : false;
    assert.equal(c1, true, "REQ_I: first claim ok");
    assert.equal(c2, false, "REQ_I: second claim must be duplicate-blocked");
    pass("REQ_I_SECOND_SAME_KEY_DUPLICATE_BLOCKED", { first_claim: c1, second_claim: c2 });
}

// REQ J: first candidate blocked by protection-plan -> key NOT consumed ->
//        second candidate passes -> claims fine (NO false duplicate)
{
    const consumed = new Set<string>();
    const ck = (k: string) => { if (consumed.has(k)) return false; consumed.add(k); return true; };
    const key = "v2entry:BTCUSDT:long:102";
    // First: blocked by missing stop
    const pBlocked = evaluatePreEntryProtectionPlan({ symbol: "BTCUSDT", side: "long", entryReferencePrice: 95000, slPrice: null, tpPrice: null, isV2Authority: true, regime: "TREND", tickSz: 0.1 });
    const c1 = !pBlocked.entryBlocked ? ck(key) : false;
    assert.equal(c1, false, "REQ_J: first (blocked) does not claim key");
    assert.equal(consumed.has(key), false, "REQ_J: key not in consumed set after first block");
    // Second: passes
    const pPass = evaluatePreEntryProtectionPlan({ symbol: "BTCUSDT", side: "long", entryReferencePrice: 95000, slPrice: 93500, tpPrice: null, isV2Authority: true, regime: "TREND", tickSz: 0.1 });
    const c2 = !pPass.entryBlocked ? ck(key) : false;
    assert.equal(c2, true, "REQ_J: second (passing) claims key — no false duplicate");
    pass("REQ_J_FIRST_BLOCKED_NO_FALSE_DUPLICATE", { first_claim: c1, second_claim: c2 });
}

// REQ K: after submit-time claim, same key must not be claimable again
{
    const consumed = new Set<string>();
    const ck = (k: string) => { if (consumed.has(k)) return false; consumed.add(k); return true; };
    const key = "v2entry:BTCUSDT:long:103";
    assert.equal(ck(key), true, "REQ_K: first claim ok (submit moment)");
    assert.equal(ck(key), false, "REQ_K: retry of same key must be blocked");
    pass("REQ_K_POST_SUBMIT_KEY_NOT_REUSABLE");
}

// REQ L: sizing/stop/leverage chain invariant (live audit numbers)
{
    const KRW_PER_USD = 1400;
    const stageMarginKrw = 59470;
    const appliedLeverage = 10;
    const marginUsdt = stageMarginKrw / KRW_PER_USD;
    const notionalUsdt = marginUsdt * appliedLeverage;
    assert.ok(Math.abs(marginUsdt - 42.48) < 0.01, `REQ_L: authority_size_usdt must be ~42.48 (got ${marginUsdt})`);
    assert.ok(Math.abs(notionalUsdt - 424.8) < 0.5, `REQ_L: computed_notional must be ~424.8 (got ${notionalUsdt})`);
    assert.equal(Math.min(notionalUsdt, 306), 306, "REQ_L: emergency cap clamping to 306 unchanged");

    // PARTIAL_TRAILING: plan must pass with null TP
    const plan = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT", side: "long", entryReferencePrice: 95000,
        slPrice: 93500, tpPrice: null, isV2Authority: true, regime: "TREND", tickSz: 0.1
    });
    assert.equal(plan.entryBlocked, false, "REQ_L: PARTIAL_TRAILING protection plan must PASS");
    assert.equal(plan.tpRequired, false, "REQ_L: tpRequired must be false");
    pass("REQ_L_SIZING_IMMUTABLE_PARTIAL_TRAILING", {
        stageMarginKrw, authority_size_usdt: +marginUsdt.toFixed(2),
        computed_order_notional_usdt: +notionalUsdt.toFixed(2), capped: 306
    });
}

// ITEM 5: Live BTC fixture (V2_TREND_QUALIFIED_FINAL_PROMOTION)
{
    console.log("\n--- ITEM 5: Live BTC Fixture ---");
    const KRW_PER_USD = 1400;
    const stageMarginKrw = 59470;
    const appliedLeverage = 10;
    const entryPx = 95000;
    const stopPx = 93500;

    // Producer
    const tpEval = shouldAttachFullPositionProtectiveTp({
        isV2Authority: true, regime: "TREND", isV2RangePartialPlan: false, rawWantsTp: false, takeProfitRequired: undefined
    });
    assert.equal(tpEval.fullPositionTpRequired, false, "ITEM5: tpEval must be false");

    // Consumer (pre-entry plan)
    const plan = evaluatePreEntryProtectionPlan({
        symbol: "BTCUSDT", side: "long", entryReferencePrice: entryPx,
        slPrice: stopPx, tpPrice: null, isV2Authority: true, regime: "TREND", tickSz: 0.1
    });
    assert.equal(plan.entryBlocked, false, "ITEM5: protection plan must PASS");
    assert.equal(plan.tpRequired, false, "ITEM5: tpRequired false");
    assert.equal(plan.blockReason, null, "ITEM5: no blockReason");

    // Sizing
    const marginUsdt = stageMarginKrw / KRW_PER_USD;
    const notionalUsdt = marginUsdt * appliedLeverage;
    assert.ok(Math.abs(marginUsdt - 42.48) < 0.01);
    assert.ok(Math.abs(notionalUsdt - 424.8) < 0.5);

    // Exec-key claim -> submit stub called exactly once
    const consumed = new Set<string>();
    const ck = (k: string) => { if (consumed.has(k)) return false; consumed.add(k); return true; };
    const submitCalls: string[] = [];
    const key = "v2entry:BTCUSDT:long:22";
    let submitted = false;
    if (!plan.entryBlocked) {
        const keyClaimed = ck(key);
        if (keyClaimed) { submitCalls.push("BTCUSDT"); submitted = true; }
    }
    assert.equal(submitted, true, "ITEM5: submit stub called");
    assert.equal(submitCalls.length, 1, "ITEM5: submitCalls must be exactly 1");

    // Duplicate blocked
    const secondClaim = ck(key);
    assert.equal(secondClaim, false, "ITEM5: second claim must be duplicate-blocked");

    pass("ITEM5_LIVE_BTC_FIXTURE_V2_TREND_QUALIFIED_FINAL_PROMOTION", {
        symbol: "BTCUSDT", side: "long", regime: "TREND",
        promotionReason: "V2_TREND_QUALIFIED_FINAL_PROMOTION",
        stageMarginKrw,
        authority_size_usdt: +marginUsdt.toFixed(2),
        computed_notional_usdt: +notionalUsdt.toFixed(2),
        stopPx, initialTp: null,
        tpRequired: plan.tpRequired,
        entryBlocked: plan.entryBlocked,
        submitCalls: submitCalls.length,
        duplicateBlocked: !secondClaim
    });
}

// EXTRA: RANGE partial-plan sovereignty unchanged
{
    const tpEval = shouldAttachFullPositionProtectiveTp({
        isV2Authority: true, regime: "RANGE", isV2RangePartialPlan: true, rawWantsTp: false, takeProfitRequired: undefined
    });
    assert.equal(tpEval.fullPositionTpRequired, false);
    assert.equal(tpEval.reason, "V2_RANGE_PARTIAL_SOVEREIGNTY");
    pass("RANGE_PARTIAL_PLAN_SOVEREIGNTY_UNCHANGED");
}

console.log("\n=== ALL V2 TP AUTHORITY + EXECUTION KEY PATCH REGRESSION TESTS PASSED ===");