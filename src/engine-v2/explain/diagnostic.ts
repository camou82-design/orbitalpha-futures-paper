import { MarketJudgmentOutput, RegimeConfidenceOutput, ExecutorOutput, RiskSizingOutput, ExplanationOutput } from "../types";

/**
 * Tier 5: Explanation / UI Diagnostic (Refined)
 * Provides human-readable states without sounding "stopped".
 */
export function generateExplanation(
    judgment: MarketJudgmentOutput,
    executor: ExecutorOutput,
    riskSizing: RiskSizingOutput
): ExplanationOutput {
    const { regime } = judgment;
    const { signal } = executor;

    let status = "진입 대기";

    if (signal === "WAIT_RECHECK") {
        status = "반전 후보 재확인 중 · 다음 틱 판단 대기";
    } else if (regime === "NO_TRADE") {
        status = "진입 보류 · 현재 시장 부적합";
    } else if (regime === "TRANSITION") {
        status = "전환 구간 탐색 중 · 축소 진입만 허용";
    } else if (regime === "RANGE") {
        status = "박스권 대응 중";
    } else if (regime === "TREND") {
        status = "추세 대응 중";
    }

    return {
        reason: executor.reason || riskSizing.blockReason || "Watching market",
        uiLabels: {
            regime,
            status
        }
    };
}
