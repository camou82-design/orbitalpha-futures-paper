import { evaluateV2AddOnPolicy } from "../engine-v2/addon/policy";
import { buildV2AddonEligibilityProof } from "../engine-v2/addon/eligibility-proof";
import { computeAdverseAddonRiskProjection } from "../engine-v2/addon/adverse-addon";
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
    accountEquityKrw: 1_960_000,
    ...overrides
  } as unknown as V2StateAuthority;
}

function evalShort(args: Partial<Parameters<typeof evaluateV2AddOnPolicy>[0]> = {}) {
  return evaluateV2AddOnPolicy({
    symbol: "BTCUSDT",
    side: "short",
    v2State: baseV2State(),
    judgment: {
      regime_final: "TREND",
      subtype: "NONE",
      shockPhase: "NONE",
      rangePhase: "NONE",
      trendPhase: "DOWN",
      transitionPhase: "NONE",
      htf_entry_policy: "BOTH",
      counter_trend_risk: false
    } as any,
    execution: {
      signal: "SHORT_CANDIDATE",
      side: "short",
      invalidationPx: 98000,
      stopPrice: 98000
    } as any,
    snapshot: {
      qualityScore: 85,
      reviewing_ticks: 2,
      boxPos: 0.8,
      emaGap: 0.004,
      trendWeaknessScore: 0.3,
      rangeConfidence: 0.7,
      lastPrice: 94000,
      atr: 500
    },
    accountEquityUsd: 1400,
    currentSymbolNotionalUsd: 1200,
    currentGlobalNotionalUsd: 1200,
    maxAddonNotionalUsdt: 20,
    ...args
  });
}

