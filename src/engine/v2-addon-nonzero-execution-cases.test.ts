import { evaluateV2AddOnPolicy } from "../engine-v2/addon/policy";
import { calculateRiskSizing } from "../engine-v2/risk-sizing/policy";
import { emitV2TradeLifecycleProof } from "../engine-v2/lifecycle/proof";
import {
  MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
  MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE,
  MAX_ADVERSE_ADDON_EQUITY_MULTIPLE
} from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import type { V2StateAuthority } from "../engine-v2/state/types";

function run(label: string, passed: boolean, detail: string): boolean {
  console.log(`[${label}] ${passed ? "PASS" : "FAIL"} — ${detail}`);
  return passed;
}

function baseV2State(overrides: Record<string, unknown> = {}): V2StateAuthority {
  return {
    longPosition: null,
    shortPosition: null,
    currentPositions: [],
    crashState: "",
    pumpState: "",
    accountEquityKrw: 1_400_000,
    directionalShockState: "NONE",
    longAllow: true,
    shortAllow: true,
    hasLongPosition: false,
    hasShortPosition: false,
    hasSameSidePosition: false,
    hasOppositeSidePosition: false,
    currentStage: 1,
    stateAuthoritySource: "v2",
    ...overrides
  } as unknown as V2StateAuthority;
}

