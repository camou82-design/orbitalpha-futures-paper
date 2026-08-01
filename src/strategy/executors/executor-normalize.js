"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeExecutorName = normalizeExecutorName;
exports.executorForExitEventPayload = executorForExitEventPayload;
exports.migrateLegacyExecutorAtEntry = migrateLegacyExecutorAtEntry;
/**
 * 단일 executor 필드 정규화. 레거시 `NONE` → `IDLE`.
 */
function normalizeExecutorName(e) {
    if (e === "RANGE" || e === "TREND" || e === "IDLE")
        return e;
    return "IDLE";
}
/**
 * EXIT 등 이벤트용: 저장된 실행기가 없으면 레짐으로 보완, 레거시 NONE → IDLE.
 */
function executorForExitEventPayload(executorAtEntry, regimeAtEntry) {
    if (executorAtEntry === "RANGE" || executorAtEntry === "TREND" || executorAtEntry === "IDLE") {
        return executorAtEntry;
    }
    if (executorAtEntry === "NONE")
        return "IDLE";
    if (regimeAtEntry === "RANGE")
        return "RANGE";
    if (regimeAtEntry === "TREND")
        return "TREND";
    return "IDLE";
}
/** `positions/open.json` 로드 시 레거시 필드만 마이그레이션. */
function migrateLegacyExecutorAtEntry(r) {
    const ex = r.executorAtEntry;
    if (ex === "NONE") {
        return { ...r, executorAtEntry: "IDLE" };
    }
    return r;
}
