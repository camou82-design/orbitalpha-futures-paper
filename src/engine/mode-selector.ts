import type {
  EngineRoutingDecision,
  MarketModeSelectorOutput,
  PaperEngineRoutingKind,
  PaperMarketMode
} from "../models/types";
import type { MarketRegimeDetection } from "../strategy/market-regime-detector";

export type ModeSelectorInput = Readonly<{
  regimeDetection: MarketRegimeDetection;
  fetchedAt: number;
  snapshotCount: number;
  errorCount: number;
  /** 대표 변동성 프록시(0–1 스케일), 없으면 0.5 */
  volatilityProxy?: number;
}>;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** MIXED/TRANSITION에서 |rc−tc|가 이보다 작으면 IDLE+paused(애매 구간). */
export const MIXED_AMBIGUITY_DELTA = 0.06;
/** RANGE 우세: rc − tc ≥ 이 값. */
export const RANGE_BEATS_TREND_MIN_GAP = 0.06;
/** TREND 우세: tc − rc ≥ 이 값. */
export const TREND_BEATS_RANGE_MIN_GAP = 0.06;

function utcSessionProfile(fetchedAt: number): string {
  const h = new Date(fetchedAt).getUTCHours();
  if (h >= 12 && h < 20) return "us_session";
  if (h >= 7 && h < 12) return "eu_overlap";
  if (h >= 0 && h < 7) return "asia_quiet";
  return "other_utc";
}

function resolveRouting(
  marketMode: PaperMarketMode,
  rangeConfidence: number,
  trendConfidence: number
): EngineRoutingDecision {
  const rc = rangeConfidence;
  const tc = trendConfidence;
  const gap = rc - tc;

  if (marketMode === "NO_TRADE") {
    return {
      activeEngine: "IDLE",
      newEntryPolicy: "paused",
      routingReasonLabel: "NO_TRADE — 신규 진입 보류"
    };
  }

  if (marketMode === "MIXED" || marketMode === "TRANSITION") {
    if (Math.abs(gap) < MIXED_AMBIGUITY_DELTA) {
      return {
        activeEngine: "IDLE",
        newEntryPolicy: "paused",
        routingReasonLabel: `혼합·전환 — 신뢰도 근접(|${rc.toFixed(2)}−${tc.toFixed(2)}|=${Math.abs(gap).toFixed(2)} < ${MIXED_AMBIGUITY_DELTA}) — 신규 진입 보류`
      };
    }
    if (gap >= RANGE_BEATS_TREND_MIN_GAP) {
      return {
        activeEngine: "RANGE",
        newEntryPolicy: "reduced",
        routingReasonLabel: `혼합·전환 — RANGE 우세(Δ≥${RANGE_BEATS_TREND_MIN_GAP}) — 축소·RANGE 위주`
      };
    }
    if (gap <= -TREND_BEATS_RANGE_MIN_GAP) {
      return {
        activeEngine: "TREND",
        newEntryPolicy: "reduced",
        routingReasonLabel: `혼합·전환 — TREND 우세(Δ≤−${TREND_BEATS_RANGE_MIN_GAP}) — 축소·TREND 위주`
      };
    }
    return {
      activeEngine: "IDLE",
      newEntryPolicy: "reduced",
      routingReasonLabel: `혼합·전환 — 중간대(−${TREND_BEATS_RANGE_MIN_GAP}<Δ<${RANGE_BEATS_TREND_MIN_GAP}) — 축소·관망`
    };
  }

  if (marketMode === "RANGE") {
    return {
      activeEngine: "RANGE",
      newEntryPolicy: "full",
      routingReasonLabel: "RANGE 우세 — 횡보 엔진 단독 활성"
    };
  }

  if (marketMode === "TREND") {
    return {
      activeEngine: "TREND",
      newEntryPolicy: "full",
      routingReasonLabel: "TREND 우세 — 돌파·추세 엔진 단독 활성"
    };
  }

  const idle: PaperEngineRoutingKind = "IDLE";
  return {
    activeEngine: idle,
    newEntryPolicy: "paused",
    routingReasonLabel: "모드 미정 — 관망"
  };
}

/**
 * BTC 레짐 탐지 + 스냅샷 건전성으로 시장 모드를 고정 스키마로 산출한다.
 */
export function evaluateMarketModeSelector(input: ModeSelectorInput): MarketModeSelectorOutput {
  const { regimeDetection, fetchedAt, snapshotCount, errorCount } = input;
  const vol = clamp01(input.volatilityProxy ?? 0.5);
  const sessionProfile = utcSessionProfile(fetchedAt);
  const dataDegraded = errorCount > 0 || snapshotCount === 0;

  const raw = regimeDetection.regime;
  const amb = regimeDetection.isAmbiguous === true;

  let marketMode: PaperMarketMode;
  let modeReasonLabel: string;
  let marketModeScore: number;
  let rangeConfidence: number;
  let trendConfidence: number;

  if (dataDegraded) {
    marketMode = "NO_TRADE";
    modeReasonLabel = "스냅샷 미완·오류로 모드 판단 보류";
    marketModeScore = 40;
    rangeConfidence = 0.2;
    trendConfidence = 0.2;
  } else if (raw === "NO_TRADE") {
    marketMode = "NO_TRADE";
    modeReasonLabel =
      typeof regimeDetection.detail.reason === "string"
        ? regimeDetection.detail.reason
        : "NO_TRADE 레짐";
    marketModeScore = 35 + Math.round((1 - vol) * 15);
    rangeConfidence = 0.25;
    trendConfidence = 0.25;
  } else if (raw === "RANGE") {
    if (amb) {
      marketMode = "TRANSITION";
      modeReasonLabel = "횡보 구간이나 경계 모호(전환 구간)";
    } else {
      marketMode = "RANGE";
      modeReasonLabel = "박스권 반복·추세 지속성 낮음";
    }
    marketModeScore = 55 + Math.round((1 - vol) * 25);
    rangeConfidence = 0.55 + (1 - vol) * 0.25;
    trendConfidence = 0.2 + vol * 0.15;
  } else {
    if (amb) {
      marketMode = "MIXED";
      modeReasonLabel = "추세 성분과 혼재(혼합)";
    } else {
      marketMode = "TREND";
      modeReasonLabel = "방향성·돌파 성분 우세";
    }
    marketModeScore = 58 + Math.round(vol * 22);
    trendConfidence = 0.55 + vol * 0.3;
    rangeConfidence = 0.25 + (1 - vol) * 0.15;
  }

  const riskThrottle = clamp01(
    dataDegraded ? 0.85 : raw === "NO_TRADE" ? 0.75 : vol * 0.55 + (amb ? 0.15 : 0)
  );

  const rc = clamp01(rangeConfidence);
  const tc = clamp01(trendConfidence);
  const routing = resolveRouting(marketMode, rc, tc);

  return {
    marketMode,
    marketModeScore: Math.min(100, Math.max(0, marketModeScore)),
    rangeConfidence: rc,
    trendConfidence: tc,
    sessionProfile,
    riskThrottle,
    modeReasonLabel,
    routing
  };
}
