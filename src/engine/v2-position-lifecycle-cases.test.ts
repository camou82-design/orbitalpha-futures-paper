import { evaluateV2AddOnPolicy } from "../engine-v2/addon/policy";
import {
  resolvePositionOwnership,
  isAddonManagementAllowedForOwnership,
  isEntryAddonBlockedForOwnership
} from "../engine-v2/position/ownership-resolver";
import {
  buildReduceFlowKey,
  evaluateReduceResubmitAllowed
} from "../engine-v2/execution/reduce-lifecycle";
import {
  evaluateReduceLotDistortion,
  V2_REDUCE_LOT_DISTORTION_HOLD_THRESHOLD
} from "../engine-v2/execution/reduce-lot-distortion";
import { shouldTriggerProtectionResize } from "../engine-v2/addon/adverse-addon";
import { protectiveStopPricesMatch } from "../engine-v2/execution/protective-match";
import { applyPositionTerminalCleanup } from "../engine-v2/position/terminal-cleanup";
import type { PaperOpenPositionRecord } from "../models/types";
import type { V2StateAuthority } from "../engine-v2/state/types";

function run(label: string, passed: boolean, detail: string): boolean {
  console.log(`[${label}] ${passed ? "PASS" : "FAIL"} — ${detail}`);
  return passed;
}

function botLedger(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
  return {
    symbol: "ETHUSDT",
    side: "long",
    openedAt: Date.now(),
    entryPrice: 1900,
    sizeUsd: 20,
    leverage: 10,
    strategyVersion: "test",
    sourceSignal: "test",
    sourceRunPath: "test",
    isV2Authority: true,
    authoritySourceAtEntry: "v2",
    exchangeClOrdId: "pETHUSDTlabc123",
    lifecycleState: "CLOSE_ONLY_MANAGED",
    reconcileState: "ADOPTED",
    ...overrides
  } as PaperOpenPositionRecord;
}

function manualLedger(): PaperOpenPositionRecord {
  return botLedger({
    symbol: "BTCUSDT",
    isV2Authority: false,
    authoritySourceAtEntry: undefined,
    exchangeClOrdId: undefined,
    lifecycleState: "EXTERNAL_MANUAL_POSITION",
    reconcileState: "ADOPTED"
  });
}

