/** UI display logic cases for External Market Context monitor labels. */

function mapExternalDirection(score, reliability, weight) {
  const insufficient =
    reliability === 0 || (typeof weight === "number" && Number.isFinite(weight) && weight < 0.35);
  if (insufficient) {
    return { label: "외부 데이터 부족 / 중립", key: "insufficient", insufficient: true };
  }
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return { label: "—", key: "unknown", insufficient: false };
  }
  if (score >= 0.5) return { label: "롱 강한 우호", key: "long_strong", insufficient: false };
  if (score >= 0.15) return { label: "롱 우호", key: "long", insufficient: false };
  if (score > -0.15) return { label: "중립", key: "neutral", insufficient: false };
  if (score > -0.5) return { label: "숏 우호", key: "short", insufficient: false };
  return { label: "숏 강한 우호", key: "short_strong", insufficient: false };
}

function buildExternalMarketSummary(ctx, dir) {
  if (!ctx || ctx.external_market_context_fetch_enabled !== true) {
    return "외부시장 데이터 수집이 비활성 상태입니다. 엔진 설정(EXTERNAL_MARKET_CONTEXT_FETCH_ENABLED) 확인이 필요합니다.";
  }
  if (dir.insufficient) {
    return "외부 데이터가 부족해 방향 판단을 중립으로 처리하고 있습니다.";
  }
  const shadowSuffix =
    ctx.external_market_context_shadow_mode !== false ||
    ctx.external_market_context_enabled !== true ||
    ctx.trading_impact === "none" ||
    ctx.external_context_applied !== true
      ? " 아직 관찰 전용이라 실제 주문에는 반영되지 않습니다."
      : "";

  switch (dir.key) {
    case "long":
      return `현재 외부시장 환경은 롱 포지션에 다소 우호적입니다.${shadowSuffix}`;
    case "long_strong":
      return `현재 외부시장 환경은 롱 포지션에 강하게 우호적입니다.${shadowSuffix}`;
    case "short":
      return `현재 외부시장 환경은 숏 포지션에 다소 우호적입니다.${shadowSuffix}`;
    case "short_strong":
      return `현재 외부시장 환경은 숏 포지션에 강하게 우호적입니다.${shadowSuffix}`;
    case "neutral":
      return "현재 외부시장 환경은 롱·숏 어느 한쪽에도 뚜렷하게 우호적이지 않습니다.";
    default:
      return "현재 외부시장 환경을 표시할 수 없습니다.";
  }
}

function shadowBadges(ctx) {
  const fetchOn = ctx.external_market_context_fetch_enabled === true;
  const enabled = ctx.external_market_context_enabled === true;
  const shadow = ctx.external_market_context_shadow_mode !== false;
  const badges = [];
  if (!fetchOn) badges.push("데이터 수집 비활성");
  if (fetchOn && (!enabled || shadow)) badges.push("관찰 전용");
  if (fetchOn && (!enabled || shadow || ctx.trading_impact === "none")) badges.push("실거래 영향 없음");
  return badges;
}

const shadowCtx = {
  external_market_context_fetch_enabled: true,
  external_market_context_enabled: false,
  external_market_context_shadow_mode: true,
  trading_impact: "none",
  external_context_applied: false
};

const relOk = { reliability: 0.85, weight: 0.6 };

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function run() {
  assertEq(mapExternalDirection(0.34, relOk.reliability, relOk.weight).label, "롱 우호", "A positive");
  assertEq(mapExternalDirection(0.55, relOk.reliability, relOk.weight).label, "롱 강한 우호", "B strong positive");
  assertEq(mapExternalDirection(-0.3, relOk.reliability, relOk.weight).label, "숏 우호", "C negative");
  assertEq(mapExternalDirection(-0.6, relOk.reliability, relOk.weight).label, "숏 강한 우호", "D strong negative");
  assertEq(mapExternalDirection(0.05, relOk.reliability, relOk.weight).label, "중립", "E neutral");
  assertEq(mapExternalDirection(0.4, 0, 0.6).label, "외부 데이터 부족 / 중립", "F reliability=0");
  assertEq(
    buildExternalMarketSummary({ external_market_context_fetch_enabled: false }, { insufficient: false, key: "long" }),
    "외부시장 데이터 수집이 비활성 상태입니다. 엔진 설정(EXTERNAL_MARKET_CONTEXT_FETCH_ENABLED) 확인이 필요합니다.",
    "G fetch off"
  );
  const badges = shadowBadges(shadowCtx);
  assertEq(badges.includes("관찰 전용"), true, "H shadow badge");
  assertEq(badges.includes("실거래 영향 없음"), true, "H impact badge");
  assertEq(
    buildExternalMarketSummary(shadowCtx, mapExternalDirection(0.34, 0.85, 0.6)).includes("관찰 전용"),
    true,
    "summary shadow suffix"
  );
  console.log("emc-display-cases: ALL PASS");
}

run();
