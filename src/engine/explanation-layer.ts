import type {
  MarketModeSelectorOutput,
  PaperEngineRoutingKind,
  PaperExplanationFields,
  PaperMarketMode,
  RiskExposureOutput
} from "../models/types";

export type ExplanationInput = Readonly<{
  marketMode: MarketModeSelectorOutput;
  risk: RiskExposureOutput;
  entryHint?: string;
  exitHint?: string;
  switchHint?: string;
}>;

function shortMarketJudgment(mm: PaperMarketMode): string {
  switch (mm) {
    case "RANGE":
      return "횡보 우세";
    case "TREND":
      return "추세 우세";
    case "MIXED":
      return "혼재";
    case "TRANSITION":
      return "전환";
    case "NO_TRADE":
      return "관망";
    default:
      return "판단 보류";
  }
}

function compactEngineLine(routing: MarketModeSelectorOutput["routing"]): string {
  const eng: PaperEngineRoutingKind = routing.activeEngine;
  const role =
    eng === "RANGE" ? "양방향·왕복" : eng === "TREND" ? "돌파·스위칭" : "대기";
  const entry =
    routing.newEntryPolicy === "full" ? "전량" : routing.newEntryPolicy === "reduced" ? "축소" : "보류";
  const probe = routing.probeEntryOnly === true ? " · 탐색" : "";
  const tier = routing.transitionTier ? ` · ${routing.transitionTier}` : "";
  return `운용: ${eng} ${role} · 진입 ${entry}${probe}${tier}`;
}

function compactRiskLine(risk: RiskExposureOutput): string {
  const mult = Math.round(risk.sizeMultiplier * 100) / 100;
  const bias = Math.round(risk.opportunityBias * 100) / 100;
  return `리스크: ${risk.riskStanceLabel} · 배율 ${mult} · 기회가중 ${bias}`;
}

/**
 * 번들·엔진 상태에 실을 사람이 읽는 문장 필드를 합성한다.
 */
export function buildPaperExplanation(input: ExplanationInput): PaperExplanationFields {
  const { marketMode, risk } = input;
  const routing = marketMode.routing;

  return {
    modeReasonLabel: shortMarketJudgment(marketMode.marketMode),
    engineReasonLabel: compactEngineLine(routing),
    riskReasonLabel: compactRiskLine(risk),
    entryReasonLabel: input.entryHint?.trim() ? input.entryHint! : "진입 이벤트 없음",
    exitReasonLabel: input.exitHint?.trim() ? input.exitHint! : "청산 없음",
    switchReasonLabel: input.switchHint?.trim() ? input.switchHint! : "전환 없음",
    activeEngine: routing.activeEngine,
    newEntryPolicy: routing.newEntryPolicy
  };
}
