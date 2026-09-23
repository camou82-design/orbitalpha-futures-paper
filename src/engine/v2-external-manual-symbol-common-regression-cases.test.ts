/**
 * Symbol-common external manual ownership (f0fcda1): BTC + ETH restart rehydration and
 * bot entry / PNL_STOP / FULL_EXIT must not intervene on operator-managed positions.
 */
import type { PaperOpenPositionRecord } from "../models/types";
import {
  isIndependentExternalManualLifecycle,
  hasIndependentManualLifecycleEvidence
} from "../engine-v2/position/manual-ownership-latch";
import {
  resolvePositionOwnership,
  isAutomatedOrderMutationBlockedForOwnership
} from "../engine-v2/position/ownership-resolver";
import { resolvePositionMutationAuthority } from "../engine-v2/position/manual-takeover-authority";
import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import { runEngineV2 } from "../engine-v2/index";

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`FAIL [${msg}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL [${msg}]: expected true`);
}

function assertFalse(cond: boolean, msg: string): void {
  if (cond) throw new Error(`FAIL [${msg}]: expected false`);
}

function makeExternalManualRestartLedger(input: {
  symbol: "BTCUSDT" | "ETHUSDT";
  side: "long" | "short";
  entryPrice: number;
  okxContracts: number;
}): PaperOpenPositionRecord {
  return {
    openedAt: 1_700_000_000_000,
    symbol: input.symbol,
    side: input.side,
    entryPrice: input.entryPrice,
    leverage: 10,
    sizeUsd: 400,
    initialSizeUsd: 400,
    strategyVersion: "paper-v2",
    sourceSignal: "manual_intervention_fill",
    sourceRunPath: "manual_adoption",
    lifecycleState: "MANUAL_SIZE_AUGMENTED",
    manualAugmentActive: true,
    manualTakeoverActive: false,
    manualTakeoverReason: "EXTERNAL_MANUAL_POSITION",
    manualOwnershipLatch: false,
    manualLifecycleEvidenceIndependent: false,
    reconcileState: "MATCHED",
    status: "open",
    okxContracts: input.okxContracts,
    pos: input.okxContracts,
    isV2Authority: false
  };
}

function assertExternalManualOwnershipRestart(
  symbol: "BTCUSDT" | "ETHUSDT",
  side: "long" | "short",
  ledger: PaperOpenPositionRecord,
  okxContracts: number,
  avgPx: number,
  label: string
): void {
  assertTrue(isIndependentExternalManualLifecycle(ledger), `${label} independent lifecycle`);
  assertTrue(hasIndependentManualLifecycleEvidence(ledger), `${label} independent evidence`);

  const ownership = resolvePositionOwnership({
    symbol,
    side,
    okxActualPositionExists: true,
    okxActualContracts: okxContracts,
    ledger,
    ledgerPaperContracts: okxContracts,
    ledgerEntryPrice: ledger.entryPrice,
    okxAvgPx: avgPx,
    explicitExternalManualEvidence: isIndependentExternalManualLifecycle(ledger),
    symbolExternalManualBlocked: false,
    manualOwnershipLatchActive: false,
    syncStatus: "ALIGNED",
    okxFetchReady: true,
    reconcileState: "MATCHED"
  });

  assertEq(ownership.ownershipClass, "EXTERNAL_MANUAL_MANAGED", `${label} ownership class`);
  assertFalse(ownership.normalExitPolicyAllowed, `${label} normalExitPolicyAllowed false`);
  assertTrue(isAutomatedOrderMutationBlockedForOwnership(ownership), `${label} mutation blocked`);

  const authority = resolvePositionMutationAuthority({ open: ledger });
  assertEq(authority.effectiveAuthorityOwner, "OPERATOR", `${label} OPERATOR authority`);
  assertFalse(authority.positionMutationAllowed, `${label} positionMutationAllowed false`);
  assertFalse(authority.exitCalculationAllowed, `${label} exitCalculationAllowed false`);
}