export function runV2AddonNonzeroExecutionTests(): boolean {
  let ok = true;

  console.log("\n=== 1. RANGE EDGE REATTACK NONZERO NOTIONAL PROOF ===");
  {
    const accountEquityUsd = 1000;
    const accountEquityKrw = 1_400_000;
    const currentPrice = 95000;
    const atr = 500;
    const entryPrice = 95500;
    const sizeUsd = 200;

    const v2State = baseV2State({
      accountEquityKrw,
      currentStage: 1,
      hasShortPosition: true,
      hasSameSidePosition: true,
      shortPosition: {
        symbol: "BTCUSDT",
        side: "short",
        entryPrice,
        sizeUsd,
        entryStage: 1,
        pnlPct: 0.005,
        breakevenStopRequired: true,
        breakevenStopConfirmed: true,
        breakevenStopPrice: 95400
      }
    });

    const addOnPolicy = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "short",
      v2State,
      judgment: {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "NONE",
        shockPhase: "NONE",
        rangePhase: "UPPER",
        trendPhase: "NONE",
        transitionPhase: "NONE"
      } as any,
      execution: { signal: "SHORT_CANDIDATE", side: "short" } as any,
      snapshot: {
        qualityScore: 80,
        reviewing_ticks: 2,
        boxPos: 0.85,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.75,
        lastPrice: currentPrice,
        atr
      },
      accountEquityUsd,
      currentSymbolNotionalUsd: sizeUsd,
      currentGlobalNotionalUsd: sizeUsd
    });

    const policyAllowed = addOnPolicy.allowed === true;
    const hasRequestedNotional = (addOnPolicy.requestedAddonNotionalUsdt ?? 0) > 0;
    const hasMaxNotional = (addOnPolicy.addonMaxNotionalUsdt ?? 0) > 0;
    const notionalMatches = addOnPolicy.requestedAddonNotionalUsdt === addOnPolicy.addonMaxNotionalUsdt;

    ok = run(
      "RANGE Edge Reattack Returns Allowed with Positive Notional",
      policyAllowed && hasRequestedNotional && hasMaxNotional && notionalMatches,
      `allowed=${addOnPolicy.allowed}, reason=${addOnPolicy.reason}, maxNotional=${addOnPolicy.addonMaxNotionalUsdt}, requestedNotional=${addOnPolicy.requestedAddonNotionalUsdt}`
    ) && ok;

    // Verify dynamic equity / ATR risk sizing without arbitrary fixed USDT
    const stopDistance = atr * 2.2;
    const stopDistancePct = stopDistance / currentPrice;
    const expectedTargetRisk = accountEquityUsd * 0.01; // 1% risk
    const expectedRiskNotional = expectedTargetRisk / stopDistancePct;
    const symbolCap = accountEquityUsd * MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE - sizeUsd;
    const expectedAddonNotional = Math.min(expectedRiskNotional, symbolCap);

    ok = run(
      "RANGE Edge Reattack Dynamic Risk Calculation Matches Authority",
      Math.abs((addOnPolicy.addonMaxNotionalUsdt ?? 0) - expectedAddonNotional) < 1e-4,
      `calculated=${addOnPolicy.addonMaxNotionalUsdt}, expected=${expectedAddonNotional}`
    ) && ok;

    // Verify Risk-Sizing Policy produces non-zero stageMarginKrw
    const riskSizing = calculateRiskSizing(
      {
        regime: "RANGE",
        regime_final: "RANGE",
        subtype: "NONE",
        counter_trend_risk: false
      } as any,
      { level: "HIGH" } as any,
      { baseSizeIntent: 1.0, side: "short" } as any,
      {
        symbol: "BTCUSDT",
        config: { baseSizeUsd: 140000 },
        snapshot: { lastPrice: currentPrice, latestCandleClose: currentPrice, qualityScore: 80, emaGap: 0.004, rangeConfidence: 0.75, volatilityProxy: atr },
        state: {
          accountEquityKrw,
          maxUsableMarginKrw: accountEquityKrw,
          symbolExposureNotionalCapKrw: accountEquityKrw * MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
          exposureNotionalCapKrw: accountEquityKrw * MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE,
          currentStage: 1,
          isAddOn: true,
          addOnPolicyAllowed: true,
          finalAddonNotionalUsdt: addOnPolicy.addonMaxNotionalUsdt,
          directionalShockState: "NONE",
          shortAllow: true,
          currentPositions: [
            {
              symbol: "BTCUSDT",
              side: "short",
              entryStage: 1,
              sizeUsd,
              notionalUsd: sizeUsd,
              isV2Authority: true,
              strategyVersion: "v2"
            }
          ]
        }
      } as any
    );

    const sizingNotBlocked = riskSizing.isBlocked === false;
    const sizingNonZero = riskSizing.stageMarginKrw > 0;

    ok = run(
      "RANGE Edge Reattack Sizing Execution is Nonzero and Unblocked",
      sizingNotBlocked && sizingNonZero,
      `isBlocked=${riskSizing.isBlocked}, blockReason=${riskSizing.blockReason}, stageMarginKrw=${riskSizing.stageMarginKrw}`
    ) && ok;
  }

  console.log("\n=== 2. TREND PROFIT-FUNDED PYRAMID NONZERO NOTIONAL PROOF ===");
  {
    const accountEquityUsd = 1000;
    const accountEquityKrw = 1_400_000;
    const currentPrice = 96000;
    const entryPrice = 94000;
    const sizeUsd = 300;
    const atr = 400;

    const v2State = baseV2State({
      accountEquityKrw,
      currentStage: 1,
      hasLongPosition: true,
      hasSameSidePosition: true,
      longPosition: {
        symbol: "BTCUSDT",
        side: "long",
        entryPrice,
        sizeUsd,
        entryStage: 1,
        pnlPct: 0.021, // ~2.1% profit
        breakevenStopRequired: true,
        breakevenStopConfirmed: true,
        breakevenStopPrice: 95500
      }
    });

    const addOnPolicy = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      v2State,
      judgment: {
        regime: "TREND",
        regime_final: "TREND",
        subtype: "NONE",
        shockPhase: "NONE",
        rangePhase: "NONE",
        trendPhase: "UP",
        transitionPhase: "NONE",
        htf_entry_policy: "BOTH",
        counter_trend_risk: false
      } as any,
      execution: { signal: "LONG_CANDIDATE", side: "long" } as any,
      snapshot: {
        qualityScore: 88,
        reviewing_ticks: 3,
        boxPos: 0.8,
        emaGap: 0.006,
        trendWeaknessScore: 0.2,
        rangeConfidence: 0.5,
        lastPrice: currentPrice,
        atr
      },
      accountEquityUsd,
      currentSymbolNotionalUsd: sizeUsd,
      currentGlobalNotionalUsd: sizeUsd
    });

    const policyAllowed = addOnPolicy.allowed === true;
    const hasRequestedNotional = (addOnPolicy.requestedAddonNotionalUsdt ?? 0) > 0;
    const hasMaxNotional = (addOnPolicy.addonMaxNotionalUsdt ?? 0) > 0;

    ok = run(
      "TREND Profit-Funded Pyramid Returns Allowed with Positive Notional",
      policyAllowed && hasRequestedNotional && hasMaxNotional,
      `allowed=${addOnPolicy.allowed}, reason=${addOnPolicy.reason}, maxNotional=${addOnPolicy.addonMaxNotionalUsdt}, requestedNotional=${addOnPolicy.requestedAddonNotionalUsdt}`
    ) && ok;

    // Verify Risk-Sizing Policy produces non-zero stageMarginKrw
    const riskSizing = calculateRiskSizing(
      {
        regime: "TREND",
        regime_final: "TREND",
        subtype: "NONE",
        counter_trend_risk: false
      } as any,
      { level: "HIGH" } as any,
      { baseSizeIntent: 1.0, side: "long" } as any,
      {
        symbol: "BTCUSDT",
        config: { baseSizeUsd: 140000 },
        snapshot: { lastPrice: currentPrice, latestCandleClose: currentPrice, qualityScore: 88, emaGap: 0.006, rangeConfidence: 0.5, volatilityProxy: atr },
        state: {
          accountEquityKrw,
          maxUsableMarginKrw: accountEquityKrw,
          symbolExposureNotionalCapKrw: accountEquityKrw * MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
          exposureNotionalCapKrw: accountEquityKrw * MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE,
          currentStage: 1,
          isAddOn: true,
          addOnPolicyAllowed: true,
          finalAddonNotionalUsdt: addOnPolicy.addonMaxNotionalUsdt,
          lockedProfitUsdt: addOnPolicy.lockedProfitUsdt,
          availableRiskBudgetUsdt: addOnPolicy.availableRiskBudgetUsdt,
          directionalShockState: "NONE",
          longAllow: true,
          currentPositions: [
            {
              symbol: "BTCUSDT",
              side: "long",
              entryStage: 1,
              sizeUsd,
              notionalUsd: sizeUsd,
              isV2Authority: true,
              strategyVersion: "v2"
            }
          ]
        }
      } as any
    );

    const sizingNotBlocked = riskSizing.isBlocked === false;
    const sizingNonZero = riskSizing.stageMarginKrw > 0;

    ok = run(
      "TREND Profit-Funded Sizing Execution is Nonzero and Unblocked",
      sizingNotBlocked && sizingNonZero,
      `isBlocked=${riskSizing.isBlocked}, blockReason=${riskSizing.blockReason}, stageMarginKrw=${riskSizing.stageMarginKrw}`
    ) && ok;
  }

  console.log("\n=== 3. EQUITY MULTIPLIER SEPARATION & CAPACITY BOUNDS ===");
  {
    ok = run(
      "Multiplier values match specification",
      MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE === 2.75 &&
        MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE === 3.0 &&
        MAX_ADVERSE_ADDON_EQUITY_MULTIPLE === 0.25,
      `symbolCap=${MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE}, accountCap=${MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE}, adverseCap=${MAX_ADVERSE_ADDON_EQUITY_MULTIPLE}`
    ) && ok;
  }

  console.log("\n=== 4. INVARIANT EMISSION ON ZERO NOTIONAL ===");
  {
    let proofLogged = false;
    const originalConsoleInfo = console.info;
    console.info = (msg: any) => {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.event === "V2_TRADE_LIFECYCLE_PROOF" && parsed.inconsistency_reasons?.includes("ADDON_ALLOWED_WITH_ZERO_NOTIONAL")) {
          proofLogged = true;
        }
      } catch {}
    };

    try {
      emitV2TradeLifecycleProof({
        symbol: "BTCUSDT",
        side: "long",
        v2State: baseV2State({
          hasLongPosition: true,
          hasSameSidePosition: true,
          currentStage: 1
        }),
        judgment: {
          regime_final: "RANGE",
          subtype: "NONE",
          shockPhase: "NONE",
          rangePhase: "LOWER",
          trendPhase: "NONE",
          transitionPhase: "NONE"
        } as any,
        addOnPolicy: {
          action: "ADDON_ALLOWED",
          allowed: true,
          reason: "RANGE_EDGE_REATTACK_ALLOWED",
          addOnEligible: true,
          isInitial: false,
          isAddOn: true,
          side: "long",
          currentStage: 1,
          hasSameSidePosition: true,
          hasOppositeSidePosition: false,
          marketRegime: "RANGE",
          marketSubtype: "NONE",
          shockPhase: "NONE",
          rangePhase: "LOWER",
          trendPhase: "NONE",
          transitionPhase: "NONE",
          qualityScore: 80,
          reviewingTicks: 2,
          pnlPct: 0.005,
          boxPos: 0.15,
          emaGap: 0.004,
          trendWeaknessScore: 0.3,
          rangeConfidence: 0.75,
          breakevenStopRequired: true,
          breakevenStopConfirmed: true,
          addonMaxNotionalUsdt: 0,
          requestedAddonNotionalUsdt: 0
        } as any
      });
    } finally {
      console.info = originalConsoleInfo;
    }

    ok = run(
      "Invariant proof records ADDON_ALLOWED_WITH_ZERO_NOTIONAL if allowed with zero notional",
      proofLogged,
      `proofLogged=${proofLogged}`
    ) && ok;
  }

  console.log("\n=== 5. RANGE_TO_TREND BLANKET VETO EXCEPTION & HARD BLOCKS ===");
  {
    // 5.1: RANGE + RANGE_TO_TREND + same-side profitable + no shock -> Bypasses TRANSITION_ADDON_FORBIDDEN
    let proofLogged = false;
    let loggedProofData: any = null;
    const originalConsoleInfo = console.info;
    console.info = (msg: any) => {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.event === "RANGE_TO_TREND_CONTINUATION_ADDON_EVALUATED") {
          proofLogged = true;
          loggedProofData = parsed;
        }
      } catch {}
    };

    let policyRangeToTrend: any;
    try {
      policyRangeToTrend = evaluateV2AddOnPolicy({
        symbol: "BTCUSDT",
        side: "long",
        v2State: baseV2State({
          hasLongPosition: true,
          hasSameSidePosition: true,
          currentStage: 1,
          longPosition: {
            symbol: "BTCUSDT",
            side: "long",
            entryPrice: 94000,
            sizeUsd: 200,
            entryStage: 1,
            pnlPct: 0.01867, // profitable ~1.87%
            breakevenStopRequired: true,
            breakevenStopConfirmed: true,
            breakevenStopPrice: 95500
          }
        }),
        judgment: {
          regime: "RANGE",
          regime_final: "RANGE",
          subtype: "NONE",
          shockPhase: "NONE",
          rangePhase: "LOWER",
          trendPhase: "NONE",
          transitionPhase: "RANGE_TO_TREND"
        } as any,
        execution: { signal: "LONG_CANDIDATE", side: "long" } as any,
        snapshot: {
          qualityScore: 82,
          reviewing_ticks: 2,
          boxPos: 0.15,
          emaGap: 0.005,
          trendWeaknessScore: 0.25,
          rangeConfidence: 0.75,
          lastPrice: 95800,
          atr: 400
        },
        accountEquityUsd: 1000,
        currentSymbolNotionalUsd: 200,
        currentGlobalNotionalUsd: 200
      });
    } finally {
      console.info = originalConsoleInfo;
    }

    ok = run(
      "RANGE + RANGE_TO_TREND + profitable does NOT blanket-veto to TRANSITION_ADDON_FORBIDDEN",
      policyRangeToTrend.reason !== "TRANSITION_ADDON_FORBIDDEN" && policyRangeToTrend.allowed === true,
      `action=${policyRangeToTrend.action}, reason=${policyRangeToTrend.reason}`
    ) && ok;

    ok = run(
      "RANGE_TO_TREND_CONTINUATION_ADDON_EVALUATED proof is emitted with continuationAllowedToEvaluate=true",
      proofLogged &&
        loggedProofData?.continuationAllowedToEvaluate === true &&
        loggedProofData?.symbol === "BTCUSDT" &&
        loggedProofData?.transitionPhase === "RANGE_TO_TREND",
      `proofLogged=${proofLogged}, data=${JSON.stringify(loggedProofData)}`
    ) && ok;

    // 5.2: TREND + RANGE_TO_TREND + same-side profitable -> Evaluates TREND pyramiding
    const policyTrendToTrend = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      v2State: baseV2State({
        hasLongPosition: true,
        hasSameSidePosition: true,
        currentStage: 1,
        longPosition: {
          symbol: "BTCUSDT",
          side: "long",
          entryPrice: 94000,
          sizeUsd: 300,
          entryStage: 1,
          pnlPct: 0.02,
          breakevenStopRequired: true,
          breakevenStopConfirmed: true,
          breakevenStopPrice: 95500
        }
      }),
      judgment: {
        regime: "TREND",
        regime_final: "TREND",
        subtype: "NONE",
        shockPhase: "NONE",
        rangePhase: "NONE",
        trendPhase: "UP",
        transitionPhase: "RANGE_TO_TREND",
        htf_entry_policy: "BOTH",
        counter_trend_risk: false
      } as any,
      execution: { signal: "LONG_CANDIDATE", side: "long" } as any,
      snapshot: {
        qualityScore: 88,
        reviewing_ticks: 3,
        boxPos: 0.8,
        emaGap: 0.006,
        trendWeaknessScore: 0.2,
        rangeConfidence: 0.5,
        lastPrice: 96000,
        atr: 400
      },
      accountEquityUsd: 1000,
      currentSymbolNotionalUsd: 300,
      currentGlobalNotionalUsd: 300
    });

    ok = run(
      "TREND + RANGE_TO_TREND + profitable evaluates to TREND_PYRAMID_PROFIT_FUNDED_ALLOWED",
      policyTrendToTrend.allowed === true && policyTrendToTrend.reason === "TREND_PYRAMID_PROFIT_FUNDED_ALLOWED",
      `action=${policyTrendToTrend.action}, reason=${policyTrendToTrend.reason}`
    ) && ok;

    // 5.3: TREND_TO_RANGE -> Hard Blocked
    const policyTrendToRange = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      v2State: baseV2State({
        hasLongPosition: true,
        hasSameSidePosition: true,
        currentStage: 1,
        longPosition: {
          symbol: "BTCUSDT",
          side: "long",
          entryPrice: 94000,
          sizeUsd: 200,
          pnlPct: 0.015
        }
      }),
      judgment: {
        regime_final: "RANGE",
        subtype: "NONE",
        shockPhase: "NONE",
        rangePhase: "LOWER",
        trendPhase: "NONE",
        transitionPhase: "TREND_TO_RANGE"
      } as any,
      execution: { signal: "LONG_CANDIDATE", side: "long" } as any,
      snapshot: { qualityScore: 80, lastPrice: 95000, atr: 400 } as any,
      accountEquityUsd: 1000
    });

    ok = run(
      "TREND_TO_RANGE is HARD BLOCKED by TRANSITION_ADDON_FORBIDDEN",
      policyTrendToRange.allowed === false && policyTrendToRange.reason === "TRANSITION_ADDON_FORBIDDEN",
      `action=${policyTrendToRange.action}, reason=${policyTrendToRange.reason}`
    ) && ok;

    // 5.4: SHOCK_RETEST_UNCONFIRMED -> Hard Blocked
    const policyShockRetest = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      v2State: baseV2State({
        hasLongPosition: true,
        hasSameSidePosition: true,
        currentStage: 1,
        longPosition: {
          symbol: "BTCUSDT",
          side: "long",
          entryPrice: 94000,
          sizeUsd: 200,
          pnlPct: 0.015
        }
      }),
      judgment: {
        regime_final: "RANGE",
        subtype: "NONE",
        shockPhase: "NONE",
        rangePhase: "LOWER",
        trendPhase: "NONE",
        transitionPhase: "SHOCK_RETEST_UNCONFIRMED"
      } as any,
      execution: { signal: "LONG_CANDIDATE", side: "long" } as any,
      snapshot: { qualityScore: 80, lastPrice: 95000, atr: 400 } as any,
      accountEquityUsd: 1000
    });

    ok = run(
      "SHOCK_RETEST_UNCONFIRMED is HARD BLOCKED by TRANSITION_ADDON_FORBIDDEN",
      policyShockRetest.allowed === false && policyShockRetest.reason === "TRANSITION_ADDON_FORBIDDEN",
      `action=${policyShockRetest.action}, reason=${policyShockRetest.reason}`
    ) && ok;

    // 5.5: UP_SHOCK / DOWN_SHOCK -> Hard Blocked by SHOCK_ADDON_FORBIDDEN
    const policyShock = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      v2State: baseV2State({
        hasLongPosition: true,
        hasSameSidePosition: true,
        currentStage: 1,
        longPosition: {
          symbol: "BTCUSDT",
          side: "long",
          entryPrice: 94000,
          sizeUsd: 200,
          pnlPct: 0.015
        }
      }),
      judgment: {
        regime_final: "RANGE",
        subtype: "NONE",
        shockPhase: "UP_SHOCK",
        rangePhase: "LOWER",
        trendPhase: "NONE",
        transitionPhase: "RANGE_TO_TREND"
      } as any,
      execution: { signal: "LONG_CANDIDATE", side: "long" } as any,
      snapshot: { qualityScore: 80, lastPrice: 95000, atr: 400 } as any,
      accountEquityUsd: 1000
    });

    ok = run(
      "UP_SHOCK / DOWN_SHOCK is HARD BLOCKED by SHOCK_ADDON_FORBIDDEN",
      policyShock.allowed === false && policyShock.reason === "SHOCK_ADDON_FORBIDDEN",
      `action=${policyShock.action}, reason=${policyShock.reason}`
    ) && ok;

    // 5.6: Opposite position exists -> Hard Blocked by OPPOSITE_POSITION_EXISTS_FORBIDDEN
    const policyOpposite = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      v2State: baseV2State({
        hasLongPosition: false,
        hasShortPosition: true,
        hasSameSidePosition: false,
        hasOppositeSidePosition: true,
        currentStage: 1,
        shortPosition: {
          symbol: "BTCUSDT",
          side: "short",
          entryPrice: 96000,
          sizeUsd: 200,
          pnlPct: 0.015
        }
      }),
      judgment: {
        regime_final: "RANGE",
        subtype: "NONE",
        shockPhase: "NONE",
        rangePhase: "LOWER",
        trendPhase: "NONE",
        transitionPhase: "RANGE_TO_TREND"
      } as any,
      execution: { signal: "LONG_CANDIDATE", side: "long" } as any,
      snapshot: { qualityScore: 80, lastPrice: 95000, atr: 400 } as any,
      accountEquityUsd: 1000
    });

    ok = run(
      "Opposite-side position is HARD BLOCKED by OPPOSITE_POSITION_EXISTS_FORBIDDEN",
      policyOpposite.allowed === false && policyOpposite.reason === "OPPOSITE_POSITION_EXISTS_FORBIDDEN",
      `action=${policyOpposite.action}, reason=${policyOpposite.reason}`
    ) && ok;

    // 5.7: Actual regime_final === TRANSITION -> Hard Blocked by TRANSITION_ADDON_FORBIDDEN
    const policyRegimeTransition = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      v2State: baseV2State({
        hasLongPosition: true,
        hasSameSidePosition: true,
        currentStage: 1,
        longPosition: {
          symbol: "BTCUSDT",
          side: "long",
          entryPrice: 94000,
          sizeUsd: 200,
          pnlPct: 0.015
        }
      }),
      judgment: {
        regime_final: "TRANSITION",
        subtype: "NONE",
        shockPhase: "NONE",
        rangePhase: "NONE",
        trendPhase: "NONE",
        transitionPhase: "RANGE_TO_TREND"
      } as any,
      execution: { signal: "LONG_CANDIDATE", side: "long" } as any,
      snapshot: { qualityScore: 80, lastPrice: 95000, atr: 400 } as any,
      accountEquityUsd: 1000
    });

    ok = run(
      "Actual regime_final === TRANSITION is HARD BLOCKED by TRANSITION_ADDON_FORBIDDEN",
      policyRegimeTransition.allowed === false && policyRegimeTransition.reason === "TRANSITION_ADDON_FORBIDDEN",
      `action=${policyRegimeTransition.action}, reason=${policyRegimeTransition.reason}`
    ) && ok;
  }

  return ok;
}

if (require.main === module) {
  const result = runV2AddonNonzeroExecutionTests();
  process.exit(result ? 0 : 1);
}
