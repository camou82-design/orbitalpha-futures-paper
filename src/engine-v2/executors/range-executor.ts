import { EngineV2Input, ExecutorOutput } from "../types";

/**
 * Tier 4: Range Executor (Refined)
 * Standard return structure and fixed syntax.
 */
export function executeRangeRegime(input: EngineV2Input): ExecutorOutput {
    const { snapshot: sn } = input;
    const boxPos = sn.boxPos ?? 0.5;
    const rangeConfidence = sn.rangeConfidence ?? 0;
    const boxCohesion01 = sn.boxCohesion01 ?? 0;
    const trendWeaknessScore = sn.trendWeaknessScore ?? 0;
    const qualityScore = sn.qualityScore ?? 0;

    let signal: ExecutorOutput["signal"] = "NONE";
    let side: ExecutorOutput["side"] = "none";
    let baseSizeIntent = 1.0;
    let recheckSuggested = false;
    let reason = "Watching mid-zone";
    let relaxedRangeEntry = false;

    const edgeStructurePromotionQualified =
        rangeConfidence >= 0.65 &&
        boxCohesion01 >= 0.9 &&
        trendWeaknessScore >= 0.7 &&
        qualityScore >= 80;

    if (boxPos >= 0.74) {
        if (!input.state.shortAllow) {
            signal = "NONE";
            side = "none";
            reason = `Upper edge reached but short is blocked by directional bias (${input.state.directionalShockState})`;
        } else {
            side = "short";
            if (rangeConfidence > 0.8) {
                signal = "SHORT_CANDIDATE";
                reason = "Upper edge reversal identified";
            } else if (edgeStructurePromotionQualified) {
                signal = "SHORT_CANDIDATE";
                reason = "Range edge qualified by structure quality";
                recheckSuggested = false;
                relaxedRangeEntry = true;
            } else {
                signal = "WAIT_RECHECK";
                reason = "Upper edge reached; awaiting confirmation";
                recheckSuggested = true;
            }
        }
    } else if (boxPos <= 0.26) {
        if (!input.state.longAllow) {
            signal = "NONE";
            side = "none";
            reason = `Lower edge reached but long is blocked by directional bias (${input.state.directionalShockState})`;
        } else {
            side = "long";
            if (rangeConfidence > 0.8) {
                signal = "LONG_CANDIDATE";
                reason = "Lower edge reversal identified";
            } else if (edgeStructurePromotionQualified) {
                signal = "LONG_CANDIDATE";
                reason = "Range edge qualified by structure quality";
                recheckSuggested = false;
                relaxedRangeEntry = true;
            } else {
                signal = "WAIT_RECHECK";
                reason = "Lower edge reached; awaiting confirmation";
                recheckSuggested = true;
            }
        }
    }

    const metadata: Record<string, string | number | boolean> = {
        boxPos: input.snapshot.boxPos ?? 0.5
    };
    if (relaxedRangeEntry) {
        metadata.rangeConfidence = rangeConfidence;
        metadata.boxCohesion01 = boxCohesion01;
        metadata.trendWeaknessScore = trendWeaknessScore;
        metadata.qualityScore = qualityScore;
        metadata.relaxedRangeEntry = true;
        metadata.reason = "Range edge qualified by structure quality";
    }

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
