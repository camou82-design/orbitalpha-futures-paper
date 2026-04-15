import { MarketJudgmentOutput, RegimeConfidenceOutput, ExecutorOutput, RiskSizingOutput, ExplanationOutput } from "../types";

export function generateExplanation(
    judgment: MarketJudgmentOutput,
    executor: ExecutorOutput,
    riskSizing: RiskSizingOutput
): ExplanationOutput {
    let status = "진입 대기";

    if (executor.signal === "WAIT_RECHECK") {
        status = "반전 후보 재확인 중 · 다음 틱 판단 대기";
    } else if (judgment.regime === "NO_TRADE") {
        status = "진입 보류 · 현재 시장 부적합";
    } else if (judgment.regime === "TRANSITION") {
        status = "전환 구간 탐색 중 · 축소 진입만 허용";
    } else if (judgment.regime === "RANGE") {
        status = "박스권 대응 중";
    } else if (judgment.regime === "TREND") {
        status = "추세 대응 중";
    }

    return {
        reason: executor.reason,
        uiLabels: {
            regime: judgment.regime,
            status
        }
    };
}
