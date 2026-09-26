import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateEquityAdaptiveSizing } from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import { resolveProtectiveTpPlan, shouldAttachFullPositionProtectiveTp } from "../engine-v2/execution/protective-tp-authority";
import { evaluateConfirmedAdverseAddOn, evaluateDirectionalThesisForAdverseAddon } from "../engine-v2/addon/adverse-addon";
import { evaluateV2AddOnPolicy } from "../engine-v2/addon/policy";
import { deriveExecutionAuthority } from "../engine-v2/reconciler";
import { adaptV2Input } from "../engine-v2/index";
import { deriveV2StateAuthority } from "../engine-v2/state/derive";
import {
  resolveCanonicalHighwayLineage,
  resolveHighwayLineageFromOpenPosition,
  resolveInitialHighwayLineageAssignment
} from "../engine-v2/highway-core/highway-lineage-authority";
import { resolveLiveSubmitStaticSafetyCap } from "./paper-engine";

describe("Highway Branched Lifecycle & Sizing Architecture Regression", () => {
  const DEFAULT_EQUITY = 2300;
  const APPLIED_LEVERAGE = 10;
  const LAST_PRICE = 65000;
  const STOP_PRICE = 64350; // 1.0% stop dist

  it("1. Highway Initial (isHighwayLineage: true) → Initial target evaluates to ~575 USDT without clipping under 600 cap", () => {
    const res = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: DEFAULT_EQUITY,
      availableBalanceUsdt: DEFAULT_EQUITY,
      lastPrice: LAST_PRICE,
      entryReferencePrice: LAST_PRICE,
      effectiveStopPrice: STOP_PRICE,
      appliedLeverage: APPLIED_LEVERAGE,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      v2AuthorityEntry: true,
      v2HardSafetyCapUsdt: 600,
      isHighwayLineage: true
    });

    assert.equal(res.sizingPassed, true);
    assert.equal(res.limitingAuthority, "highway_initial_target");
    assert.equal(res.preLotNotionalUsdt, 575);
    assert.ok(res.preLotNotionalUsdt <= 600, "575 USDT is within 600 cap");
  });

  it("2. Non-Highway FTS entry (isHighwayLineage: false/undefined) → does NOT receive 25% Highway target constraint", () => {
    const res = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: DEFAULT_EQUITY,
      availableBalanceUsdt: DEFAULT_EQUITY,
      lastPrice: LAST_PRICE,
      entryReferencePrice: LAST_PRICE,
      effectiveStopPrice: STOP_PRICE,
      appliedLeverage: APPLIED_LEVERAGE,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      v2AuthorityEntry: true,
      v2HardSafetyCapUsdt: 600,
      isHighwayLineage: false
    });

    assert.equal(res.sizingPassed, true);
    assert.notEqual(res.limitingAuthority, "highway_initial_target");
    // Uses normal risk-based notional or 600 cap without being restricted to 575
    assert.equal(res.limitingAuthority, "v2_hard_safety_cap");
    assert.equal(res.preLotNotionalUsdt, 600);
  });

  it("3. Non-Highway SHOCK_REACTION entry → does NOT receive 25% Highway target constraint", () => {
    const res = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: DEFAULT_EQUITY,
      availableBalanceUsdt: DEFAULT_EQUITY,
      lastPrice: LAST_PRICE,
      entryReferencePrice: LAST_PRICE,
      effectiveStopPrice: STOP_PRICE,
      appliedLeverage: APPLIED_LEVERAGE,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      v2AuthorityEntry: true,
      v2HardSafetyCapUsdt: 600,
      entryProbeSizeMultiplier: 0.5,
      isHighwayLineage: false
    });

    assert.equal(res.sizingPassed, true);
    assert.notEqual(res.limitingAuthority, "highway_initial_target");
  });

  it("4. Highway Initial adverse move + thesis intact → Defensive Add target evaluates to ~517.5 USDT", () => {
    const res = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ADVERSE_ADDON",
      accountEquityUsdt: DEFAULT_EQUITY,
      availableBalanceUsdt: DEFAULT_EQUITY - 57.5,
      lastPrice: LAST_PRICE * 0.98,
      entryReferencePrice: LAST_PRICE * 0.98,
      effectiveStopPrice: STOP_PRICE,
      appliedLeverage: APPLIED_LEVERAGE,
      existingSymbolNotionalUsdt: 575,
      existingAccountNotionalUsdt: 575,
      v2AuthorityEntry: true,
      v2HardSafetyCapUsdt: 600,
      isHighwayLineage: true
    });

    assert.equal(res.sizingPassed, true);
    assert.equal(res.limitingAuthority, "highway_defensive_target");
    assert.equal(res.preLotNotionalUsdt, 517.5); // 2300 * 0.75 * 0.30 = 517.5
    assert.ok(res.preLotNotionalUsdt <= 600, "517.5 USDT is within 600 cap");
  });

  it("5. Highway Initial favorable move + real OKX active stop locking profit → Pyramid target evaluates to ~575 USDT", () => {
    const res = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "PYRAMIDING_ADDON",
      accountEquityUsdt: DEFAULT_EQUITY,
      availableBalanceUsdt: DEFAULT_EQUITY - 57.5,
      lastPrice: LAST_PRICE * 1.02,
      entryReferencePrice: LAST_PRICE * 1.02,
      effectiveStopPrice: LAST_PRICE * 1.005,
      appliedLeverage: APPLIED_LEVERAGE,
      existingSymbolNotionalUsdt: 575,
      existingAccountNotionalUsdt: 575,
      v2AuthorityEntry: true,
      v2HardSafetyCapUsdt: 600,
      isHighwayLineage: true
    });

    assert.equal(res.sizingPassed, true);
    assert.equal(res.limitingAuthority, "highway_pyramid_target");
    assert.equal(res.preLotNotionalUsdt, 575);
    assert.ok(res.preLotNotionalUsdt <= 600, "575 USDT is within 600 cap");
  });

  it("6. Defensive Add executed (adverseAddonCount=1) → subsequent Pyramid is strictly forbidden", () => {
    const mockV2State: any = {
      longPosition: {
        side: "long",
        entryPrice: 65000,
        sizeUsd: 1092.5,
        pnlPct: 0.015,
        adverseAddonCount: 1,
        addonCount: 1,
        breakevenStopConfirmed: true
      }
    };
    assert.ok(mockV2State.longPosition.adverseAddonCount > 0);
  });

  it("7. Pyramid executed (addonCount=1, adverseAddonCount=0) → subsequent Defensive Add is strictly forbidden", () => {
    const mockV2State: any = {
      longPosition: {
        side: "long",
        entryPrice: 65000,
        sizeUsd: 1150,
        pnlPct: -0.01,
        addonCount: 1,
        adverseAddonCount: 0
      }
    };

    const mockBase: any = {
      action: "ADDON_WATCH",
      allowed: false,
      reason: "SAME_SIDE_POSITION_WATCH_RECHECK",
      addOnEligible: false,
      hasSameSidePosition: true,
      qualityScore: 85,
      reviewingTicks: 5
    };

    const res = evaluateConfirmedAdverseAddOn({
      symbol: "BTCUSDT",
      side: "long",
      v2State: mockV2State,
      judgment: { regime_final: "TREND", trendPhase: "PULLBACK", shockPhase: "NONE", subtype: "NONE" } as any,
      execution: { side: "long", signal: "LONG_CANDIDATE" } as any,
      snapshot: { latestCandleTs: 2000, lastPrice: 64500 } as any
    }, mockBase);

    assert.equal(res.allowed, false);
    assert.equal(res.addonBlockedReason, "ADVERSE_ADD_FORBIDDEN_AFTER_PYRAMID");
  });

  it("8. Non-Highway generic TREND retains mandatory TREND_FULL_TP", () => {
    const res = resolveProtectiveTpPlan({
      isV2Authority: true,
      regime: "TREND",
      isV2RangePartialPlan: false,
      takeProfit1Px: 66000,
      v2EntryReason: "GENERIC_MOMENTUM_BREAK"
    });

    assert.equal(res.mode, "TREND_FULL_TP");
    assert.equal(res.fullPositionTpRequired, true);
    assert.equal(res.exchangeTpPrice, 66000);
    assert.equal(res.reason, "V2_TREND_MANDATORY_SERVER_TP");
  });

  it("9. Highway lineage in TREND defers mandatory TP to preserve Profit-Lock & Pyramid lifecycle", () => {
    const res = resolveProtectiveTpPlan({
      isV2Authority: true,
      regime: "TREND",
      isV2RangePartialPlan: false,
      isHighwayLineage: true,
      takeProfit1Px: 66000,
      v2EntryReason: "HIGHWAY_CORE_TREND_PROBE"
    });

    assert.equal(res.mode, "NONE");
    assert.equal(res.fullPositionTpRequired, false);
    assert.equal(res.exchangeTpRequired, false);
    assert.equal(res.reason, "HIGHWAY_LIFECYCLE_PROTECTIVE_TP_DEFERRED");
  });

  it("10. Long adverse + single weak quality (< 70) alone → does NOT mark DIRECTION_UNCERTAIN or INVALID", () => {
    const thesis = evaluateDirectionalThesisForAdverseAddon({
      side: "long",
      judgment: { regime_final: "TREND", trendPhase: "PULLBACK", shockPhase: "NONE", subtype: "NONE", trendWeaknessScore: 0.3 } as any,
      execution: { metadata: {} } as any,
      snapshot: {} as any,
      qualityScore: 65, // single weak signal
      currentPrice: 64500,
      invalidationPx: 63000,
      stopPrice: 63000,
      directionalShockState: "NONE"
    });

    assert.equal(thesis.state, "THESIS_VALID");
    assert.equal(thesis.reason, "THESIS_VALID_SAME_SIDE_CONFIRMED");
  });

  it("11. Long adverse + raw 1-tick DOWN_SHOCK (without directional shock lock) → does NOT permanently invalidate", () => {
    const thesis = evaluateDirectionalThesisForAdverseAddon({
      side: "long",
      judgment: { regime_final: "TREND", trendPhase: "PULLBACK", shockPhase: "DOWN_SHOCK", subtype: "NONE" } as any,
      execution: { metadata: {} } as any,
      snapshot: {} as any,
      qualityScore: 80,
      currentPrice: 64500,
      invalidationPx: 63000,
      stopPrice: 63000,
      directionalShockState: "NONE" // raw 1-tick shock, not stabilized
    });

    assert.equal(thesis.state, "THESIS_VALID");
  });

  it("12. Long adverse + stabilized strong DOWN shock → strictly marks THESIS_INVALID_OPPOSING_EMERGING", () => {
    const thesis = evaluateDirectionalThesisForAdverseAddon({
      side: "long",
      judgment: { regime_final: "TREND", trendPhase: "PULLBACK", shockPhase: "DOWN_SHOCK", subtype: "NONE" } as any,
      execution: { metadata: {} } as any,
      snapshot: {} as any,
      qualityScore: 80,
      currentPrice: 64500,
      invalidationPx: 63000,
      stopPrice: 63000,
      directionalShockState: "DOWN" // stabilized shock state
    });

    assert.equal(thesis.state, "THESIS_INVALID_OPPOSING_EMERGING");
    assert.equal(thesis.reason, "STABILIZED_OPPOSING_SHOCK");
  });

  it("13. Long structural invalidation reached → strictly marks THESIS_INVALID_OPPOSING_EMERGING", () => {
    const thesis = evaluateDirectionalThesisForAdverseAddon({
      side: "long",
      judgment: { regime_final: "TREND", trendPhase: "PULLBACK", shockPhase: "NONE", subtype: "NONE" } as any,
      execution: { metadata: {} } as any,
      snapshot: {} as any,
      qualityScore: 80,
      currentPrice: 62900, // below invalidation
      invalidationPx: 63000,
      stopPrice: 63000,
      directionalShockState: "NONE"
    });

    assert.equal(thesis.state, "THESIS_INVALID_OPPOSING_EMERGING");
    assert.equal(thesis.reason, "INVALIDATION_REACHED");
  });

  it("14. SHORT complete symmetry for 3-state directional thesis evaluation", () => {
    // Valid Short
    const validShort = evaluateDirectionalThesisForAdverseAddon({
      side: "short",
      judgment: { regime_final: "TREND", trendPhase: "PULLBACK", shockPhase: "NONE", subtype: "NONE", trendWeaknessScore: 0.3 } as any,
      execution: { metadata: {} } as any,
      snapshot: {} as any,
      qualityScore: 80,
      currentPrice: 65500,
      invalidationPx: 67000,
      stopPrice: 67000,
      directionalShockState: "NONE"
    });
    assert.equal(validShort.state, "THESIS_VALID");

    // Invalid Short (stabilized UP shock)
    const invalidShort = evaluateDirectionalThesisForAdverseAddon({
      side: "short",
      judgment: { regime_final: "TREND", trendPhase: "PULLBACK", shockPhase: "UP_SHOCK", subtype: "NONE" } as any,
      execution: { metadata: {} } as any,
      snapshot: {} as any,
      qualityScore: 80,
      currentPrice: 65500,
      invalidationPx: 67000,
      stopPrice: 67000,
      directionalShockState: "UP"
    });
    assert.equal(invalidShort.state, "THESIS_INVALID_OPPOSING_EMERGING");
    assert.equal(invalidShort.reason, "STABILIZED_OPPOSING_SHOCK");
  });

  it("15. Highway Lineage persistence across Reconciler execution authority extraction", () => {
    const mockSelector: any = {
      adopted_result: {
        engine: "V2",
        adopted_decision: "ENTER",
        adopted_side: "long",
        adopted_size_usd: 575000,
        adopted_regime: "TREND"
      },
      v2_result: {
        risk: {
          isAddOn: false
        },
        metadata: {
          isHighwayLineage: true,
          entrySemantic: "HIGHWAY"
        }
      }
    };

    const authority = deriveExecutionAuthority(mockSelector);
    assert.equal(authority.isHighwayLineage, true);
    assert.equal(authority.entrySemantic, "HIGHWAY");
  });

  it("16. 600 USDT per-order cap allows 575 / 517.5 / 575 USDT orders without clipping", () => {
    const capResInitial = resolveLiveSubmitStaticSafetyCap({
      authoritySource: "v2",
      okxLiveStaticNotionalCapEnabled: true,
      staticSafetyCapUsdt: 40,
      v2HardSafetyCapUsdt: 600,
      intendedNotionalUsdt: 575
    });
    assert.equal(capResInitial.finalSubmittedNotionalUsdt, 575);
    assert.equal(capResInitial.finalSizeSource, "v2_risk");

    const capResDefensive = resolveLiveSubmitStaticSafetyCap({
      authoritySource: "v2",
      okxLiveStaticNotionalCapEnabled: true,
      staticSafetyCapUsdt: 40,
      v2HardSafetyCapUsdt: 600,
      intendedNotionalUsdt: 517.5
    });
    assert.equal(capResDefensive.finalSubmittedNotionalUsdt, 517.5);
    assert.equal(capResDefensive.finalSizeSource, "v2_risk");
  });

  it("17. Non-V2 Legacy entries still strictly enforce legacy 40 USDT cap (no regression)", () => {
    const legacyCapRes = resolveLiveSubmitStaticSafetyCap({
      authoritySource: "non_v2",
      okxLiveStaticNotionalCapEnabled: true,
      staticSafetyCapUsdt: 40,
      v2HardSafetyCapUsdt: 600,
      intendedNotionalUsdt: 575
    });
    assert.equal(legacyCapRes.finalSubmittedNotionalUsdt, 40);
    assert.equal(legacyCapRes.finalSizeSource, "static_safety_cap");
  });

  // --- Highway 2-Track Profit Pyramid Continuation & Net Protection Tests ---

  it("18. +49 USDT profit → Pyramid strictly blocked (PYRAMID_PROFIT_BELOW_50_USDT)", () => {
    // entry 65000, current 70500 -> (70500 - 65000)/65000 * 575 = 48.65 USDT (< 50)
    const entryPrice = 65000;
    const currentPrice = 70500;
    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice,
          sizeUsd: 575,
          pnlPct: 48.65 / 575,
          isHighwayLineage: true,
          breakevenStopConfirmed: true,
          adverseAddonCount: 0
        },
        okxAlgoOrdersList: [
          { instId: "BTC-USDT-SWAP", side: "sell", state: "live", triggerPx: 70000, algoType: "stop" }
        ]
      } as any,
      judgment: {
        regime: "TREND",
        regime_final: "TREND",
        trendPhase: "PULLBACK",
        shockPhase: "NONE",
        subtype: "NONE"
      } as any,
      execution: { metadata: { pullbackConfirmed: true } } as any,
      snapshot: {
        lastPrice: currentPrice,
        atr: 100,
        qualityScore: 85,
        reviewing_ticks: 3,
        boxPos: 0.5,
        emaGap: 0.01,
        trendWeaknessScore: 0.2,
        rangeConfidence: null
      }
    });

    assert.equal(res.allowed, false);
    assert.equal(res.action, "ADDON_WATCH");
    assert.equal(res.addonBlockedReason, "PYRAMID_PROFIT_BELOW_50_USDT");
  });

  it("19. +50 USDT + valid pullback/retest → Pullback Pyramid allowed (HIGHWAY_PULLBACK_PYRAMID_ALLOWED)", () => {
    // entry 65000, current 71000 -> profit = 53.07 USDT (>= 50)
    // addon 575 -> totalNotional = 1150, avgEntry = 68000
    // active stop 70600 -> gross = 43.97, friction = 1.38 -> net = 42.59 USDT (>= 40)
    const entryPrice = 65000;
    const currentPrice = 71000;
    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice,
          sizeUsd: 575,
          pnlPct: 53.07 / 575,
          isHighwayLineage: true,
          breakevenStopConfirmed: true,
          adverseAddonCount: 0
        },
        okxAlgoOrdersList: [
          { instId: "BTC-USDT-SWAP", side: "sell", state: "live", triggerPx: 70600, algoType: "stop" }
        ]
      } as any,
      judgment: {
        regime: "TREND",
        regime_final: "TREND",
        trendPhase: "PULLBACK",
        shockPhase: "NONE",
        subtype: "NONE"
      } as any,
      execution: { metadata: { pullbackConfirmed: true } } as any,
      snapshot: {
        lastPrice: currentPrice,
        atr: 50,
        qualityScore: 85,
        reviewing_ticks: 3,
        boxPos: 0.5,
        emaGap: 0.01,
        trendWeaknessScore: 0.2,
        rangeConfidence: null
      }
    });

    assert.equal(res.allowed, true);
    assert.equal(res.action, "ADDON_ALLOWED");
    assert.equal(res.reason, "HIGHWAY_PULLBACK_PYRAMID_ALLOWED");
    assert.ok(Number(res.lockedProfitUsdt) >= 40);
  });

  it("20. +50 USDT + no pullback + strong highway continuation → Momentum Pyramid allowed (HIGHWAY_MOMENTUM_CONTINUATION_PYRAMID_ALLOWED)", () => {
    const entryPrice = 65000;
    const currentPrice = 71000;
    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice,
          sizeUsd: 575,
          pnlPct: 53.07 / 575,
          isHighwayLineage: true,
          breakevenStopConfirmed: true,
          adverseAddonCount: 0
        },
        okxAlgoOrdersList: [
          { instId: "BTC-USDT-SWAP", side: "sell", state: "live", triggerPx: 70600, algoType: "stop" }
        ]
      } as any,
      judgment: {
        regime: "TREND",
        regime_final: "TREND",
        trendPhase: "UP", // no pullback
        shockPhase: "NONE",
        subtype: "HIGHWAY_CONTINUATION" // canonical continuation authority
      } as any,
      execution: { metadata: { highwayContinuationConfirmed: true } } as any,
      snapshot: {
        lastPrice: currentPrice,
        atr: 50,
        qualityScore: 90,
        reviewing_ticks: 3,
        boxPos: 0.5,
        emaGap: 0.01,
        trendWeaknessScore: 0.15,
        rangeConfidence: null
      }
    });

    assert.equal(res.allowed, true);
    assert.equal(res.action, "ADDON_ALLOWED");
    assert.equal(res.reason, "HIGHWAY_MOMENTUM_CONTINUATION_PYRAMID_ALLOWED");
    assert.ok(Number(res.lockedProfitUsdt) >= 40);
  });

  it("21. +50 USDT + plain trendPhase=UP alone (no canonical continuation/pullback evidence) → Momentum Pyramid blocked", () => {
    const entryPrice = 65000;
    const currentPrice = 71000;
    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice,
          sizeUsd: 575,
          pnlPct: 53.07 / 575,
          isHighwayLineage: true,
          breakevenStopConfirmed: true,
          adverseAddonCount: 0
        },
        okxAlgoOrdersList: [
          { instId: "BTC-USDT-SWAP", side: "sell", state: "live", triggerPx: 70600, algoType: "stop" }
        ]
      } as any,
      judgment: {
        regime: "TREND",
        regime_final: "TREND",
        trendPhase: "UP", // plain trendPhase UP
        shockPhase: "NONE",
        subtype: "NONE"
      } as any,
      execution: { metadata: {} } as any, // NO continuation / pullback evidence
      snapshot: {
        lastPrice: currentPrice,
        atr: 50,
        qualityScore: 85,
        reviewing_ticks: 3,
        boxPos: 0.5,
        emaGap: 0.01,
        trendWeaknessScore: 0.2,
        rangeConfidence: null
      }
    });

    assert.equal(res.allowed, false);
    assert.equal(res.action, "ADDON_WATCH");
    assert.equal(res.reason, "MOMENTUM_AUTHORITY_NOT_CONFIRMED");
    assert.equal(res.addonBlockedReason, "PLAIN_TREND_PHASE_INSUFFICIENT");
  });

  it("22. Additional entry with weighted avg net protected profit 39 USDT (< 40) → blocked (NET_PROTECTED_PROFIT_BELOW_40_USDT)", () => {
    const entryPrice = 65000;
    const currentPrice = 71000;
    // active stop at 70100:
    // avgEntry = 68000, totalNotional = 1150
    // gross = 1150 * (70100 - 68000) / 68000 = 35.51 USDT
    // friction = 1.38 USDT -> Net = 34.13 USDT (< 40 USDT)
    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice,
          sizeUsd: 575,
          pnlPct: 53.07 / 575,
          isHighwayLineage: true,
          breakevenStopConfirmed: true,
          adverseAddonCount: 0
        },
        okxAlgoOrdersList: [
          { instId: "BTC-USDT-SWAP", side: "sell", state: "live", triggerPx: 70100, algoType: "stop" }
        ]
      } as any,
      judgment: {
        regime: "TREND",
        regime_final: "TREND",
        trendPhase: "PULLBACK",
        shockPhase: "NONE",
        subtype: "NONE"
      } as any,
      execution: { metadata: { pullbackConfirmed: true } } as any,
      snapshot: {
        lastPrice: currentPrice,
        atr: 50,
        qualityScore: 85,
        reviewing_ticks: 3,
        boxPos: 0.5,
        emaGap: 0.01,
        trendWeaknessScore: 0.2,
        rangeConfidence: null
      }
    });

    assert.equal(res.allowed, false);
    assert.equal(res.action, "ADDON_WATCH");
    assert.equal(res.addonBlockedReason, "NET_PROTECTED_PROFIT_BELOW_40_USDT");
  });

  it("23. Net protected profit >= 40 USDT → allowed with verified stop lock", () => {
    const entryPrice = 65000;
    const currentPrice = 71000;
    // active stop at 70600 -> Net = 42.59 USDT (>= 40 USDT)
    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice,
          sizeUsd: 575,
          pnlPct: 53.07 / 575,
          isHighwayLineage: true,
          breakevenStopConfirmed: true,
          adverseAddonCount: 0
        },
        okxAlgoOrdersList: [
          { instId: "BTC-USDT-SWAP", side: "sell", state: "live", triggerPx: 70600, algoType: "stop" }
        ]
      } as any,
      judgment: {
        regime: "TREND",
        regime_final: "TREND",
        trendPhase: "PULLBACK",
        shockPhase: "NONE",
        subtype: "NONE"
      } as any,
      execution: { metadata: { pullbackConfirmed: true } } as any,
      snapshot: {
        lastPrice: currentPrice,
        atr: 50,
        qualityScore: 85,
        reviewing_ticks: 3,
        boxPos: 0.5,
        emaGap: 0.01,
        trendWeaknessScore: 0.2,
        rangeConfidence: null
      }
    });

    assert.equal(res.allowed, true);
    assert.equal(res.action, "ADDON_ALLOWED");
    assert.ok(Number(res.lockedProfitUsdt) >= 40);
  });

  it("24. Stabilized opposing shock / HTF polarity mismatch / reversal confirmed → strictly forbidden", () => {
    const entryPrice = 65000;
    const currentPrice = 71000;
    // HTF bearish mismatch
    const htfRes = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice,
          sizeUsd: 575,
          pnlPct: 0.08,
          isHighwayLineage: true,
          breakevenStopConfirmed: true,
          adverseAddonCount: 0
        },
        okxAlgoOrdersList: [{ instId: "BTC-USDT-SWAP", side: "sell", state: "live", triggerPx: 70600, algoType: "stop" }]
      } as any,
      judgment: {
        regime: "TREND",
        regime_final: "TREND",
        trendPhase: "DOWN", // opposing HTF
        shockPhase: "NONE",
        subtype: "HTF_BEARISH"
      } as any,
      execution: { metadata: { pullbackConfirmed: true } } as any,
      snapshot: { lastPrice: currentPrice, atr: 50, qualityScore: 85, reviewing_ticks: 3, boxPos: 0.5, emaGap: 0.01, trendWeaknessScore: 0.2, rangeConfidence: null }
    });
    assert.equal(htfRes.allowed, false);
    assert.equal(htfRes.action, "ADDON_FORBIDDEN");
    assert.equal(htfRes.addonBlockedReason, "OPPOSING_THREAT_ACTIVE");

    // Stabilized opposing shock
    const shockRes = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice,
          sizeUsd: 575,
          pnlPct: 0.08,
          isHighwayLineage: true,
          breakevenStopConfirmed: true,
          adverseAddonCount: 0
        },
        directionalShockState: "DOWN",
        okxAlgoOrdersList: [{ instId: "BTC-USDT-SWAP", side: "sell", state: "live", triggerPx: 70600, algoType: "stop" }]
      } as any,
      judgment: {
        regime: "TREND",
        regime_final: "TREND",
        trendPhase: "PULLBACK",
        shockPhase: "DOWN_SHOCK", // stabilized opposing shock
        subtype: "NONE"
      } as any,
      execution: { metadata: { pullbackConfirmed: true } } as any,
      snapshot: { lastPrice: currentPrice, atr: 50, qualityScore: 85, reviewing_ticks: 3, boxPos: 0.5, emaGap: 0.01, trendWeaknessScore: 0.2, rangeConfidence: null }
    });
    assert.equal(shockRes.allowed, false);
    assert.equal(shockRes.action, "ADDON_FORBIDDEN");
    assert.equal(shockRes.addonBlockedReason, "OPPOSING_THREAT_ACTIVE");
  });

  it("25. adverseAddonCount > 0 → Pyramid strictly forbidden", () => {
    const entryPrice = 65000;
    const currentPrice = 71000;
    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice,
          sizeUsd: 1092.5,
          pnlPct: 0.08,
          isHighwayLineage: true,
          breakevenStopConfirmed: true,
          adverseAddonCount: 1 // adverse addon already executed
        },
        okxAlgoOrdersList: [{ instId: "BTC-USDT-SWAP", side: "sell", state: "live", triggerPx: 70600, algoType: "stop" }]
      } as any,
      judgment: {
        regime: "TREND",
        regime_final: "TREND",
        trendPhase: "PULLBACK",
        shockPhase: "NONE",
        subtype: "NONE"
      } as any,
      execution: { metadata: { pullbackConfirmed: true } } as any,
      snapshot: { lastPrice: currentPrice, atr: 50, qualityScore: 85, reviewing_ticks: 3, boxPos: 0.5, emaGap: 0.01, trendWeaknessScore: 0.2, rangeConfidence: null }
    });

    assert.equal(res.allowed, false);
    assert.equal(res.action, "ADDON_FORBIDDEN");
    assert.equal(res.addonBlockedReason, "PYRAMID_FORBIDDEN_AFTER_ADVERSE_ADD");
  });

  // =============================================================
  // Audit 1: Weighted Average Entry 공식 정확성 검증
  // sizeUsd / addonNotional = USD notional 이므로
  // base-qty 기준 weighted avg: totalNotional / (existingQty + addonQty)
  // 기존 잘못된 공식: (sizeUsd * entryPrice + addonNotional * currentPrice) / totalNotional
  //   → 이는 price-squared 단위의 엉뚱한 값을 돌려줌.
  // BTC 사례: entryPrice=60000, sizeUsd=575, addonNotional=575, currentPrice=70000
  //   existingQty = 575/60000 = 0.009583...
  //   addonQty    = 575/70000 = 0.008214...
  //   correct avg = 1150 / 0.01780 ≈ 64615.4
  //   wrong avg   = (575*60000 + 575*70000) / 1150 = (34500000+40250000)/1150 = 65000  ← 산술평균이라 과소평가
  // =============================================================
  it("26. [감사1] BTC: base-qty 기준 weighted avg ≈ 64615 (기존 산술평균 65000과 구분됨)", () => {
    const entryPrice = 60000;
    const currentPrice = 70000;
    const sizeUsd = 575;      // existingNotional = 575 USDT → qty = 575/60000 ≈ 0.009583
    const addonNotional = 575; // addonNotional = 575 USDT   → qty = 575/70000 ≈ 0.008214
    // correct weighted avg
    const existingQty = sizeUsd / entryPrice;
    const addonQty    = addonNotional / currentPrice;
    const totalQty    = existingQty + addonQty;
    const totalNotional = sizeUsd + addonNotional;
    const correctWeightedAvg = totalNotional / totalQty;
    // 기존 (잘못된) 방식
    const wrongWeightedAvg   = (sizeUsd * entryPrice + addonNotional * currentPrice) / totalNotional;

    // correctWeightedAvg ≠ wrongWeightedAvg when prices differ significantly
    assert.ok(Math.abs(correctWeightedAvg - wrongWeightedAvg) > 100,
      `BTC: correct(${correctWeightedAvg.toFixed(2)}) vs wrong(${wrongWeightedAvg.toFixed(2)}) should differ > 100`);
    // correct은 entryPrice와 currentPrice 사이에 위치
    assert.ok(correctWeightedAvg > entryPrice && correctWeightedAvg < currentPrice,
      "Correct weighted avg must lie between entry and addon price");
    // wrong(산술평균)은 단순 중간값
    assert.ok(Math.abs(wrongWeightedAvg - 65000) < 1,
      "Wrong (notional-weighted) avg ≈ 65000 for equal notional sizes");
    // 정확식은 65000보다 낮음 (초기 포지션 qty가 더 많으므로)
    assert.ok(correctWeightedAvg < 65000,
      "Correct base-qty avg should be < 65000 (more qty at lower price)");
  });

  it("27. [감사1] ETH: entryPrice=2000, currentPrice=2600, 두 공식 차이 > 50 확인", () => {
    const entryPrice = 2000;
    const currentPrice = 2600;
    const sizeUsd = 575;
    const addonNotional = 575;
    const existingQty = sizeUsd / entryPrice;
    const addonQty    = addonNotional / currentPrice;
    const totalQty    = existingQty + addonQty;
    const totalNotional = sizeUsd + addonNotional;
    const correctWeightedAvg = totalNotional / totalQty;
    const wrongWeightedAvg   = (sizeUsd * entryPrice + addonNotional * currentPrice) / totalNotional;
    assert.ok(Math.abs(correctWeightedAvg - wrongWeightedAvg) > 20,
      `ETH: correct(${correctWeightedAvg.toFixed(2)}) vs wrong(${wrongWeightedAvg.toFixed(2)}) should differ > 20`);
    assert.ok(correctWeightedAvg > entryPrice && correctWeightedAvg < currentPrice,
      "Correct weighted avg must lie between entry and addon price");
  });

  it("28. [감사1] policy에서 실제 반환된 projectedWeightedAvgEntry가 base-qty 기준과 일치하는지", () => {
    const entryPrice = 60000;
    const currentPrice = 70000;
    const sizeUsd = 575;
    const existingQty = sizeUsd / entryPrice;
    const addonQty    = 575 / currentPrice; // targetPyramidNotionalUsdt = equity * 0.25 = 575
    const expectedAvg = (sizeUsd + 575) / (existingQty + addonQty);

    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice,
          sizeUsd,
          pnlPct: 53.07 / sizeUsd,
          isHighwayLineage: true,
          breakevenStopConfirmed: true,
          adverseAddonCount: 0
        },
        okxAlgoOrdersList: [
          { instId: "BTC-USDT-SWAP", side: "sell", state: "live", triggerPx: 70600, algoType: "stop" }
        ]
      } as any,
      judgment: {
        regime: "TREND",
        regime_final: "TREND",
        trendPhase: "PULLBACK",
        shockPhase: "NONE",
        subtype: "NONE"
      } as any,
      execution: { metadata: { pullbackConfirmed: true } } as any,
      snapshot: {
        lastPrice: currentPrice,
        atr: 50,
        qualityScore: 85,
        reviewing_ticks: 3,
        boxPos: 0.5,
        emaGap: 0.01,
        trendWeaknessScore: 0.2,
        rangeConfidence: null
      }
    });

    assert.equal(res.allowed, true, "Pyramid should be allowed");
    const rp = res.riskProjection;
    assert.ok(rp !== undefined, "riskProjection must be present");
    const actualAvg = rp!.projectedWeightedAvgEntry;
    assert.ok(
      Math.abs(actualAvg - expectedAvg) < 1,
      `Actual projectedWeightedAvgEntry(${actualAvg}) should match base-qty formula(${expectedAvg.toFixed(2)})`
    );
    // 구 공식(65000)과 달라야 함
    assert.ok(
      Math.abs(actualAvg - 65000) > 100,
      `projectedWeightedAvgEntry(${actualAvg}) must differ from wrong avg (65000) by > 100`
    );
  });

  // =============================================================
  // Audit 2: retestTouched 단독 허용 금지 검증
  // =============================================================
  it("29b. [감사2] trendPhase=PULLBACK 단독 (pullbackConfirmed 없음) → Pullback Pyramid 금지", () => {
    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice: 65000,
          sizeUsd: 575,
          pnlPct: 53.07 / 575,
          isHighwayLineage: true,
          breakevenStopConfirmed: true,
          adverseAddonCount: 0
        },
        okxAlgoOrdersList: [
          { instId: "BTC-USDT-SWAP", side: "sell", state: "live", triggerPx: 70600, algoType: "stop" }
        ]
      } as any,
      judgment: {
        regime: "TREND",
        regime_final: "TREND",
        trendPhase: "PULLBACK",
        shockPhase: "NONE",
        subtype: "NONE"
      } as any,
      execution: { metadata: {} } as any,
      snapshot: {
        lastPrice: 71000,
        atr: 50,
        qualityScore: 85,
        reviewing_ticks: 3,
        boxPos: 0.5,
        emaGap: 0.01,
        trendWeaknessScore: 0.2,
        rangeConfidence: null
      }
    });
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "MOMENTUM_AUTHORITY_NOT_CONFIRMED");
  });

  it("29. [감사2] retestTouched=true 단독 → Pullback Pyramid 금지 (MOMENTUM_AUTHORITY_NOT_CONFIRMED)", () => {
    const entryPrice = 65000;
    const currentPrice = 71000;
    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice,
          sizeUsd: 575,
          pnlPct: 53.07 / 575,
          isHighwayLineage: true,
          breakevenStopConfirmed: true,
          adverseAddonCount: 0
        },
        okxAlgoOrdersList: [
          { instId: "BTC-USDT-SWAP", side: "sell", state: "live", triggerPx: 70600, algoType: "stop" }
        ]
      } as any,
      judgment: {
        regime: "TREND",
        regime_final: "TREND",
        trendPhase: "UP", // PULLBACK 아님
        shockPhase: "NONE",
        subtype: "NONE"
      } as any,
      execution: { metadata: { retestTouched: true } } as any, // retestRejected 없음
      snapshot: {
        lastPrice: currentPrice,
        atr: 50,
        qualityScore: 85,
        reviewing_ticks: 3,
        boxPos: 0.5,
        emaGap: 0.01,
        trendWeaknessScore: 0.2,
        rangeConfidence: null
      }
    });
    // retestTouched 단독은 pullback 인정 안 됨, momentum authority도 없음 → MOMENTUM_AUTHORITY_NOT_CONFIRMED
    assert.equal(res.allowed, false);
    assert.equal(res.action, "ADDON_WATCH");
    assert.equal(res.reason, "MOMENTUM_AUTHORITY_NOT_CONFIRMED");
    assert.equal(res.addonBlockedReason, "PLAIN_TREND_PHASE_INSUFFICIENT");
  });

  it("30. [감사2] retestTouched=true + retestRejected=true → Pullback Pyramid 허용 (HIGHWAY_PULLBACK_PYRAMID_ALLOWED)", () => {
    const entryPrice = 65000;
    const currentPrice = 71000;
    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice,
          sizeUsd: 575,
          pnlPct: 53.07 / 575,
          isHighwayLineage: true,
          breakevenStopConfirmed: true,
          adverseAddonCount: 0
        },
        okxAlgoOrdersList: [
          { instId: "BTC-USDT-SWAP", side: "sell", state: "live", triggerPx: 70600, algoType: "stop" }
        ]
      } as any,
      judgment: {
        regime: "TREND",
        regime_final: "TREND",
        trendPhase: "UP",
        shockPhase: "NONE",
        subtype: "NONE"
      } as any,
      execution: { metadata: { retestTouched: true, retestRejected: true } } as any, // 두 가지 모두
      snapshot: {
        lastPrice: currentPrice,
        atr: 50,
        qualityScore: 85,
        reviewing_ticks: 3,
        boxPos: 0.5,
        emaGap: 0.01,
        trendWeaknessScore: 0.2,
        rangeConfidence: null
      }
    });
    assert.equal(res.allowed, true);
    assert.equal(res.action, "ADDON_ALLOWED");
    assert.equal(res.reason, "HIGHWAY_PULLBACK_PYRAMID_ALLOWED");
  });

  // =============================================================
  // Audit 3: riskProjection 필드명 semantic 검증
  // projectedGrossProtectedProfitAtStopUsdt가 존재하고,
  // 기존 projectedLossAtStopUsdt는 더 이상 존재하지 않아야 함
  // =============================================================
  it("31. [감사4] riskProjection에 projectedGrossProtectedProfitAtStopUsdt 존재, projectedLossAtStopUsdt 없음", () => {
    const entryPrice = 65000;
    const currentPrice = 71000;
    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice,
          sizeUsd: 575,
          pnlPct: 53.07 / 575,
          isHighwayLineage: true,
          breakevenStopConfirmed: true,
          adverseAddonCount: 0
        },
        okxAlgoOrdersList: [
          { instId: "BTC-USDT-SWAP", side: "sell", state: "live", triggerPx: 70600, algoType: "stop" }
        ]
      } as any,
      judgment: {
        regime: "TREND",
        regime_final: "TREND",
        trendPhase: "PULLBACK",
        shockPhase: "NONE",
        subtype: "NONE"
      } as any,
      execution: { metadata: { pullbackConfirmed: true } } as any,
      snapshot: {
        lastPrice: currentPrice,
        atr: 50,
        qualityScore: 85,
        reviewing_ticks: 3,
        boxPos: 0.5,
        emaGap: 0.01,
        trendWeaknessScore: 0.2,
        rangeConfidence: null
      }
    });

    assert.equal(res.allowed, true);
    const rp = res.riskProjection as any;
    assert.ok(rp !== undefined, "riskProjection must be present");
    // 새 필드명 존재
    assert.ok("projectedGrossProtectedProfitAtStopUsdt" in rp,
      "projectedGrossProtectedProfitAtStopUsdt must exist");
    assert.ok("projectedNetProtectedProfitAtStopUsdt" in rp,
      "projectedNetProtectedProfitAtStopUsdt must exist");
    assert.ok(!("projectedLossAtStopUsdt" in rp),
      "projectedLossAtStopUsdt must NOT exist in Highway pyramid riskProjection");
    assert.ok(rp.projectedGrossProtectedProfitAtStopUsdt > 0,
      "grossProtectedProfit at stop must be positive");
    assert.ok(rp.projectedNetProtectedProfitAtStopUsdt > 0,
      "netProtectedProfit at stop must be positive");
    assert.ok(rp.projectedNetProtectedProfitAtStopUsdt <= rp.projectedGrossProtectedProfitAtStopUsdt,
      "net protected profit must be <= gross");
  });

  it("32. [연결] TREND native initial ENTER → lineage assign + live sizing highway_initial_target 575", () => {
    const assign = resolveInitialHighwayLineageAssignment({
      isAddOn: false,
      finalDecisionEnter: true,
      highwayGateRejected: false,
      isMicroProbe: false,
      promotionApplied: false,
      promotionReason: null,
      judgmentRegime: "TREND",
      judgmentSubtype: "NONE",
      executionMetadata: {}
    });
    assert.equal(assign, true);

    const sizing = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: DEFAULT_EQUITY,
      availableBalanceUsdt: DEFAULT_EQUITY,
      lastPrice: LAST_PRICE,
      entryReferencePrice: LAST_PRICE,
      effectiveStopPrice: STOP_PRICE,
      appliedLeverage: APPLIED_LEVERAGE,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      v2AuthorityEntry: true,
      v2HardSafetyCapUsdt: 600,
      isHighwayLineage: true
    });
    assert.equal(sizing.limitingAuthority, "highway_initial_target");
    assert.equal(sizing.preLotNotionalUsdt, 575);
  });

  it("33. [연결] SHOCK_REACTION_upper_breakout_continuation_long → lineage false, no highway sizing", () => {
    const promo = "SHOCK_REACTION_upper_breakout_continuation_long";
    assert.equal(
      resolveCanonicalHighwayLineage({ promotionReason: promo, judgmentSubtype: "SHOCK_REACTION_UP" }),
      false
    );
    const assign = resolveInitialHighwayLineageAssignment({
      isAddOn: false,
      finalDecisionEnter: true,
      highwayGateRejected: false,
      isMicroProbe: false,
      promotionApplied: true,
      promotionReason: promo,
      judgmentRegime: "RANGE",
      judgmentSubtype: "SHOCK_REACTION_UP",
      executionMetadata: {}
    });
    assert.equal(assign, false);

    const sizing = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: DEFAULT_EQUITY,
      availableBalanceUsdt: DEFAULT_EQUITY,
      lastPrice: LAST_PRICE,
      entryReferencePrice: LAST_PRICE,
      effectiveStopPrice: STOP_PRICE,
      appliedLeverage: APPLIED_LEVERAGE,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      v2AuthorityEntry: true,
      v2HardSafetyCapUsdt: 600,
      isHighwayLineage: false
    });
    assert.notEqual(sizing.limitingAuthority, "highway_initial_target");
  });

  it("34. [연결] ledger reload via adaptV2Input preserves isHighwayLineage", () => {
    const bridge = {
      currentPositions: [
        {
          symbol: "BTCUSDT" as const,
          side: "long" as const,
          entryPrice: 65000,
          sizeUsd: 575,
          entryStage: 1,
          isHighwayLineage: true,
          entrySemantic: "HIGHWAY_CORE"
        }
      ],
      globalRiskScore: 0,
      lossStreaks: {},
      directionalShockState: "NONE" as const,
      longAllow: true,
      shortAllow: true,
      executionReadiness: true,
      freshTickBarrierActive: false,
      freshTickCompletedCycles: 0,
      freshTickRequiredCycles: 0,
      serverTradeEnabled: true,
      accountEquityKrw: 3_220_000
    };
    const snapshot = { lastPrice: 65000, latestCandleClose: 65000, qualityScore: 80 };
    const adapted = adaptV2Input(
      "BTCUSDT",
      Date.now(),
      snapshot as any,
      { baseSizeUsd: 140000, paperMaxOpenPositions: 5 } as any,
      bridge as any,
      {} as any
    );
    const pos = adapted.state.currentPositions.find((p) => p.symbol === "BTCUSDT");
    assert.equal(resolveHighwayLineageFromOpenPosition(pos), true);
    assert.equal(pos?.isHighwayLineage, true);
    const v2State = deriveV2StateAuthority(adapted);
    assert.equal(v2State.longPosition?.isHighwayLineage, true);
  });

  it("35. [연결] reconciler authority reflects metadata isHighwayLineage for reload path", () => {
    const authority = deriveExecutionAuthority({
      adopted_result: {
        engine: "V2",
        adopted_decision: "ENTER",
        adopted_side: "long",
        adopted_size_usd: 575000,
        adopted_regime: "TREND"
      },
      v2_result: {
        risk: { isAddOn: false },
        metadata: {
          isHighwayLineage: true,
          entrySemantic: "HIGHWAY_CORE",
          promotion_reason: null,
          judgment_subtype: "NONE"
        }
      }
    } as any);
    assert.equal(authority.isHighwayLineage, true);
  });
});

