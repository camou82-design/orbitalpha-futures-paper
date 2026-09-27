import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateEquityAdaptiveSizing,
  highwayMarginTargetToNotionalUsdt
} from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import { resolveProtectiveTpPlan, shouldAttachFullPositionProtectiveTp } from "../engine-v2/execution/protective-tp-authority";
import { evaluateConfirmedAdverseAddOn, evaluateDirectionalThesisForAdverseAddon } from "../engine-v2/addon/adverse-addon";
import { evaluateV2AddOnPolicy } from "../engine-v2/addon/policy";
import { deriveExecutionAuthority, deriveExecutionAuthorityFromEnvelope } from "../engine-v2/reconciler";
import { classifyEntryOrderExecution, LOW_VOLATILITY_ENTRY_ATR_REL_MAX } from "../engine-v2/execution/entry-order-type";
import { adaptV2Input } from "../engine-v2/index";
import { deriveV2StateAuthority } from "../engine-v2/state/derive";
import {
  resolveCanonicalHighwayLineage,
  resolveHighwayCoreEntryProvenanceEligible,
  resolveHighwayLineageFromOpenPosition,
  resolveInitialHighwayLineageAssignment,
  stampHighwayCoreEntryProvenance
} from "../engine-v2/highway-core/highway-lineage-authority";
import { HighwayTrendState } from "../models/types";
import type { HighwayDirectionalAuthority } from "../engine-v2/highway-core/highway-directional-authority";
import { resolveLiveSubmitStaticSafetyCap } from "./paper-engine";
import { resolveHighwayLifecycleStage } from "../engine-v2/highway-core/highway-lifecycle-authority";

