import { EngineV2Input, ExecutorOutput } from "../types";

/**
 * Tier 4: Range Executor (Refined)
 * Standard return structure and fixed syntax.
 */
export function executeRangeRegime(input: EngineV2Input): ExecutorOutput {
    const { snapshot: sn } = input;
    const boxPos = typeof sn.boxPos === "number" && Number.isFinite(sn.boxPos) ? sn.boxPos : null;
    const rangeConfidence = typeof sn.rangeConfidence === "number" && Number.isFinite(sn.rangeConfidence) ? sn.rangeConfidence : null;
    const boxCohesion01 = typeof sn.boxCohesion01 === "number" && Number.isFinite(sn.boxCohesion01) ? sn.boxCohesion01 : null;
    const trendWeaknessScore =
        typeof sn.trendWeaknessScore === "number" && Number.isFinite(sn.trendWeaknessScore) ? sn.trendWeaknessScore : null;
    const qualityScore = typeof sn.qualityScore === "number" && Number.isFinite(sn.qualityScore) ? sn.qualityScore : null;

    let signal: ExecutorOutput["signal"] = "NONE";
    let side: ExecutorOutput["side"] = "none";
    let baseSizeIntent = 1.0;
    let recheckSuggested = false;
    let reason = "Watching mid-zone";
    let relaxedRangeEntry = false;
    const zone = boxPos == null ? "mid" : boxPos >= 0.74 ? "upper" : boxPos <= 0.26 ? "lower" : "mid";
    let reversalConfirmed = false;
    let sideZoneValid = false;

    const edgeStructurePromotionQualified =
        (rangeConfidence ?? 0) >= 0.65 &&
        (boxCohesion01 ?? 0) >= 0.9 &&
        (trendWeaknessScore ?? 0) >= 0.7 &&
        (qualityScore ?? 0) >= 80;

    if ((boxPos ?? 0.5) >= 0.74) {
        if (!input.state.shortAllow) {
            signal = "NONE";
            side = "none";
            reason = `Upper edge reached but short is blocked by directional bias (${input.state.directionalShockState})`;
        } else {
            side = "short";
            sideZoneValid = true;
            if ((rangeConfidence ?? 0) > 0.8) {
                signal = "SHORT_CANDIDATE";
                reason = "Upper edge reversal identified";
                reversalConfirmed = true;
            } else if (edgeStructurePromotionQualified) {
                signal = "SHORT_CANDIDATE";
                reason = "Range edge qualified by structure quality";
                recheckSuggested = false;
                relaxedRangeEntry = true;
                reversalConfirmed = true;
            } else {
                signal = "WAIT_RECHECK";
                reason = "Upper edge reached; awaiting confirmation";
                recheckSuggested = true;
            }
        }
    } else if ((boxPos ?? 0.5) <= 0.26) {
        if (!input.state.longAllow) {
            signal = "NONE";
            side = "none";
            reason = `Lower edge reached but long is blocked by directional bias (${input.state.directionalShockState})`;
        } else {
            side = "long";
            sideZoneValid = true;
            if ((rangeConfidence ?? 0) > 0.8) {
                signal = "LONG_CANDIDATE";
                reason = "Lower edge reversal identified";
                reversalConfirmed = true;
            } else if (edgeStructurePromotionQualified) {
                signal = "LONG_CANDIDATE";
                reason = "Range edge qualified by structure quality";
                recheckSuggested = false;
                relaxedRangeEntry = true;
                reversalConfirmed = true;
            } else {
                signal = "WAIT_RECHECK";
                reason = "Lower edge reached; awaiting confirmation";
                recheckSuggested = true;
            }
        }
    }

    const metadata: Record<string, string | number | boolean | null> = {
        rangeConfidence,
        boxCohesion01,
        trendWeaknessScore,
        qualityScore,
        boxPos,
        zone,
        sideZoneValid,
        reversal_confirmed: reversalConfirmed,
        relaxedRangeEntry,
        recheckSuggested
    };
    if (relaxedRangeEntry) metadata.reason = "Range edge qualified by structure quality";

    return {
        signal: signal,
        side: side,
        reason: signal === "NONE" ? "NO_RANGE_EDGE" : reason,
        baseSizeIntent: signal === "NONE" ? 0 : 1,
        recheckSuggested: recheckSuggested,
        isAddOnEligible: true, // RANGE allow add-ons
        metadata
    };
}