function assertExitPolicyBlocksPnlStopFullExit(
  symbol: "BTCUSDT" | "ETHUSDT",
  side: "long" | "short",
  ledger: PaperOpenPositionRecord,
  label: string
): void {
  const posBridge = {
    symbol,
    side,
    entryPrice: ledger.entryPrice,
    sizeUsd: ledger.sizeUsd,
    entryStage: 1,
    pnlPct: -0.022,
    peakUnrealizedPnlPct: -0.022,
    leverage: 10,
    lifecycleState: ledger.lifecycleState,
    manualTakeoverActive: ledger.manualTakeoverActive,
    manualTakeoverReason: ledger.manualTakeoverReason,
    sourceSignal: ledger.sourceSignal,
    sourceRunPath: ledger.sourceRunPath,
    manualAugmentActive: ledger.manualAugmentActive
  };

  const withoutEvidence = { ...posBridge, manualTakeoverReason: undefined, sourceSignal: "v2", sourceRunPath: "live" };
  const botExit = evaluateV2ExitPolicy({
    symbol,
    v2State: {
      symbolPositions: [withoutEvidence],
      longPosition: side === "long" ? withoutEvidence : null,
      shortPosition: side === "short" ? withoutEvidence : null
    } as any,
    judgment: {
      regime_final: "RANGE",
      subtype: "RANGE_MID",
      shockPhase: "NONE",
      rangePhase: "MID",
      trendPhase: "NONE",
      transitionPhase: "NONE"
    } as any,
    snapshot: {
      boxPos: 0.5,
      boxBreakSide: "none",
      emaGap: 0,
      trendWeaknessScore: 0.3,
      rangeConfidence: 0.5,
      qualityScore: 50
    },
    markPrice: side === "long" ? ledger.entryPrice * 0.98 : ledger.entryPrice * 1.02
  });
  assertEq(botExit.action, "FULL_EXIT", `${label} control bot path FULL_EXIT`);
  assertEq(botExit.reason, "PNL_STOP_PROTECT", `${label} control PNL_STOP`);

  const manualExit = evaluateV2ExitPolicy({
    symbol,
    v2State: {
      symbolPositions: [posBridge],
      longPosition: side === "long" ? posBridge : null,
      shortPosition: side === "short" ? posBridge : null
    } as any,
    judgment: {
      regime_final: "RANGE",
      subtype: "RANGE_MID",
      shockPhase: "NONE",
      rangePhase: "MID",
      trendPhase: "NONE",
      transitionPhase: "NONE"
    } as any,
    snapshot: {
      boxPos: 0.5,
      boxBreakSide: "none",
      emaGap: 0,
      trendWeaknessScore: 0.3,
      rangeConfidence: 0.5,
      qualityScore: 50
    },
    markPrice: side === "long" ? ledger.entryPrice * 0.98 : ledger.entryPrice * 1.02
  });
  assertEq(manualExit.action, "HOLD", `${label} manual exit HOLD`);
  assertEq(manualExit.evidence, "manual_takeover_observe_only", `${label} observe-only evidence`);
  assertFalse(manualExit.shouldExit, `${label} shouldExit false`);
  assertFalse(manualExit.reason === "PNL_STOP_PROTECT", `${label} no PNL_STOP reason`);
}

function assertRunEngineV2ObserveOnly(
  symbol: "BTCUSDT" | "ETHUSDT",
  side: "long" | "short",
  ledger: PaperOpenPositionRecord,
  label: string
): void {
  const bridgePos = {
    ...ledger,
    entryStage: 1,
    pnlPct: -0.05,
    peakUnrealizedPnlPct: -0.05
  };
  const v2Res = runEngineV2({
    symbol,
    now: 1_700_000_100_000,
    snapshot: {
      lastPrice: ledger.entryPrice,
      candles: []
    } as any,
    config: {} as any,
    state: {
      currentPositions: [bridgePos],
      longPosition: side === "long" ? bridgePos : null,
      shortPosition: side === "short" ? bridgePos : null,
      longAllow: true,
      shortAllow: true,
      executionReadiness: true
    } as any,
    v1Result: {} as any,
    evaluationMode: "authoritative"
  });

  assertEq(v2Res.decision.decision, "HOLD", `${label} runEngineV2 HOLD`);
  assertEq(v2Res.decision.executionAction, "NONE", `${label} no execution`);
  assertEq(v2Res.decision.rawMetrics?.mutation_allowed, false, `${label} mutation_allowed false`);
  assertEq(
    v2Res.decision.explanation.reason,
    "MANUAL_TAKEOVER_ACTIVE_OBSERVE_ONLY",
    `${label} observe-only reason`
  );
  assertFalse(v2Res.decision.decision === "ENTER", `${label} no auto entry`);
}

