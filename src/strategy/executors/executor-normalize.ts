import type { MarketRegime } from "../market-regime-detector";
import type { PaperOpenPositionRecord } from "../../models/types";
import type { ExecutorName } from "./types";

/** Legacy JSON / 이벤트에 남을 수 있는 값. */
export type LegacyExecutorName = ExecutorName | "NONE";

/**
 * 단일 executor 필드 정규화. 레거시 `NONE` → `IDLE`.
 */
export function normalizeExecutorName(e: unknown): ExecutorName {
  if (e === "RANGE" || e === "TREND" || e === "IDLE") return e;
  return "IDLE";
}

/**
 * EXIT 등 이벤트용: 저장된 실행기가 없으면 레짐으로 보완, 레거시 NONE → IDLE.
 */
export function executorForExitEventPayload(
  executorAtEntry: unknown,
  regimeAtEntry: MarketRegime | undefined | null
): ExecutorName {
  if (executorAtEntry === "RANGE" || executorAtEntry === "TREND" || executorAtEntry === "IDLE") {
    return executorAtEntry;
  }
  if (executorAtEntry === "NONE") return "IDLE";
  if (regimeAtEntry === "RANGE") return "RANGE";
  if (regimeAtEntry === "TREND") return "TREND";
  return "IDLE";
}

/** `positions/open.json` 로드 시 레거시 필드만 마이그레이션. */
export function migrateLegacyExecutorAtEntry(r: PaperOpenPositionRecord): PaperOpenPositionRecord {
  const ex = r.executorAtEntry as LegacyExecutorName | undefined;
  if (ex === "NONE") {
    return { ...r, executorAtEntry: "IDLE" };
  }
  return r;
}
