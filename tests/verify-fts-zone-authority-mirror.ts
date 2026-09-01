import { evaluateFastTrendShiftUpperLongZoneConfirmed, type FastTrendShiftUpperLongZoneContext } from "../src/engine-v2/market-judgment/fast-trend-shift-upper-long-authority";
import { evaluateFastTrendShiftLowerShortZoneConfirmed, type FastTrendShiftLowerShortZoneContext } from "../src/engine-v2/market-judgment/fast-trend-shift-lower-short-authority";

let passedCount = 0;
let failedCount = 0;

function check(condition: boolean, msg: string) {
    if (!condition) {
        console.error(`[FAIL] ${msg}`);
        failedCount++;
    } else {
        console.log(`[PASS] ${msg}`);
        passedCount++;
    }
}

function makeBaseUpperLongContext(overrides: Partial<FastTrendShiftUpperLongZoneContext> = {}): FastTrendShiftUpperLongZoneContext {
    return {
        fastTrendShift: {
            active: true,
            direction: "long",
            higher_low_detected: true,
            higher_high_detected: true,
            box_mid_reclaimed: true,
            box_upper_breakout_hold: true,
            reason: "higher_low|higher_high|box_mid_ok|upper_hold",
            stop_price: 86900
        },
        zone: "upper",
        trendOk: true,
        qualityScore: 68,
        htfEntryPolicy: "ALLOW",
        htfRequiresStrongerConfirmation: false,
        counterTrendRisk: false,
        lateChaseBlocked: false,
        hardBlockPresent: false,
        whipsawShockRecheckActive: false,
        riskLongAllow: true,
        allowNewLong: true,
        hasSameSidePosition: false,
        hasOppositeSidePosition: false,
        paperExecutionReady: true,
        signedExecutionReady: true,
        boxMid: 87000,
        lastPrice: 87400,
        ...overrides
    };
}

function makeBaseLowerShortContext(overrides: Partial<FastTrendShiftLowerShortZoneContext> = {}): FastTrendShiftLowerShortZoneContext {
    return {
        fastTrendShift: {
            active: true,
            direction: "short",
            lower_high_detected: true,
            lower_low_detected: true,
            box_mid_lost: true,
            box_lower_breakdown_hold: true,
            reason: "lower_high|lower_low|box_mid_lost|lower_hold",
            stop_price: 87100
        },
        zone: "lower",
        trendOk: true,
        qualityScore: 68,
        htfEntryPolicy: "ALLOW",
        htfRequiresStrongerConfirmation: false,
        counterTrendRisk: false,
        lateChaseBlocked: false,
        hardBlockPresent: false,
        whipsawShockRecheckActive: false,
        riskShortAllow: true,
        allowNewShort: true,
        hasSameSidePosition: false,
        hasOppositeSidePosition: false,
        paperExecutionReady: true,
        signedExecutionReady: true,
        boxMid: 87000,
        lastPrice: 86600,
        ...overrides
    };
}