export function runAddonModeCaseTests(): boolean {
  let ok = true;

  // CASE A: profit + same-side confirmation → PYRAMIDING allowed (RANGE edge reattack path)
  {
    const policy = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "short",
      v2State: baseV2State({
        shortPosition: {
          symbol: "BTCUSDT",
          side: "short",
          entryPrice: 95000,
          sizeUsd: 120,
          entryStage: 1,
          pnlPct: 0.005,
          breakevenStopRequired: true,
          breakevenStopConfirmed: true,
          breakevenStopPrice: 94800
        }
      }),
      judgment: {
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
        rangeConfidence: 0.7,
        lastPrice: 94800,
        atr: 500
      },
      accountEquityUsd: 1400,
      currentSymbolNotionalUsd: 1200,
      currentGlobalNotionalUsd: 1200
    });
    ok =
      run(
        "CASE A",
        policy.addonMode === "PYRAMIDING" && policy.allowed === true,
        `mode=${policy.addonMode}, allowed=${policy.allowed}, reason=${policy.reason}`
      ) && ok;
  }

  // CASE B: profit but authority opposite
  {
    const policy = evaluateV2AddOnPolicy({
      symbol: "BTCUSDT",
      side: "long",
      v2State: baseV2State({
        shortPosition: {
          symbol: "BTCUSDT",
          side: "short",
          entryPrice: 95000,
          sizeUsd: 120,
          pnlPct: 0.01,
          breakevenStopConfirmed: true
        }
      }),
      judgment: {
        regime_final: "TREND",
        subtype: "NONE",
        shockPhase: "NONE",
        rangePhase: "NONE",
        trendPhase: "UP",
        transitionPhase: "NONE"
      } as any,
      execution: { signal: "LONG_CANDIDATE", side: "long" } as any,
      snapshot: {
        qualityScore: 85,
        reviewing_ticks: 2,
        boxPos: 0.2,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.7,
        lastPrice: 94000,
        atr: 500
      },
      accountEquityUsd: 1400,
      currentSymbolNotionalUsd: 1200,
      currentGlobalNotionalUsd: 1200
    });
    const proof = buildV2AddonEligibilityProof({
      symbol: "BTCUSDT",
      positionSide: "short",
      authoritySide: "long",
      currentNotionalUsdt: 1200,
      addonRequestedNotionalUsdt: 0,
      addOnPolicy: policy,
      executionAction: "NONE",
      finalDecision: "SKIP",
      liveReadinessPassed: true,
      okxPendingOrdersReady: true,
      minOrderBlockReason: null,
      riskBlockReason: null,
      cooldownBlocked: false,
      cooldownReason: null,
      currentPrice: 94000,
      entryPrice: 95000
    });
    ok =
      run(
        "CASE B",
        policy.allowed === false && proof.block_reason === "AUTHORITY_SIDE_MISMATCH",
        `allowed=${policy.allowed}, block=${proof.block_reason}`
      ) && ok;
  }

  // CASE C: loss + confirmation + thesis + risk pass → CONFIRMED_ADVERSE_ADDON
  {
    const policy = evalShort({
      v2State: baseV2State({
        shortPosition: {
          symbol: "BTCUSDT",
          side: "short",
          entryPrice: 95000,
          sizeUsd: 120,
          entryStage: 1,
          pnlPct: -0.004,
          breakevenStopConfirmed: false
        }
      }),
      judgment: {
        regime_final: "TREND",
        subtype: "NONE",
        shockPhase: "NONE",
        rangePhase: "NONE",
        trendPhase: "PULLBACK",
        transitionPhase: "NONE",
        htf_entry_policy: "BOTH",
        counter_trend_risk: false
      } as any,
      snapshot: {
        qualityScore: 82,
        reviewing_ticks: 3,
        boxPos: 0.8,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.7,
        lastPrice: 95400,
        atr: 500
      },
      currentSymbolNotionalUsd: 120,
      currentGlobalNotionalUsd: 120
    });
    ok =
      run(
        "CASE C",
        policy.addonMode === "CONFIRMED_ADVERSE_ADDON" &&
          policy.allowed === true &&
          (policy.requestedAddonNotionalUsdt ?? 0) <= 20,
        `mode=${policy.addonMode}, allowed=${policy.allowed}, req=${policy.requestedAddonNotionalUsdt}`
      ) && ok;
  }

  // CASE D: loss only, no confirmation
  {
    const policy = evalShort({
      v2State: baseV2State({
        shortPosition: {
          symbol: "BTCUSDT",
          side: "short",
          entryPrice: 95000,
          sizeUsd: 120,
          pnlPct: -0.004
        }
      }),
      execution: { signal: "WAIT_RECHECK", side: "none" } as any,
      snapshot: {
        qualityScore: 82,
        reviewing_ticks: 3,
        boxPos: 0.8,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.7,
        lastPrice: 95400,
        atr: 500
      },
      currentSymbolNotionalUsd: 120,
      currentGlobalNotionalUsd: 120
    });
    ok =
      run(
        "CASE D",
        policy.allowed === false &&
          policy.addonBlockedReason === "SAME_SIDE_CONFIRMATION_NOT_MET",
        `block=${policy.addonBlockedReason}`
      ) && ok;
  }

  // CASE E: loss + authority opposite
  {
    const policy = evalShort({
      v2State: baseV2State({
        shortPosition: {
          symbol: "BTCUSDT",
          side: "short",
          entryPrice: 95000,
          sizeUsd: 120,
          pnlPct: -0.005
        }
      }),
      execution: { signal: "LONG_CANDIDATE", side: "long", invalidationPx: 98000, stopPrice: 98000 } as any,
      currentSymbolNotionalUsd: 120,
      currentGlobalNotionalUsd: 120
    });
    const proof = buildV2AddonEligibilityProof({
      symbol: "BTCUSDT",
      positionSide: "short",
      authoritySide: "long",
      currentNotionalUsdt: 120,
      addonRequestedNotionalUsdt: 0,
      addOnPolicy: policy,
      executionAction: "NONE",
      finalDecision: "SKIP",
      liveReadinessPassed: true,
      okxPendingOrdersReady: true,
      minOrderBlockReason: null,
      riskBlockReason: null,
      cooldownBlocked: false,
      cooldownReason: null,
      currentPrice: 95400,
      entryPrice: 95000
    });
    ok =
      run(
        "CASE E",
        proof.add_on_allowed === false && proof.block_reason === "AUTHORITY_SIDE_MISMATCH",
        `block=${proof.block_reason}`
      ) && ok;
  }

  // CASE F: risk budget exceeded
  {
    const policy = evalShort({
      v2State: baseV2State({
        shortPosition: {
          symbol: "BTCUSDT",
          side: "short",
          entryPrice: 95000,
          sizeUsd: 120,
          pnlPct: -0.02
        }
      }),
      judgment: {
        regime_final: "TREND",
        subtype: "NONE",
        shockPhase: "NONE",
        rangePhase: "NONE",
        trendPhase: "PULLBACK",
        transitionPhase: "NONE",
        htf_entry_policy: "BOTH",
        counter_trend_risk: false
      } as any,
      execution: {
        signal: "SHORT_CANDIDATE",
        side: "short",
        invalidationPx: 99000,
        stopPrice: 99000
      } as any,
      snapshot: {
        qualityScore: 82,
        reviewing_ticks: 3,
        boxPos: 0.8,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.7,
        lastPrice: 95800,
        atr: 1200
      },
      currentSymbolNotionalUsd: 800,
      currentGlobalNotionalUsd: 800
    });
    ok =
      run(
        "CASE F",
        policy.allowed === false && policy.addonBlockedReason === "RISK_BUDGET_EXCEEDED",
        `block=${policy.addonBlockedReason}`
      ) && ok;
  }

  // CASE G: MAX_SYMBOL_CAP
  {
    const policy = evalShort({
      v2State: baseV2State({
        shortPosition: {
          symbol: "BTCUSDT",
          side: "short",
          entryPrice: 95000,
          sizeUsd: 120,
          pnlPct: -0.004
        }
      }),
      judgment: {
        regime_final: "TREND",
        subtype: "NONE",
        shockPhase: "NONE",
        rangePhase: "NONE",
        trendPhase: "PULLBACK",
        transitionPhase: "NONE",
        htf_entry_policy: "BOTH",
        counter_trend_risk: false
      } as any,
      currentSymbolNotionalUsd: 1120,
      currentGlobalNotionalUsd: 1120,
      accountEquityUsd: 1400
    });
    ok =
      run(
        "CASE G",
        policy.allowed === false && policy.addonBlockedReason === "MAX_SYMBOL_CAP",
        `block=${policy.addonBlockedReason}`
      ) && ok;
  }

  // CASE H: weighted avg / stop risk math
  {
    const risk = computeAdverseAddonRiskProjection({
      side: "short",
      entryPrice: 95000,
      currentPrice: 95400,
      currentNotionalUsdt: 120,
      requestedAddonNotionalUsdt: 20,
      atr: 500,
      accountEquityUsd: 1400
    });
    const expectedAvg = (120 * 95000 + 20 * 95400) / 140;
    const avgOk = Math.abs(risk.projectedWeightedAvgEntry - expectedAvg) < 1;
    const totalOk = Math.abs(risk.projectedTotalNotionalUsdt - 140) < 0.01;
    ok =
      run(
        "CASE H",
        avgOk && totalOk && risk.projectedStopPrice > 95400 && risk.projectedLossAtStopUsdt >= risk.riskBeforeAddonUsdt,
        JSON.stringify({
          avg: risk.projectedWeightedAvgEntry,
          total: risk.projectedTotalNotionalUsdt,
          stop: risk.projectedStopPrice,
          risk_before: risk.riskBeforeAddonUsdt,
          risk_after: risk.projectedLossAtStopUsdt
        })
      ) && ok;
  }

  return ok;
}

if (require.main === module) {
  process.exit(runAddonModeCaseTests() ? 0 : 1);
}
