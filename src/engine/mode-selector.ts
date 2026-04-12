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
  /** 최근 1시간 TREND 스위칭(청산) 횟수 — 전환 구간 정책용 */
  recentTrendSwitchCount1h?: number;
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

function refineMixedTransition(
  base: EngineRoutingDecision,
  marketMode: PaperMarketMode,
  gap: number,
  ctx: Readonly<{
    vol: number;
    sessionProfile: string;
    recentTrendSwitchCount1h: number;
    fetchedAt: number;
  }>
): EngineRoutingDecision {
  if (marketMode !== "MIXED" && marketMode !== "TRANSITION") return base;

  if (ctx.recentTrendSwitchCount1h >= 4) {
    return {
      activeEngine: "IDLE",
      newEntryPolicy: "paused",
      routingReasonLabel: "전환 구간 · 최근 스위칭 잦음 — 관망",
      probeEntryOnly: false
    };
  }

  if (base.newEntryPolicy === "paused" && base.activeEngine === "IDLE") {
    return { ...base, probeEntryOnly: false };
  }

  let probe = false;
  const tags: string[] = [];
  if (ctx.vol >= 0.66) {
    probe = true;
    tags.push("변동↑ 소형만");
  }
  if (ctx.sessionProfile === "asia_quiet" && Math.abs(gap) < 0.12) {
    probe = true;
    tags.push("저유동·경계 협소");
  }
  const uh = new Date(ctx.fetchedAt).getUTCHours();
  if ((ctx.sessionProfile === "eu_overlap" || (uh >= 17 && uh <= 21)) && ctx.vol > 0.48) {
    probe = true;
    tags.push("저녁·전환");
  }

  const extra = tags.length > 0 ? ` · ${tags.join(" · ")}` : "";
  return {
    ...base,
    routingReasonLabel: base.routingReasonLabel + extra,
    probeEntryOnly: probe
  };
}

function resolveRouting(
  marketMode: PaperMarketMode,
  rangeConfidence: number,
  trendConfidence: number,
  ctx: Readonly<{
    vol: number;
    sessionProfile: string;
    recentTrendSwitchCount1h: number;
    fetchedAt: number;
  }>
): EngineRoutingDecision {
  const rc = rangeConfidence;
  const tc = trendConfidence;
  const gap = rc - tc;

  if (marketMode === "NO_TRADE") {
    return {
      activeEngine: "IDLE",
      newEntryPolicy: "paused",
      routingReasonLabel: "거래 보류 구간"
    };
  }

  if (marketMode === "MIXED" || marketMode === "TRANSITION") {
    let branch: EngineRoutingDecision;
    if (Math.abs(gap) < MIXED_AMBIGUITY_DELTA) {
      branch = {
        activeEngine: "IDLE",
        newEntryPolicy: "paused",
        routingReasonLabel: "혼합·전환 — 신뢰도 차이 좁음 — 관망"
      };
    } else if (gap >= RANGE_BEATS_TREND_MIN_GAP) {
      branch = {
        activeEngine: "RANGE",
        newEntryPolicy: "reduced",
        routingReasonLabel: "혼합·전환 — 횡보 쪽 우세 — 축소만"
      };
    } else if (gap <= -TREND_BEATS_RANGE_MIN_GAP) {
      branch = {
        activeEngine: "TREND",
        newEntryPolicy: "reduced",
        routingReasonLabel: "혼합·전환 — 추세 쪽 우세 — 축소만"
      };
    } else {
      branch = {
        activeEngine: "IDLE",
        newEntryPolicy: "reduced",
        routingReasonLabel: "혼합·전환 — 중간대 — 소형만"
      };
    }
    return refineMixedTransition(branch, marketMode, gap, ctx);
  }

  if (marketMode === "RANGE") {
    return {
      activeEngine: "RANGE",
      newEntryPolicy: "full",
      routingReasonLabel: "횡보 우세 — RANGE"
    };
  }

  if (marketMode === "TREND") {
    return {
      activeEngine: "TREND",
      newEntryPolicy: "full",
      routingReasonLabel: "추세 우세 — TREND"
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
  const routing = resolveRouting(marketMode, rc, tc, {
    vol,
    sessionProfile,
    recentTrendSwitchCount1h: input.recentTrendSwitchCount1h ?? 0,
    fetchedAt
  });

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
