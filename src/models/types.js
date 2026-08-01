"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RANGE_ZONE_UPPER_EXTREME_MIN = exports.RANGE_ZONE_LOWER_EXTREME_MAX = exports.HighwayTrendState = void 0;
exports.classifyRangeZone = classifyRangeZone;
exports.rangeZoneLowerExtreme = rangeZoneLowerExtreme;
exports.rangeZoneUpperExtreme = rangeZoneUpperExtreme;
var HighwayTrendState;
(function (HighwayTrendState) {
    HighwayTrendState["VALID"] = "VALID";
    HighwayTrendState["WEAK"] = "WEAK";
    HighwayTrendState["INVALID"] = "INVALID";
})(HighwayTrendState || (exports.HighwayTrendState = HighwayTrendState = {}));
/**
 * Standardized RANGE zone classification logic.
 * Criteria: lower <= 0.38, upper >= 0.62, else mid.
 * Ref: USER instruction 2026-05-10
 */
function classifyRangeZone(boxPos) {
    if (boxPos === null || boxPos === undefined || !Number.isFinite(boxPos))
        return "mid";
    if (boxPos >= 0.62)
        return "upper";
    if (boxPos <= 0.38)
        return "lower";
    return "mid";
}
/**
 * 보조 진단 전용: 박스 하단/상단 “깊은” 극단. `classifyRangeZone` Primary 밴드(0.38/0.62)와 별개로
 * 기존 리버설·게이트 휴리스틱(0.26/0.74)과 맞춘다.
 */
exports.RANGE_ZONE_LOWER_EXTREME_MAX = 0.26;
exports.RANGE_ZONE_UPPER_EXTREME_MIN = 0.74;
function rangeZoneLowerExtreme(boxPos) {
    return typeof boxPos === "number" && Number.isFinite(boxPos) && boxPos <= exports.RANGE_ZONE_LOWER_EXTREME_MAX;
}
function rangeZoneUpperExtreme(boxPos) {
    return typeof boxPos === "number" && Number.isFinite(boxPos) && boxPos >= exports.RANGE_ZONE_UPPER_EXTREME_MIN;
}
// --- EOF ---