export function runV2PositionLifecycleCaseTests(): boolean {
  let ok = true;

  // A: ETH bot entry restart → BOT_V2_MANAGED restored
  {
    const r = resolvePositionOwnership({
      symbol: "ETHUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.03,
      ledger: botLedger(),
      externalManualEvidence: false,
      symbolExternalManualBlocked: false
    });
    ok =
      run(
        "CASE A",
        r.ownershipClass === "BOT_V2_MANAGED" &&
          r.v2ManagementRestored === true &&
          r.lifecycleAfter === "BOT_V2_MANAGED",
        JSON.stringify(r)
      ) && ok;
  }

  // B: BTC manual intervention → CLOSE_ONLY / EXTERNAL retained
  {
    const r = resolvePositionOwnership({
      symbol: "BTCUSDT",
      side: "short",
      okxActualPositionExists: true,
      okxActualContracts: 0.01,
      ledger: manualLedger(),
      externalManualEvidence: true,
      symbolExternalManualBlocked: true
    });
    ok =
      run(
        "CASE B",
        r.ownershipClass === "EXTERNAL_MANUAL_MANAGED" && r.v2ManagementRestored === false,
        JSON.stringify(r)
      ) && ok;
  }

  // C: unclear ownership → fail-safe CLOSE_ONLY
  {
    const r = resolvePositionOwnership({
      symbol: "ETHUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.02,
      ledger: botLedger({ isV2Authority: false, authoritySourceAtEntry: undefined, exchangeClOrdId: undefined }),
      externalManualEvidence: false,
      symbolExternalManualBlocked: false
    });
    ok =
      run(
        "CASE C",
        r.ownershipClass === "CLOSE_ONLY_MANAGED" && r.lifecycleAfter === "CLOSE_ONLY_MANAGED",
        JSON.stringify(r)
      ) && ok;
  }

  // D: BOT_V2_MANAGED loss + fresh confirmation → adverse reachable
  {
    const policy = evaluateV2AddOnPolicy({
      symbol: "ETHUSDT",
      side: "short",
      v2State: {
        longPosition: null,
        shortPosition: {
          symbol: "ETHUSDT",
          side: "short",
          entryPrice: 1950,
          sizeUsd: 20,
          entryStage: 1,
          pnlPct: -0.004,
          adverseMoveAnchorCandleTs: 1_000_000
        },
        currentPositions: [],
        crashState: "",
        pumpState: "",
        accountEquityKrw: 1_960_000
      } as unknown as V2StateAuthority,
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
      execution: { signal: "SHORT_CANDIDATE", side: "short", invalidationPx: 2000, stopPrice: 2000 } as any,
      snapshot: {
        qualityScore: 82,
        reviewing_ticks: 3,
        boxPos: 0.8,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.7,
        lastPrice: 1960,
        atr: 20,
        latestCandleTs: 2_000_000
      },
      accountEquityUsd: 1400,
      currentSymbolNotionalUsd: 20,
      currentGlobalNotionalUsd: 20,
      maxAddonNotionalUsdt: 20
    });
    const own = resolvePositionOwnership({
      symbol: "ETHUSDT",
      side: "short",
      okxActualPositionExists: true,
      okxActualContracts: 0.02,
      ledger: botLedger({ symbol: "ETHUSDT", side: "short", lifecycleState: "BOT_V2_MANAGED" }),
      externalManualEvidence: false,
      symbolExternalManualBlocked: false
    });
    ok =
      run(
        "CASE D",
        isAddonManagementAllowedForOwnership(own) &&
          policy.addonMode === "CONFIRMED_ADVERSE_ADDON" &&
          policy.allowed === true,
        `own=${own.ownershipClass}, policy=${policy.addonMode}`
      ) && ok;
  }

  // E: BOT_V2_MANAGED profit → pyramiding reachable
  {
    const policy = evaluateV2AddOnPolicy({
      symbol: "ETHUSDT",
      side: "long",
      v2State: {
        longPosition: {
          symbol: "ETHUSDT",
          side: "long",
          entryPrice: 1900,
          sizeUsd: 20,
          entryStage: 1,
          pnlPct: 0.006,
          breakevenStopConfirmed: true,
          breakevenStopRequired: true,
          breakevenStopPrice: 1905
        },
        shortPosition: null,
        currentPositions: [],
        crashState: "",
        pumpState: "",
        accountEquityKrw: 1_960_000
      } as unknown as V2StateAuthority,
      judgment: {
        regime_final: "RANGE",
        subtype: "NONE",
        shockPhase: "NONE",
        rangePhase: "LOWER",
        trendPhase: "NONE",
        transitionPhase: "NONE"
      } as any,
      execution: { signal: "LONG_CANDIDATE", side: "long" } as any,
      snapshot: {
        qualityScore: 80,
        reviewing_ticks: 2,
        boxPos: 0.15,
        emaGap: 0.004,
        trendWeaknessScore: 0.3,
        rangeConfidence: 0.7,
        lastPrice: 1910,
        atr: 10,
        latestCandleTs: 2_000_000
      },
      accountEquityUsd: 1400,
      currentSymbolNotionalUsd: 20,
      currentGlobalNotionalUsd: 20
    });
    ok =
      run(
        "CASE E",
        policy.addonMode === "PYRAMIDING" && policy.allowed === true,
        `mode=${policy.addonMode}`
      ) && ok;
  }

  // F: SHOCK reduce pending → duplicate submit blocked
  {
    const resubmit = evaluateReduceResubmitAllowed({
      previousState: "SUBMITTED",
      okxOrderTerminal: false,
      okxOrderRejected: false,
      okxOrderCanceled: false,
      previousZeroFill: false,
      newDecisionCandle: false,
      actualContractsChanged: false,
      sameFlowKey: true
    });
    ok =
      run(
        "CASE F",
        resubmit.resubmitAllowed === false && resubmit.resubmitReason === "pending_submitted_state",
        JSON.stringify(resubmit)
      ) && ok;
  }

  // G: canceled → resubmit allowed
  {
    const resubmit = evaluateReduceResubmitAllowed({
      previousState: "SUBMITTED",
      okxOrderTerminal: true,
      okxOrderRejected: false,
      okxOrderCanceled: true,
      previousZeroFill: false,
      newDecisionCandle: false,
      actualContractsChanged: false,
      sameFlowKey: true
    });
    ok =
      run(
        "CASE G",
        resubmit.resubmitAllowed === true,
        resubmit.resubmitReason ?? "null"
      ) && ok;
  }

  // H: ETH 35% reduce min lot distortion
  {
    const d = evaluateReduceLotDistortion({
      positionContracts: 0.01,
      desiredReduceRatio: 0.35,
      normalizedReduceContracts: 0.01,
      reason: "SHOCK_PROTECTIVE_REDUCE"
    });
    ok =
      run(
        "CASE H",
        d.actualReduceRatio === 1 && d.lotSizeDistortionRatio > V2_REDUCE_LOT_DISTORTION_HOLD_THRESHOLD,
        JSON.stringify(d)
      ) && ok;
  }

  // I: tick-normalized SL match
  {
    ok =
      run(
        "CASE I",
        protectiveStopPricesMatch(1917.272591, 1917.27, 0.01),
        "tick match"
      ) && ok;
  }

  // J: duplicate protective → resize trigger
  {
    ok =
      run(
        "CASE J",
        shouldTriggerProtectionResize(0.05, 0.03),
        "partial protection"
      ) && ok;
  }

  // K: addon protection resize math
  {
    ok =
      run(
        "CASE K",
        !shouldTriggerProtectionResize(0.05, 0.05),
        "full protection"
      ) && ok;
  }

  // L: partial reduce downsize signal
  {
    ok =
      run(
        "CASE L",
        shouldTriggerProtectionResize(0.04, 0.05),
        "oversized protection needs resize"
      ) && ok;
  }

  // M: OKX actual none → terminal cleanup
  {
    const open = botLedger({ okxContracts: 0.03, shockReduceState: "SUBMITTED" });
    const cleanup = applyPositionTerminalCleanup(open);
    ok =
      run(
        "CASE M",
        cleanup.cleared && cleanup.fieldsCleared.includes("shockReduceState"),
        cleanup.fieldsCleared.join(",")
      ) && ok;
  }

  // N: entry not blocked for BOT_V2_MANAGED
  {
    const own = resolvePositionOwnership({
      symbol: "ETHUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.03,
      ledger: botLedger({ lifecycleState: "BOT_V2_MANAGED", reconcileState: "MATCHED" }),
      externalManualEvidence: false,
      symbolExternalManualBlocked: false
    });
    ok =
      run(
        "CASE N",
        !isEntryAddonBlockedForOwnership(own),
        own.ownershipClass
      ) && ok;
  }

  // O: same resolver for BTC and ETH
  {
    const eth = resolvePositionOwnership({
      symbol: "ETHUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.02,
      ledger: botLedger(),
      externalManualEvidence: false,
      symbolExternalManualBlocked: false
    });
    const btc = resolvePositionOwnership({
      symbol: "BTCUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.01,
      ledger: botLedger({ symbol: "BTCUSDT" }),
      externalManualEvidence: false,
      symbolExternalManualBlocked: false
    });
    ok =
      run(
        "CASE O",
        eth.ownershipSource === btc.ownershipSource &&
          eth.ownershipClass === "BOT_V2_MANAGED" &&
          btc.ownershipClass === "BOT_V2_MANAGED",
        `eth=${eth.ownershipSource}, btc=${btc.ownershipSource}`
      ) && ok;
  }

  // P: reduce flow key stable (diagnostic-safe identity)
  {
    const k1 = buildReduceFlowKey({
      symbol: "ETHUSDT",
      side: "long",
      reason: "SHOCK_PROTECTIVE_REDUCE",
      targetContracts: 0.01,
      decisionCandleTs: 12345
    });
    const k2 = buildReduceFlowKey({
      symbol: "ETHUSDT",
      side: "long",
      reason: "SHOCK_PROTECTIVE_REDUCE",
      targetContracts: 0.01,
      decisionCandleTs: 12345
    });
    ok = run("CASE P", k1 === k2 && k1.includes("ETHUSDT"), k1) && ok;
  }

  return ok;
}

if (require.main === module) {
  process.exit(runV2PositionLifecycleCaseTests() ? 0 : 1);
}