function runTests() {
    console.log("================================================================================");
    console.log("     FTS ZONE AUTHORITY HELPER 1:1 MECHANICAL MIRROR TEST SUITE");
    console.log("================================================================================");

    // CASE A: Upper Long fully met => true
    const resA = evaluateFastTrendShiftUpperLongZoneConfirmed(makeBaseUpperLongContext());
    check(resA.confirmed === true && resA.holdReason === null, "CASE A: Upper Long fully met -> confirmed: true");

    // CASE A-MIRROR: Lower Short fully met => true
    const resAMirror = evaluateFastTrendShiftLowerShortZoneConfirmed(makeBaseLowerShortContext());
    check(resAMirror.confirmed === true && resAMirror.holdReason === null, "CASE A-MIRROR: Lower Short fully met -> confirmed: true");

    // CASE B: Upper quality threshold - 1 (64) => false
    const resB = evaluateFastTrendShiftUpperLongZoneConfirmed(makeBaseUpperLongContext({ qualityScore: 64 }));
    check(resB.confirmed === false && resB.holdReason === "QUALITY_BELOW_THRESHOLD", "CASE B: Upper quality 64 -> false (QUALITY_BELOW_THRESHOLD)");

    // CASE B-MIRROR: Lower quality threshold - 1 (64) => false
    const resBMirror = evaluateFastTrendShiftLowerShortZoneConfirmed(makeBaseLowerShortContext({ qualityScore: 64 }));
    check(resBMirror.confirmed === false && resBMirror.holdReason === "QUALITY_BELOW_THRESHOLD", "CASE B-MIRROR: Lower quality 64 -> false (QUALITY_BELOW_THRESHOLD)");

    // CASE C: Upper trendOk = false => false
    const resC = evaluateFastTrendShiftUpperLongZoneConfirmed(makeBaseUpperLongContext({ trendOk: false }));
    check(resC.confirmed === false && resC.holdReason === "TREND_NOT_OK", "CASE C: Upper trendOk=false -> false (TREND_NOT_OK)");

    // CASE C-MIRROR: Lower trendOk = false => false
    const resCMirror = evaluateFastTrendShiftLowerShortZoneConfirmed(makeBaseLowerShortContext({ trendOk: false }));
    check(resCMirror.confirmed === false && resCMirror.holdReason === "TREND_NOT_OK", "CASE C-MIRROR: Lower trendOk=false -> false (TREND_NOT_OK)");

    // CASE D: Upper pivot missing => false
    const resD = evaluateFastTrendShiftUpperLongZoneConfirmed(makeBaseUpperLongContext({
        fastTrendShift: { ...makeBaseUpperLongContext().fastTrendShift!, higher_high_detected: false }
    }));
    check(resD.confirmed === false && resD.holdReason === "FTS_STRUCTURE_INCOMPLETE", "CASE D: Upper higher_high missing -> false (FTS_STRUCTURE_INCOMPLETE)");

    // CASE D-MIRROR: Lower pivot missing => false
    const resDMirror = evaluateFastTrendShiftLowerShortZoneConfirmed(makeBaseLowerShortContext({
        fastTrendShift: { ...makeBaseLowerShortContext().fastTrendShift!, lower_low_detected: false }
    }));
    check(resDMirror.confirmed === false && resDMirror.holdReason === "FTS_STRUCTURE_INCOMPLETE", "CASE D-MIRROR: Lower lower_low missing -> false (FTS_STRUCTURE_INCOMPLETE)");

    // CASE E: Upper invalid stop (stopPx >= lastPrice) => false
    const resE = evaluateFastTrendShiftUpperLongZoneConfirmed(makeBaseUpperLongContext({
        fastTrendShift: { ...makeBaseUpperLongContext().fastTrendShift!, stop_price: 88000 }
    }));
    check(resE.confirmed === false && resE.holdReason === "FTS_STRUCTURAL_STOP_INVALID", "CASE E: Upper invalid stop (stop > entry) -> false (FTS_STRUCTURAL_STOP_INVALID)");

    // CASE E-MIRROR: Lower invalid stop (stopPx <= lastPrice) => false
    const resEMirror = evaluateFastTrendShiftLowerShortZoneConfirmed(makeBaseLowerShortContext({
        fastTrendShift: { ...makeBaseLowerShortContext().fastTrendShift!, stop_price: 86000 }
    }));
    check(resEMirror.confirmed === false && resEMirror.holdReason === "FTS_STRUCTURAL_STOP_INVALID", "CASE E-MIRROR: Lower invalid stop (stop < entry) -> false (FTS_STRUCTURAL_STOP_INVALID)");

    // CASE F: Upper HTF opposite-only (SHORT_ONLY_OR_NONE) => false
    const resF = evaluateFastTrendShiftUpperLongZoneConfirmed(makeBaseUpperLongContext({ htfEntryPolicy: "SHORT_ONLY_OR_NONE" }));
    check(resF.confirmed === false && resF.holdReason === "HTF_POLICY_BLOCKS_LONG", "CASE F: Upper HTF SHORT_ONLY_OR_NONE -> false (HTF_POLICY_BLOCKS_LONG)");

    // CASE F-MIRROR: Lower HTF opposite-only (LONG_ONLY_OR_NONE) => false
    const resFMirror = evaluateFastTrendShiftLowerShortZoneConfirmed(makeBaseLowerShortContext({ htfEntryPolicy: "LONG_ONLY_OR_NONE" }));
    check(resFMirror.confirmed === false && resFMirror.holdReason === "HTF_POLICY_BLOCKS_SHORT", "CASE F-MIRROR: Lower HTF LONG_ONLY_OR_NONE -> false (HTF_POLICY_BLOCKS_SHORT)");

    // CASE G: hardBlockPresent = true
    const resG_Upper = evaluateFastTrendShiftUpperLongZoneConfirmed(makeBaseUpperLongContext({ hardBlockPresent: true }));
    const resG_Lower = evaluateFastTrendShiftLowerShortZoneConfirmed(makeBaseLowerShortContext({ hardBlockPresent: true }));
    check(resG_Upper.confirmed === false && resG_Upper.holdReason === "HARD_BLOCK_PRESENT", "CASE G: Upper hardBlockPresent -> false (HARD_BLOCK_PRESENT)");
    check(resG_Lower.confirmed === false && resG_Lower.holdReason === "HARD_BLOCK_PRESENT", "CASE G-MIRROR: Lower hardBlockPresent -> false (HARD_BLOCK_PRESENT)");

    // CASE H: whipsawShockRecheckActive = true
    const resH_Upper = evaluateFastTrendShiftUpperLongZoneConfirmed(makeBaseUpperLongContext({ whipsawShockRecheckActive: true }));
    const resH_Lower = evaluateFastTrendShiftLowerShortZoneConfirmed(makeBaseLowerShortContext({ whipsawShockRecheckActive: true }));
    check(resH_Upper.confirmed === false && resH_Upper.holdReason === "WHIPSAW_SHOCK_RECHECK", "CASE H: Upper whipsawShockRecheckActive -> false (WHIPSAW_SHOCK_RECHECK)");
    check(resH_Lower.confirmed === false && resH_Lower.holdReason === "WHIPSAW_SHOCK_RECHECK", "CASE H-MIRROR: Lower whipsawShockRecheckActive -> false (WHIPSAW_SHOCK_RECHECK)");

    // CASE I: same-side position = true
    const resI_Upper = evaluateFastTrendShiftUpperLongZoneConfirmed(makeBaseUpperLongContext({ hasSameSidePosition: true }));
    const resI_Lower = evaluateFastTrendShiftLowerShortZoneConfirmed(makeBaseLowerShortContext({ hasSameSidePosition: true }));
    check(resI_Upper.confirmed === false && resI_Upper.holdReason === "POSITION_CONFLICT", "CASE I: Upper same-side position -> false (POSITION_CONFLICT)");
    check(resI_Lower.confirmed === false && resI_Lower.holdReason === "POSITION_CONFLICT", "CASE I-MIRROR: Lower same-side position -> false (POSITION_CONFLICT)");

    // CASE J: opposite-side position = true
    const resJ_Upper = evaluateFastTrendShiftUpperLongZoneConfirmed(makeBaseUpperLongContext({ hasOppositeSidePosition: true }));
    const resJ_Lower = evaluateFastTrendShiftLowerShortZoneConfirmed(makeBaseLowerShortContext({ hasOppositeSidePosition: true }));
    check(resJ_Upper.confirmed === false && resJ_Upper.holdReason === "POSITION_CONFLICT", "CASE J: Upper opposite-side position -> false (POSITION_CONFLICT)");
    check(resJ_Lower.confirmed === false && resJ_Lower.holdReason === "POSITION_CONFLICT", "CASE J-MIRROR: Lower opposite-side position -> false (POSITION_CONFLICT)");

    // CASE K: paperExecutionReady = false
    const resK_Upper = evaluateFastTrendShiftUpperLongZoneConfirmed(makeBaseUpperLongContext({ paperExecutionReady: false }));
    const resK_Lower = evaluateFastTrendShiftLowerShortZoneConfirmed(makeBaseLowerShortContext({ paperExecutionReady: false }));
    check(resK_Upper.confirmed === false && resK_Upper.holdReason === "EXECUTION_NOT_READY", "CASE K: Upper paperExecutionReady=false -> false (EXECUTION_NOT_READY)");
    check(resK_Lower.confirmed === false && resK_Lower.holdReason === "EXECUTION_NOT_READY", "CASE K-MIRROR: Lower paperExecutionReady=false -> false (EXECUTION_NOT_READY)");

    // CASE L: signedExecutionReady = false
    const resL_Upper = evaluateFastTrendShiftUpperLongZoneConfirmed(makeBaseUpperLongContext({ signedExecutionReady: false }));
    const resL_Lower = evaluateFastTrendShiftLowerShortZoneConfirmed(makeBaseLowerShortContext({ signedExecutionReady: false }));
    check(resL_Upper.confirmed === false && resL_Upper.holdReason === "EXECUTION_NOT_READY", "CASE L: Upper signedExecutionReady=false -> false (EXECUTION_NOT_READY)");
    check(resL_Lower.confirmed === false && resL_Lower.holdReason === "EXECUTION_NOT_READY", "CASE L-MIRROR: Lower signedExecutionReady=false -> false (EXECUTION_NOT_READY)");

    console.log("\n================================================================================");
    console.log(`TOTAL: ${passedCount + failedCount} | PASSED: ${passedCount} | FAILED: ${failedCount}`);
    console.log("================================================================================");

    if (failedCount > 0) {
        process.exit(1);
    }
}

runTests();
