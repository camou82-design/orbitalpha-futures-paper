import type {
  MarketModeSelectorOutput,
  PaperExplanationFields,
  RiskExposureOutput
} from "../models/types";

export type ExplanationInput = Readonly<{
  marketMode: MarketModeSelectorOutput;
  risk: RiskExposureOutput;
  /** 직전 진입/스킵 한 줄(없으면 빈 문자열) */
  entryHint?: string;
  exitHint?: string;
  switchHint?: string;
}>;

/**
 * 번들·엔진 상태에 실을 사람이 읽는 문장 필드를 합성한다.
 */
export function buildPaperExplanation(input: ExplanationInput): PaperExplanationFields {
  const { marketMode, risk } = input;
  const engineReasonLabel =
    marketMode.marketMode === "RANGE"
      ? "횡보 RANGE 엔진 궤도"
      : marketMode.marketMode === "TREND"
        ? "추세 TREND 엔진 궤도"
        : marketMode.marketMode === "MIXED"
          ? "혼합 모드·엔진 라우팅 주의"
          : marketMode.marketMode === "TRANSITION"
            ? "전환 구간·보수 운용"
            : "운용 중지 또는 데이터 부족";

  return {
    modeReasonLabel: marketMode.modeReasonLabel,
    engineReasonLabel,
    riskReasonLabel: risk.riskReasonLabel,
    entryReasonLabel: input.entryHint?.trim() ? input.entryHint! : "직전 틱 진입 설명 없음",
    exitReasonLabel: input.exitHint?.trim() ? input.exitHint! : "직전 틱 청산 설명 없음",
    switchReasonLabel: input.switchHint?.trim() ? input.switchHint! : "직전 틱 스위칭 없음"
  };
}
