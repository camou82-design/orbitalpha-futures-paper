import type {
  MarketModeSelectorOutput,
  PaperEngineRoutingKind,
  PaperExplanationFields,
  RiskExposureOutput
} from "../models/types";

export type ExplanationInput = Readonly<{
  marketMode: MarketModeSelectorOutput;
  risk: RiskExposureOutput;
  entryHint?: string;
  exitHint?: string;
  switchHint?: string;
}>;

function labelForActiveEngine(a: PaperEngineRoutingKind): string {
  switch (a) {
    case "RANGE":
      return "활성 엔진: RANGE(양방향 박스)";
    case "TREND":
      return "활성 엔진: TREND(돌파·스위칭)";
    default:
      return "활성 엔진: 없음(관망)";
  }
}

/**
 * 번들·엔진 상태에 실을 사람이 읽는 문장 필드를 합성한다.
 */
export function buildPaperExplanation(input: ExplanationInput): PaperExplanationFields {
  const { marketMode, risk } = input;
  const routing = marketMode.routing;
  const engineReasonLabel = `${labelForActiveEngine(routing.activeEngine)} — ${routing.routingReasonLabel}`;

  return {
    modeReasonLabel: marketMode.modeReasonLabel,
    engineReasonLabel,
    riskReasonLabel: risk.riskReasonLabel,
    entryReasonLabel: input.entryHint?.trim() ? input.entryHint! : "직전 틱 진입 설명 없음",
    exitReasonLabel: input.exitHint?.trim() ? input.exitHint! : "직전 틱 청산 설명 없음",
    switchReasonLabel: input.switchHint?.trim() ? input.switchHint! : "직전 틱 스위칭 없음",
    activeEngine: routing.activeEngine,
    newEntryPolicy: routing.newEntryPolicy
  };
}