describe("Highway Branched Lifecycle & Sizing Architecture Regression", () => {
  const DEFAULT_EQUITY = 2300;
  const APPLIED_LEVERAGE = 10;
  const LAST_PRICE = 65000;
  const STOP_PRICE = 64350; // 1.0% stop dist
  const mockStrongUpHighwayAuth = (): HighwayDirectionalAuthority => ({
    state: "STRONG_UP",
    strongUp: true,
    strongDown: false,
    ema10: 65100,
    ema20: 64900,
    ema60: 64500,
    ema10SlopeBps: 1,
    ema20SlopeBps: 0.2,
    emaGap: 0.002,
    earlyRecoveryUpEligible: false,
    earlyRecoveryDownEligible: false,
    details: {
      priceAboveEma10: true,
      priceAboveEma20: true,
      priceAboveEma60: true,
      ema10Above20: true,
      highwayTrendState: HighwayTrendState.VALID,
      highwayAlignScore: 0.95,
      lastClosedClose: 65000
    }
  });

  const mockWeakTrendHighwayAuth = (): HighwayDirectionalAuthority => ({
    state: "NEUTRAL",
    strongUp: false,
    strongDown: false,
    ema10: 65000,
    ema20: 64950,
    ema60: 64800,
    ema10SlopeBps: 0.1,
    ema20SlopeBps: 0,
    emaGap: 0.0005,
    earlyRecoveryUpEligible: false,
    earlyRecoveryDownEligible: false,
    details: {
      priceAboveEma10: true,
      priceAboveEma20: true,
      priceAboveEma60: true,
      ema10Above20: true,
      highwayTrendState: HighwayTrendState.WEAK,
      highwayAlignScore: 0.7,
      lastClosedClose: 65000
    }
  });

  it("1. Highway Initial → 25% equity margin × 10x = 5750 USDT notional (600 cap clips submit)", () => {
    const targetMargin = DEFAULT_EQUITY * 0.25;
    const targetNotional = highwayMarginTargetToNotionalUsdt(targetMargin, APPLIED_LEVERAGE);
    assert.equal(targetNotional, 5750);

    const uncapped = evaluateEquityAdaptiveSizing({
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
      v2HardSafetyCapUsdt: 20_000,
      isHighwayLineage: true
    });
    assert.equal(uncapped.highwayTargetMarginUsdt, targetMargin);
    assert.equal(uncapped.highwayTargetNotionalUsdt, targetNotional);
    assert.equal(uncapped.limitingAuthority, "risk_based_notional");
    assert.ok(uncapped.preLotNotionalUsdt < targetNotional);
    assert.ok(uncapped.preLotNotionalUsdt > 0);

    const capped = evaluateEquityAdaptiveSizing({
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
    assert.equal(capped.sizingPassed, true);
    assert.equal(capped.safetyCapUnit, "margin");
    assert.equal(capped.effectiveSafetyCapNotionalUsdt, 6000);
    assert.notEqual(capped.limitingAuthority, "v2_hard_safety_cap");
    assert.ok(capped.preLotNotionalUsdt > 600);
  });

  it("43. [runtime cap audit] equity 2378 @ 10x Highway initial — equity_initial_cap binds at 5469.4 not 600", () => {
    const equity = 2378;
    const leverage = 10;
    const margin = equity * 0.25;
    const targetNotional = highwayMarginTargetToNotionalUsdt(margin, leverage);
    const equityInitialCapUsdt = equity * 2.3;
    assert.ok(Math.abs(margin - 594.5) < 0.01);
    assert.ok(Math.abs(targetNotional - 5945) < 1);
    assert.ok(Math.abs(equityInitialCapUsdt - 5469.4) < 0.1);

    const res = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: equity,
      availableBalanceUsdt: equity,
      lastPrice: LAST_PRICE,
      entryReferencePrice: LAST_PRICE,
      effectiveStopPrice: 64700,
      appliedLeverage: leverage,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      v2AuthorityEntry: true,
      v2HardSafetyCapUsdt: 600,
      isHighwayLineage: true
    });

    assert.equal(res.highwayTargetMarginUsdt, margin);
    assert.ok(Math.abs((res.highwayTargetNotionalUsdt ?? 0) - targetNotional) < 1);
    assert.equal(res.safetyCapRawValue, 600);
    assert.equal(res.safetyCapUnit, "margin");
    assert.equal(res.effectiveSafetyCapNotionalUsdt, 6000);
    assert.ok(res.riskBasedNotionalUsdt > targetNotional);
    assert.equal(res.limitingAuthority, "equity_initial_cap");
    assert.ok(Math.abs(res.preLotNotionalUsdt - equityInitialCapUsdt) < 0.01);
    assert.ok(Math.abs(res.finalOrderNotionalUsdt - equityInitialCapUsdt) < 1);
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

  it("4. Highway defensive add → margin 22.5% equity, notional 5175 at 10x", () => {
    const targetMargin = DEFAULT_EQUITY * 0.75 * 0.30;
    assert.equal(targetMargin, 517.5);
    const targetNotional = highwayMarginTargetToNotionalUsdt(targetMargin, APPLIED_LEVERAGE);
    assert.equal(targetNotional, 5175);

    const res = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ADVERSE_ADDON",
      accountEquityUsdt: DEFAULT_EQUITY,
      availableBalanceUsdt: DEFAULT_EQUITY,
      lastPrice: LAST_PRICE,
      entryReferencePrice: LAST_PRICE,
      effectiveStopPrice: STOP_PRICE,
      appliedLeverage: APPLIED_LEVERAGE,
      existingSymbolNotionalUsdt: 600,
      existingAccountNotionalUsdt: 600,
      v2AuthorityEntry: true,
      v2HardSafetyCapUsdt: 20_000,
      isHighwayLineage: true
    });

    assert.equal(res.sizingPassed, true);
    assert.equal(res.highwayTargetMarginUsdt, targetMargin);
    assert.equal(res.highwayTargetNotionalUsdt, targetNotional);
    assert.equal(res.limitingAuthority, "highway_defensive_target");
    assert.equal(res.preLotNotionalUsdt, 5175);
  });

  it("5. Highway pyramid add → same 25% margin × leverage notional as initial (5750)", () => {
    const res = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "PYRAMIDING_ADDON",
      accountEquityUsdt: DEFAULT_EQUITY,
      availableBalanceUsdt: DEFAULT_EQUITY,
      lastPrice: LAST_PRICE,
      entryReferencePrice: LAST_PRICE,
      effectiveStopPrice: STOP_PRICE,
      appliedLeverage: APPLIED_LEVERAGE,
      existingSymbolNotionalUsdt: 600,
      existingAccountNotionalUsdt: 600,
      v2AuthorityEntry: true,
      v2HardSafetyCapUsdt: 20_000,
      isHighwayLineage: true
    });

    assert.equal(res.sizingPassed, true);
    assert.equal(res.highwayTargetMarginUsdt, DEFAULT_EQUITY * 0.25);
    assert.equal(res.highwayTargetNotionalUsdt, 5750);
    assert.equal(res.limitingAuthority, "account_open_risk_cap");
    assert.equal(res.preLotNotionalUsdt, 5175);
  });

  it("6. Defensive add with addonCount=1 adverseAddonCount=1 → stage DEFENSIVE not PYRAMID (CASE I)", () => {
    const resolved = resolveHighwayLifecycleStage({
      adverseAddonCount: 1,
      addonCount: 1,
      highwayDefensiveAddonExecuted: true,
      highwayLifecycleStage: "HIGHWAY_DEFENSIVE_ADVERSE"
    } as any);
    assert.equal(resolved.stage, "HIGHWAY_DEFENSIVE_ADVERSE");
    assert.notEqual(resolved.stage, "HIGHWAY_PROTECTED_PYRAMID");
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
    assert.equal(res.reason, "HIGHWAY_LIFECYCLE_HIGHWAY_INITIAL_PROTECTIVE_TP_DEFERRED");
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

  it("16. V2 submit cap: non-Highway 600 notional clips; Highway 600 margin → 6000 notional ceiling", () => {
    const genericV2 = resolveLiveSubmitStaticSafetyCap({
      authoritySource: "v2",
      okxLiveStaticNotionalCapEnabled: true,
      staticSafetyCapUsdt: 40,
      v2HardSafetyCapUsdt: 600,
      intendedNotionalUsdt: 5750,
      isHighwayLineage: false
    });
    assert.equal(genericV2.finalSubmittedNotionalUsdt, 600);
    assert.equal(genericV2.finalSizeSource, "v2_hard_safety_cap");

    const highwaySubmit = resolveLiveSubmitStaticSafetyCap({
      authoritySource: "v2",
      okxLiveStaticNotionalCapEnabled: true,
      staticSafetyCapUsdt: 40,
      v2HardSafetyCapUsdt: 600,
      intendedNotionalUsdt: 5945,
      isHighwayLineage: true,
      appliedLeverage: 10
    });
    assert.equal(highwaySubmit.finalSubmittedNotionalUsdt, 5945);
    assert.equal(highwaySubmit.finalSizeSource, "v2_risk");
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

  it("18. modest +USDT profit (below legacy 50 floor) + stop lock + continuation → pyramid allowed (CASE H)", () => {
    const entryPrice = 60000;
    const currentPrice = 64900;
    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice,
          sizeUsd: 575,
          pnlPct: 46.96 / 575,
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
        atr: 100,
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
    const riskBefore = Number((res.riskProjection as { riskBeforeAddonUsdt?: number })?.riskBeforeAddonUsdt);
    assert.ok(riskBefore < 50, "unrealized profit below removed 50 USDT fixed gate");
    assert.notEqual(res.addonBlockedReason, "PYRAMID_PROFIT_BELOW_50_USDT");
  });

  it("19. +50 USDT + valid pullback/retest → Pullback Pyramid allowed (HIGHWAY_PULLBACK_PYRAMID_ALLOWED)", () => {
    const entryPrice = 60000;
    const currentPrice = 70000;
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
    const entryPrice = 60000;
    const currentPrice = 70000;
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
    assert.equal(res.addonBlockedReason, "TREND_CONTINUATION_NOT_CONFIRMED");
  });

  it("22. Net protected profit below equity minimum floor → blocked (NET_PROTECTED_PROFIT_BELOW_MINIMUM)", () => {
    const entryPrice = 60000;
    const currentPrice = 70000;
    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 40000,
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
          { instId: "BTC-USDT-SWAP", side: "sell", state: "live", triggerPx: 64000, algoType: "stop" }
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
    assert.equal(res.addonBlockedReason, "NET_PROTECTED_PROFIT_BELOW_MINIMUM");
    assert.ok(Number(res.lockedProfitUsdt) < Math.max(0.5, 40000 * 0.0015));
  });

  it("23. Net protected profit >= equity minimum → allowed with verified stop lock", () => {
    const entryPrice = 60000;
    const currentPrice = 70000;
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

  it("25. CASE J: after defensive add, recovery + stop lock + continuation → protected pyramid allowed", () => {
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
          adverseAddonCount: 1,
          addonCount: 1,
          highwayDefensiveAddonExecuted: true,
          highwayLifecycleStage: "HIGHWAY_DEFENSIVE_ADVERSE"
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

    assert.equal(res.allowed, true);
    assert.equal(res.action, "ADDON_ALLOWED");
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
    const pyramidNotional = highwayMarginTargetToNotionalUsdt(2300 * 0.25, 10);
    assert.equal(pyramidNotional, 5750);
    const addonQty = pyramidNotional / currentPrice;
    const expectedAvg = (sizeUsd + pyramidNotional) / (existingQty + addonQty);

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
    assert.equal(res.addonBlockedReason, "TREND_CONTINUATION_NOT_CONFIRMED");
  });

  it("30. [감사2] retestTouched=true + retestRejected=true → Pullback Pyramid 허용 (HIGHWAY_PULLBACK_PYRAMID_ALLOWED)", () => {
    const entryPrice = 60000;
    const currentPrice = 70000;
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
    const entryPrice = 60000;
    const currentPrice = 70000;
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

  it("32. [연결] Highway Core evidence (v2EntryReason) → lineage assign + 25% margin → 5750 notional", () => {
    const assign = resolveInitialHighwayLineageAssignment({
      isAddOn: false,
      finalDecisionEnter: true,
      highwayGateRejected: false,
      isMicroProbe: false,
      promotionApplied: false,
      promotionReason: null,
      judgmentRegime: "TREND",
      judgmentSubtype: "NONE",
      executionMetadata: { v2EntryReason: "HIGHWAY_CORE_ENTRY" }
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
      v2HardSafetyCapUsdt: 20_000,
      isHighwayLineage: true
    });
    assert.equal(sizing.highwayTargetNotionalUsdt, 5750);
    assert.equal(sizing.highwayTargetMarginUsdt, DEFAULT_EQUITY * 0.25);
    assert.ok(sizing.preLotNotionalUsdt < 5750);
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

  it("35b. [연결] envelope authority preserves Highway lineage + v2EntryReason", () => {
    const authority = deriveExecutionAuthorityFromEnvelope({
      decision: "ENTER",
      side: "long",
      stageMarginKrw: 575000,
      baseStageMarginKrw: 575000,
      regime: "TREND",
      source: "v2",
      appliedLeverage: 10,
      entrySemantic: "HIGHWAY_CORE",
      isHighwayLineage: true,
      v2EntryReason: "HIGHWAY_CORE_ENTRY",
      limitingSizingAuthority: "highway_initial_target",
      invalidationPx: 90000,
      stopPrice: 90000
    } as any);
    assert.equal(authority.isHighwayLineage, true);
    assert.equal(authority.v2EntryReason, "HIGHWAY_CORE_ENTRY");
    assert.equal(authority.entrySemantic, "HIGHWAY_CORE");
  });

  it("35c. low-vol Highway/RANGE entry prefers maker-limit", () => {
    const cls = classifyEntryOrderExecution({
      promotionReason: "BREAKOUT_CONTINUATION",
      entrySubtype: "TREND_UP_CONTINUATION",
      preferMakerLimit: true
    });
    assert.equal(cls.executionStyle, "PASSIVE_LIMIT");
    assert.equal(cls.ordType, "limit");
    assert.ok(LOW_VOLATILITY_ENTRY_ATR_REL_MAX > 0);
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

  it("36. [lineage] generic TREND ENTER without Highway markers → assign false", () => {
    const assign = resolveInitialHighwayLineageAssignment({
      isAddOn: false,
      finalDecisionEnter: true,
      highwayGateRejected: false,
      isMicroProbe: false,
      promotionApplied: false,
      promotionReason: null,
      judgmentRegime: "TREND",
      judgmentSubtype: "TREND_MOMENTUM_HEALTHY",
      executionMetadata: { trend_provenance: "TREND_EXECUTOR_MOMENTUM" }
    });
    assert.equal(assign, false);
  });

  it("37. [lineage] generic TREND preserves non-HIGHWAY entrySemantic (no HIGHWAY_CORE stamp)", () => {
    const genericSemantic = "TREND_MOMENTUM_HEALTHY";
    assert.notEqual(genericSemantic, "HIGHWAY_CORE");
    const assign = resolveInitialHighwayLineageAssignment({
      isAddOn: false,
      finalDecisionEnter: true,
      highwayGateRejected: false,
      isMicroProbe: false,
      promotionApplied: false,
      promotionReason: null,
      judgmentRegime: "TREND",
      judgmentSubtype: "TREND_MOMENTUM_HEALTHY",
      executionMetadata: {},
      executionEntrySemantic: genericSemantic
    });
    assert.equal(assign, false);
    assert.notEqual(genericSemantic, "HIGHWAY_CORE");
  });

  it("38. [lineage] generic TREND sizing bridge → no highway_initial_target", () => {
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
      isHighwayLineage: assign
    });
    assert.notEqual(sizing.limitingAuthority, "highway_initial_target");
    assert.equal(sizing.preLotNotionalUsdt, 600);
  });

  it("39. [lineage] FAST_TREND_SHIFT → assign false even with Highway v2EntryReason", () => {
    const assign = resolveInitialHighwayLineageAssignment({
      isAddOn: false,
      finalDecisionEnter: true,
      highwayGateRejected: false,
      isMicroProbe: false,
      promotionApplied: false,
      promotionReason: null,
      judgmentRegime: "TREND",
      judgmentSubtype: "FAST_TREND_SHIFT",
      executionMetadata: { v2EntryReason: "HIGHWAY_CORE_ENTRY" }
    });
    assert.equal(assign, false);
  });

  it("40. [live-path] Highway Core gate+VALID+strongUp stamp → assign true → highway_initial_target 5750", () => {
    const eligible = resolveHighwayCoreEntryProvenanceEligible({
      initialEntryCandidate: true,
      highwayGateAllowed: true,
      highwayGateRejected: false,
      nativeTrendExecutor: true,
      promotionApplied: false,
      promotionReason: null,
      judgmentSubtype: "TREND_UP_CONTINUATION",
      executionEntrySemantic: null,
      side: "long",
      highwayDirectional: mockStrongUpHighwayAuth()
    });
    assert.equal(eligible, true);

    const execMeta: Record<string, unknown> = {};
    stampHighwayCoreEntryProvenance(execMeta);
    const assign = resolveInitialHighwayLineageAssignment({
      isAddOn: false,
      finalDecisionEnter: true,
      highwayGateRejected: false,
      isMicroProbe: false,
      promotionApplied: false,
      promotionReason: null,
      judgmentRegime: "TREND",
      judgmentSubtype: "TREND_UP_CONTINUATION",
      executionMetadata: execMeta,
      executionEntrySemantic: "HIGHWAY_CORE"
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
      v2HardSafetyCapUsdt: 20_000,
      isHighwayLineage: assign
    });
    assert.equal(sizing.highwayTargetNotionalUsdt, 5750);
    assert.ok(sizing.preLotNotionalUsdt < 5750);
  });

  it("41. [live-path] generic TREND (WEAK alignment) → provenance ineligible → assign false", () => {
    const eligible = resolveHighwayCoreEntryProvenanceEligible({
      initialEntryCandidate: true,
      highwayGateAllowed: true,
      highwayGateRejected: false,
      nativeTrendExecutor: true,
      promotionApplied: false,
      promotionReason: null,
      judgmentSubtype: "TREND_MOMENTUM_HEALTHY",
      executionEntrySemantic: null,
      side: "long",
      highwayDirectional: mockWeakTrendHighwayAuth()
    });
    assert.equal(eligible, false);
    const assign = resolveInitialHighwayLineageAssignment({
      isAddOn: false,
      finalDecisionEnter: true,
      highwayGateRejected: false,
      isMicroProbe: false,
      promotionApplied: false,
      promotionReason: null,
      judgmentRegime: "TREND",
      judgmentSubtype: "TREND_MOMENTUM_HEALTHY",
      executionMetadata: { trend_provenance: "TREND_EXECUTOR_MOMENTUM" }
    });
    assert.equal(assign, false);
  });

  it("42. [live-path] SHOCK_REACTION promotion → provenance ineligible", () => {
    const promo = "SHOCK_REACTION_upper_breakout_continuation_long";
    const eligible = resolveHighwayCoreEntryProvenanceEligible({
      initialEntryCandidate: true,
      highwayGateAllowed: true,
      highwayGateRejected: false,
      nativeTrendExecutor: true,
      promotionApplied: true,
      promotionReason: promo,
      judgmentSubtype: "SHOCK_REACTION_UP",
      executionEntrySemantic: null,
      side: "long",
      highwayDirectional: mockStrongUpHighwayAuth()
    });
    assert.equal(eligible, false);
  });

  it("lineage isolation: generic addonCount delta must not infer PROTECTED_PYRAMID stage", () => {
    const resolved = resolveHighwayLifecycleStage({
      addonCount: 1,
      adverseAddonCount: 0,
      isHighwayLineage: false,
      v2EntryReason: "GENERIC_MOMENTUM_BREAK",
      entrySemantic: "TREND_MOMENTUM"
    } as any);
    assert.equal(resolved.stage, "HIGHWAY_INITIAL");
    assert.notEqual(resolved.source, "ledger_inferred_pyramid_addon_delta");
  });

  it("CASE I: addonCount=1 + adverseAddonCount=1 → DEFENSIVE_ADVERSE stage", () => {
    const resolved = resolveHighwayLifecycleStage({
      addonCount: 1,
      adverseAddonCount: 1,
      highwayDefensiveAddonExecuted: true
    } as any);
    assert.equal(resolved.stage, "HIGHWAY_DEFENSIVE_ADVERSE");
    assert.equal(resolved.source, "ledger_highway_defensive_executed");
  });

  it("CASE K: after pyramid executed, slight negative pnl → stage stays PROTECTED_PYRAMID", () => {
    const resolved = resolveHighwayLifecycleStage({
      addonCount: 2,
      adverseAddonCount: 1,
      highwayProtectedPyramidExecuted: true,
      highwayPyramidAddonCount: 1,
      highwayLifecycleStage: "HIGHWAY_PROTECTED_PYRAMID",
      pnlPct: -0.01
    } as any);
    assert.equal(resolved.stage, "HIGHWAY_PROTECTED_PYRAMID");
  });

  it("CASE L: adaptV2Input rehydrate preserves highway lifecycle stage flags", () => {
    const bridge = {
      currentPositions: [
        {
          symbol: "BTCUSDT" as const,
          side: "long" as const,
          entryPrice: 65000,
          sizeUsd: 1092.5,
          entryStage: 2,
          isHighwayLineage: true,
          entrySemantic: "HIGHWAY_CORE",
          adverseAddonCount: 1,
          addonCount: 1,
          highwayDefensiveAddonExecuted: true,
          highwayLifecycleStage: "HIGHWAY_DEFENSIVE_ADVERSE" as const
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
    const adapted = adaptV2Input(
      "BTCUSDT",
      Date.now(),
      { lastPrice: 65000, latestCandleClose: 65000, qualityScore: 80 } as any,
      { baseSizeUsd: 140000, paperMaxOpenPositions: 5 } as any,
      bridge as any,
      {} as any
    );
    const pos = adapted.state.currentPositions.find((p) => p.symbol === "BTCUSDT");
    assert.equal(pos?.highwayLifecycleStage, "HIGHWAY_DEFENSIVE_ADVERSE");
    assert.equal(pos?.highwayDefensiveAddonExecuted, true);
    const v2State = deriveV2StateAuthority(adapted);
    assert.equal(
      resolveHighwayLifecycleStage(v2State.longPosition ?? undefined).stage,
      "HIGHWAY_DEFENSIVE_ADVERSE"
    );
  });

  it("CASE A: slight negative pnl → ledger stage stays INITIAL (not pnl-flipped DEFENSIVE)", () => {
    const resolved = resolveHighwayLifecycleStage({
      adverseAddonCount: 0,
      addonCount: 0,
      pnlPct: -0.01
    } as any);
    assert.equal(resolved.stage, "HIGHWAY_INITIAL");
    assert.equal(resolved.source, "ledger_initial");
  });

  it("CASE B: slight positive pnl → ledger stage stays INITIAL (not pnl-flipped PYRAMID)", () => {
    const resolved = resolveHighwayLifecycleStage({
      adverseAddonCount: 0,
      addonCount: 0,
      pnlPct: 0.02
    } as any);
    assert.equal(resolved.stage, "HIGHWAY_INITIAL");
    assert.equal(resolved.source, "ledger_initial");
  });

  it("CASE C: adverse addon executed → DEFENSIVE_ADVERSE", () => {
    const resolved = resolveHighwayLifecycleStage({ adverseAddonCount: 1, addonCount: 0 } as any);
    assert.equal(resolved.stage, "HIGHWAY_DEFENSIVE_ADVERSE");
    assert.equal(resolved.source, "ledger_adverse_addon_count");
  });

  it("CASE D: protected pyramid executed → PROTECTED_PYRAMID", () => {
    const resolved = resolveHighwayLifecycleStage({
      adverseAddonCount: 0,
      addonCount: 1,
      highwayProtectedPyramidExecuted: true,
      highwayPyramidAddonCount: 1
    } as any);
    assert.equal(resolved.stage, "HIGHWAY_PROTECTED_PYRAMID");
    assert.equal(resolved.source, "ledger_highway_pyramid_addon_count");
  });

  it("CASE G: Highway pyramid without protective stop → blocked", () => {
    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice: 60000,
          sizeUsd: 575,
          pnlPct: 0.08,
          isHighwayLineage: true,
          adverseAddonCount: 0
        },
        okxAlgoOrdersList: []
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
        lastPrice: 70000,
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
    assert.equal(res.addonBlockedReason, "PROTECTIVE_STOP_NOT_REGISTERED");
  });

  it("CASE E: Highway + TRANSITION → lifecycle bypasses TRANSITION_ADDON_FORBIDDEN", () => {
    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice: 65000,
          sizeUsd: 575,
          pnlPct: -0.02,
          isHighwayLineage: true,
          v2EntryReason: "HIGHWAY_CORE_ENTRY",
          adverseAddonCount: 0
        }
      } as any,
      judgment: {
        regime: "TRANSITION",
        regime_final: "TRANSITION",
        transitionPhase: "TREND_TO_RANGE",
        trendPhase: "PULLBACK",
        shockPhase: "NONE",
        subtype: "NONE",
        rangePhase: "NONE"
      } as any,
      execution: { metadata: {} } as any,
      snapshot: {
        lastPrice: 63700,
        atr: 120,
        qualityScore: 80,
        reviewing_ticks: 2,
        boxPos: 0.4,
        emaGap: 0.01,
        trendWeaknessScore: 0.25,
        rangeConfidence: null
      }
    });
    assert.notEqual(res.reason, "TRANSITION_ADDON_FORBIDDEN");
    assert.notEqual(res.evidence, "transition_addon_forbidden");
  });

  it("CASE F: Non-Highway + TRANSITION → TRANSITION_ADDON_FORBIDDEN", () => {
    const res = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      accountEquityUsd: 2300,
      v2State: {
        longPosition: {
          side: "long",
          entryPrice: 65000,
          sizeUsd: 575,
          pnlPct: 0.05,
          isHighwayLineage: false,
          v2EntryReason: "GENERIC_MOMENTUM_BREAK"
        }
      } as any,
      judgment: {
        regime: "TRANSITION",
        regime_final: "TRANSITION",
        transitionPhase: "TREND_TO_RANGE",
        trendPhase: "UP",
        shockPhase: "NONE",
        subtype: "NONE",
        rangePhase: "NONE"
      } as any,
      execution: { metadata: {} } as any,
      snapshot: {
        lastPrice: 68000,
        atr: 100,
        qualityScore: 85,
        reviewing_ticks: 3,
        boxPos: 0.5,
        emaGap: 0.01,
        trendWeaknessScore: 0.2,
        rangeConfidence: null
      }
    });
    assert.equal(res.reason, "TRANSITION_ADDON_FORBIDDEN");
    assert.equal(res.evidence, "transition_addon_forbidden");
  });

  it("44. non-Highway V2 keeps 600 gross notional safety cap (no regression)", () => {
    const res = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: 2378,
      availableBalanceUsdt: 2378,
      lastPrice: LAST_PRICE,
      entryReferencePrice: LAST_PRICE,
      effectiveStopPrice: STOP_PRICE,
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      v2AuthorityEntry: true,
      v2HardSafetyCapUsdt: 600,
      isHighwayLineage: false
    });
    assert.equal(res.safetyCapUnit, "notional");
    assert.equal(res.effectiveSafetyCapNotionalUsdt, 600);
    assert.equal(res.limitingAuthority, "v2_hard_safety_cap");
    assert.equal(res.preLotNotionalUsdt, 600);
  });
});