function runCases(): void {
  console.log("=== V2 EXTERNAL MANUAL SYMBOL-COMMON REGRESSION CASES ===");

  const btc = makeExternalManualRestartLedger({
    symbol: "BTCUSDT",
    side: "short",
    entryPrice: 83_819.43,
    okxContracts: 17.64
  });
  assertExternalManualOwnershipRestart("BTCUSDT", "short", btc, 17.64, 83_819.43, "BTC");
  assertExitPolicyBlocksPnlStopFullExit("BTCUSDT", "short", btc, "BTC");
  assertRunEngineV2ObserveOnly("BTCUSDT", "short", btc, "BTC");
  console.log("[BTC] PASS: ownership + exit + engine observe-only");

  const eth = makeExternalManualRestartLedger({
    symbol: "ETHUSDT",
    side: "long",
    entryPrice: 3_450.25,
    okxContracts: 42.5
  });
  assertExternalManualOwnershipRestart("ETHUSDT", "long", eth, 42.5, 3_450.25, "ETH");
  assertExitPolicyBlocksPnlStopFullExit("ETHUSDT", "long", eth, "ETH");
  assertRunEngineV2ObserveOnly("ETHUSDT", "long", eth, "ETH");
  console.log("[ETH] PASS: ownership + exit + engine observe-only");

  // Bot same-side augment without external adoption markers — exit policy must remain allowed (BTC protection).
  const botAugmentOnly: PaperOpenPositionRecord = {
    openedAt: 1_700_000_000_000,
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 78_125.6,
    leverage: 10,
    sizeUsd: 8_635,
    initialSizeUsd: 400,
    strategyVersion: "paper-v2",
    sourceSignal: "v2",
    sourceRunPath: "live_run",
    lifecycleState: "MANUAL_SIZE_AUGMENTED",
    manualAugmentActive: true,
    manualTakeoverActive: false,
    isV2Authority: true,
    reconcileState: "MATCHED",
    status: "open",
    okxContracts: 11.08,
    pos: 11.08
  };
  assertFalse(isIndependentExternalManualLifecycle(botAugmentOnly), "bot augment not external manual");
  const augmentExit = evaluateV2ExitPolicy({
    symbol: "BTCUSDT",
    v2State: {
      symbolPositions: [
        {
          symbol: "BTCUSDT",
          side: "long",
          entryPrice: 78_125.6,
          sizeUsd: 8_635,
          entryStage: 1,
          pnlPct: -0.022,
          leverage: 10,
          lifecycleState: "MANUAL_SIZE_AUGMENTED"
        }
      ],
      longPosition: {
        symbol: "BTCUSDT",
        side: "long",
        entryPrice: 78_125.6,
        sizeUsd: 8_635,
        entryStage: 1,
        pnlPct: -0.022,
        leverage: 10,
        lifecycleState: "MANUAL_SIZE_AUGMENTED"
      }
    } as any,
    judgment: {
      regime_final: "RANGE",
      subtype: "RANGE_MID",
      shockPhase: "NONE",
      rangePhase: "MID",
      trendPhase: "NONE",
      transitionPhase: "NONE"
    } as any,
    snapshot: {
      boxPos: 0.5,
      boxBreakSide: "none",
      emaGap: 0,
      trendWeaknessScore: 0.3,
      rangeConfidence: 0.5,
      qualityScore: 50
    },
    markPrice: 76_000
  });
  assertEq(augmentExit.action, "FULL_EXIT", "bot augment control still FULL_EXIT");
  assertEq(augmentExit.reason, "PNL_STOP_PROTECT", "bot augment control PNL_STOP");
  console.log("[BTC BOT AUGMENT] PASS: non-external MANUAL_SIZE_AUGMENTED exit path preserved");

  console.log("=== ALL EXTERNAL MANUAL SYMBOL-COMMON REGRESSION CASES PASSED ===");
}

runCases();
