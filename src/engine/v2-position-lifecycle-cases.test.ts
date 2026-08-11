import { evaluateV2AddOnPolicy } from "../engine-v2/addon/policy";
import {
  resolvePositionOwnership,
  isAddonManagementAllowedForOwnership,
  isEntryAddonBlockedForOwnership,
  isAutomatedOrderMutationBlockedForOwnership,
  detectManualInterventionEvidence,
  isBotAttributedTransientMismatch
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
import {
  evaluateManualOwnershipLatchTrigger,
  evaluateFalseManualLatchRecovery,
  applyManualOwnershipLatch,
  clearManualOwnershipLatchFields
} from "../engine-v2/position/manual-ownership-latch";
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

function unattributedLedger(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
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
    isV2Authority: false,
    lifecycleState: "OPEN",
    reconcileState: "RECONCILE_MISMATCH",
    okxContracts: 0.03,
    ...overrides
  } as PaperOpenPositionRecord;
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
      explicitExternalManualEvidence: false,
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
      explicitExternalManualEvidence: true,
      symbolExternalManualBlocked: true
    });
    ok =
      run(
        "CASE B",
        r.ownershipClass === "EXTERNAL_MANUAL_MANAGED" &&
          r.v2ManagementRestored === false &&
          r.lifecycleAfter === "EXTERNAL_MANUAL_MANAGED",
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
      explicitExternalManualEvidence: false,
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
      explicitExternalManualEvidence: false,
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
      explicitExternalManualEvidence: false,
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
      explicitExternalManualEvidence: false,
      symbolExternalManualBlocked: false
    });
    const btc = resolvePositionOwnership({
      symbol: "BTCUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.01,
      ledger: botLedger({ symbol: "BTCUSDT" }),
      explicitExternalManualEvidence: false,
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

  const manualResolveInput = (overrides: {
    ledger?: Partial<PaperOpenPositionRecord>;
    okxContracts?: number;
    latch?: boolean;
    blocked?: boolean;
    syncStatus?: string;
    okxFetchReady?: boolean;
    explicitManual?: boolean;
  } = {}) =>
    ({
      symbol: "ETHUSDT",
      side: "long" as const,
      okxActualPositionExists: (overrides.okxContracts ?? 0.06) > 0,
      okxActualContracts: overrides.okxContracts ?? 0.06,
      ledger: botLedger({
        okxContracts: 0.03,
        lifecycleState: "BOT_V2_MANAGED",
        reconcileState: "RECONCILE_MISMATCH",
        manualOwnershipLatch: overrides.latch ? true : undefined,
        ...overrides.ledger
      }),
      ledgerPaperContracts: overrides.ledger?.okxContracts ?? 0.03,
      ledgerEntryPrice: 1900,
      okxAvgPx: 1900,
      explicitExternalManualEvidence: overrides.explicitManual ?? false,
      symbolExternalManualBlocked: overrides.blocked ?? true,
      manualOwnershipLatchActive: overrides.latch === true,
      syncStatus: overrides.syncStatus ?? "ALIGNED",
      okxFetchReady: overrides.okxFetchReady ?? true,
      reconcileState: overrides.ledger?.reconcileState ?? "RECONCILE_MISMATCH"
    });

  // FLCASE A: KEY_MISMATCH + transient OKX zero → latch forbidden
  {
    const trigger = evaluateManualOwnershipLatchTrigger({
      ledger: botLedger({ okxContracts: 0.06, reconcileState: "OKX_ZERO_UNCONFIRMED" }),
      syncStatus: "KEY_MISMATCH",
      okxActualContracts: 0,
      okxActualPositionExists: false,
      ledgerPaperContracts: 0.06,
      symbolExternalManualBlocked: true,
      okxFetchReady: true
    });
    ok =
      run(
        "FLCASE A",
        trigger.shouldLatch === false && trigger.reason === "KEY_MISMATCH",
        JSON.stringify(trigger)
      ) && ok;
  }

  // FLCASE B: fresh MATCHED aligned bot position → BOT_V2_MANAGED
  {
    const r = resolvePositionOwnership({
      symbol: "BTCUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.06,
      ledger: botLedger({
        symbol: "BTCUSDT",
        okxContracts: 0.06,
        lifecycleState: "OPEN",
        reconcileState: "MATCHED"
      }),
      ledgerPaperContracts: 0.06,
      ledgerEntryPrice: 1900,
      okxAvgPx: 1900,
      explicitExternalManualEvidence: false,
      symbolExternalManualBlocked: false,
      manualOwnershipLatchActive: false,
      syncStatus: "ALIGNED",
      okxFetchReady: true,
      reconcileState: "MATCHED"
    });
    ok =
      run(
        "FLCASE B",
        r.ownershipClass === "BOT_V2_MANAGED" && r.manualLatchShouldBeActive === false,
        JSON.stringify(r)
      ) && ok;
  }

  // FLCASE C: legacy weak latch + MATCHED aligned bot → recovery clears latch
  {
    const open = botLedger({
      okxContracts: 0.06,
      lifecycleState: "OPEN",
      reconcileState: "MATCHED",
      manualOwnershipLatch: true,
      manualOwnershipLatchReason: "paper_okx_contract_mismatch",
      manualOwnershipLatchSource: "paper_okx_contract_mismatch",
      manualOwnershipLatchStrength: "WEAK"
    });
    const recovery = evaluateFalseManualLatchRecovery({
      ledger: open,
      reconcileState: "MATCHED",
      okxActualContracts: 0.06,
      okxActualPositionExists: true,
      ledgerPaperContracts: 0.06,
      syncStatus: "ALIGNED"
    });
    clearManualOwnershipLatchFields(open);
    const r = resolvePositionOwnership({
      symbol: "ETHUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.06,
      ledger: open,
      ledgerPaperContracts: 0.06,
      ledgerEntryPrice: 1900,
      okxAvgPx: 1900,
      explicitExternalManualEvidence: false,
      symbolExternalManualBlocked: false,
      manualOwnershipLatchActive: false,
      syncStatus: "ALIGNED",
      reconcileState: "MATCHED"
    });
    ok =
      run(
        "FLCASE C",
        recovery.shouldClear === true &&
          r.ownershipClass === "BOT_V2_MANAGED" &&
          open.manualOwnershipLatch !== true,
        JSON.stringify({ recovery, class: r.ownershipClass })
      ) && ok;
  }

  // FLCASE D: explicit strong manual latch + MATCHED → latch retained
  {
    const open = botLedger({
      lifecycleState: "EXTERNAL_MANUAL_MANAGED",
      reconcileState: "MATCHED",
      manualOwnershipLatch: true,
      manualOwnershipLatchSource: "EXPLICIT_EXTERNAL_FILL",
      manualOwnershipLatchStrength: "STRONG"
    });
    const recovery = evaluateFalseManualLatchRecovery({
      ledger: open,
      reconcileState: "MATCHED",
      okxActualContracts: 0.06,
      okxActualPositionExists: true,
      ledgerPaperContracts: 0.06,
      syncStatus: "ALIGNED",
      explicitManualEvidence: true
    });
    const r = resolvePositionOwnership({
      symbol: "ETHUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.06,
      ledger: open,
      ledgerPaperContracts: 0.06,
      explicitExternalManualEvidence: true,
      symbolExternalManualBlocked: false,
      manualOwnershipLatchActive: true,
      syncStatus: "ALIGNED",
      reconcileState: "MATCHED"
    });
    ok =
      run(
        "FLCASE D",
        recovery.shouldClear === false &&
          r.ownershipClass === "EXTERNAL_MANUAL_MANAGED" &&
          r.manualOwnershipLatchActive === true,
        JSON.stringify({ recovery, r })
      ) && ok;
  }

  // FLCASE E: bot ADDON transient mismatch → latch forbidden
  {
    const ledger = botLedger({
      okxContracts: 0.03,
      lifecycleState: "ADDON_ACTIVE",
      addonRebuildPendingConfirmation: true
    });
    const trigger = evaluateManualOwnershipLatchTrigger({
      ledger,
      syncStatus: "ALIGNED",
      okxActualContracts: 0.05,
      okxActualPositionExists: true,
      ledgerPaperContracts: 0.03,
      ledgerEntryPrice: 1900,
      okxAvgPx: 1900,
      symbolExternalManualBlocked: true
    });
    const r = resolvePositionOwnership({
      symbol: "ETHUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.05,
      ledger,
      ledgerPaperContracts: 0.03,
      ledgerEntryPrice: 1900,
      okxAvgPx: 1900,
      explicitExternalManualEvidence: false,
      symbolExternalManualBlocked: true,
      manualOwnershipLatchActive: false,
      syncStatus: "ALIGNED"
    });
    ok =
      run(
        "FLCASE E",
        trigger.shouldLatch === false &&
          r.manualLatchShouldBeActive === false &&
          r.ownershipClass === "BOT_V2_MANAGED",
        JSON.stringify({ trigger, class: r.ownershipClass })
      ) && ok;
  }

  // FLCASE F: OKX fetch failure → latch forbidden
  {
    const trigger = evaluateManualOwnershipLatchTrigger({
      ledger: botLedger({ okxContracts: 0.06 }),
      syncStatus: "REMOTE_UNAVAILABLE",
      okxActualContracts: 0,
      okxActualPositionExists: false,
      okxFetchReady: false,
      ledgerPaperContracts: 0.06
    });
    ok =
      run(
        "FLCASE F",
        trigger.shouldLatch === false &&
          (trigger.reason === "OKX_FETCH_FAILURE" || trigger.reason === "REMOTE_UNAVAILABLE"),
        JSON.stringify(trigger)
      ) && ok;
  }

  // FLCASE G: confirmed external contract change, no bot evidence → latch allowed
  {
    const trigger = evaluateManualOwnershipLatchTrigger({
      ledger: unattributedLedger({ okxContracts: 0.03, isV2Authority: false }),
      syncStatus: "ALIGNED",
      okxActualContracts: 0.06,
      okxActualPositionExists: true,
      ledgerPaperContracts: 0.03,
      ledgerEntryPrice: 1900,
      okxAvgPx: 1900,
      symbolExternalManualBlocked: false
    });
    ok =
      run(
        "FLCASE G",
        trigger.shouldLatch === true &&
          trigger.strength === "STRONG" &&
          trigger.source === "CONFIRMED_MANUAL_SIZE_CHANGE",
        JSON.stringify(trigger)
      ) && ok;
  }

  // LATCH 1: bot-attributed mismatch under sync block → BOT managed, no new latch
  {
    const r = resolvePositionOwnership(manualResolveInput());
    ok =
      run(
        "LATCH 1",
        r.ownershipClass === "BOT_V2_MANAGED" &&
          r.manualLatchShouldBeActive === false,
        JSON.stringify(r)
      ) && ok;
  }

  // LATCH 2: next cycle same state with STRONG latch persisted → stays EXTERNAL_MANUAL_MANAGED
  {
    const r = resolvePositionOwnership(
      manualResolveInput({
        latch: true,
        ledger: {
          manualOwnershipLatchSource: "EXPLICIT_EXTERNAL_FILL",
          manualOwnershipLatchStrength: "STRONG",
          lifecycleState: "EXTERNAL_MANUAL_MANAGED"
        },
        explicitManual: true
      })
    );
    ok =
      run(
        "LATCH 2",
        r.ownershipClass === "EXTERNAL_MANUAL_MANAGED" &&
          r.manualOwnershipLatchActive === true &&
          r.lifecycleAfter === "EXTERNAL_MANUAL_MANAGED",
        r.ownershipSource
      ) && ok;
  }

  // LATCH 3: V2 bot evidence + contract mismatch under sync block → still BOT_V2, no latch
  {
    const r = resolvePositionOwnership(manualResolveInput());
    ok =
      run(
        "LATCH 3",
        r.ownershipClass === "BOT_V2_MANAGED" &&
          r.manualLatchShouldBeActive === false,
        r.ownershipClass
      ) && ok;
  }

  // LATCH 4: restart with STRONG latch + same OKX 0.06 → manual ownership restored
  {
    const r = resolvePositionOwnership(
      manualResolveInput({
        latch: true,
        blocked: false,
        explicitManual: true,
        syncStatus: "ALIGNED",
        ledger: {
          lifecycleState: "EXTERNAL_MANUAL_MANAGED",
          reconcileState: "MATCHED",
          manualOwnershipLatchSource: "EXPLICIT_EXTERNAL_FILL",
          manualOwnershipLatchStrength: "STRONG"
        }
      })
    );
    ok =
      run(
        "LATCH 4",
        r.ownershipClass === "EXTERNAL_MANUAL_MANAGED" &&
          r.lifecycleAfter === "EXTERNAL_MANUAL_MANAGED" &&
          r.manualOwnershipLatchActive === true,
        JSON.stringify(r)
      ) && ok;
  }

  // LATCH 5: OKX contracts 0 → NO_POSITION + latch cleared via terminal cleanup
  {
    const open = botLedger({
      okxContracts: 0.03,
      manualOwnershipLatch: true,
      manualOwnershipLatchReason: "paper_okx_contract_mismatch",
      manualOwnershipLatchSource: "paper_okx_contract_mismatch",
      manualOwnershipLatchStrength: "WEAK",
      lifecycleState: "EXTERNAL_MANUAL_MANAGED"
    });
    const r = resolvePositionOwnership({
      symbol: "ETHUSDT",
      side: "long",
      okxActualPositionExists: false,
      okxActualContracts: 0,
      ledger: open,
      ledgerPaperContracts: 0.03,
      explicitExternalManualEvidence: false,
      symbolExternalManualBlocked: false,
      manualOwnershipLatchActive: true,
      syncStatus: "ALIGNED"
    });
    const cleanup = applyPositionTerminalCleanup(open);
    ok =
      run(
        "LATCH 5",
        r.ownershipClass === "NO_POSITION" &&
          cleanup.fieldsCleared.includes("manualOwnershipLatch"),
        `${r.ownershipClass}, cleared=${cleanup.fieldsCleared.join(",")}`
      ) && ok;
  }

  // LATCH 6: after terminal, fresh pure V2 entry → BOT_V2_MANAGED allowed
  {
    const r = resolvePositionOwnership({
      symbol: "ETHUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.03,
      ledger: botLedger({
        lifecycleState: "OPEN",
        reconcileState: "MATCHED",
        okxContracts: 0.03,
        manualOwnershipLatch: undefined
      }),
      ledgerPaperContracts: 0.03,
      ledgerEntryPrice: 1900,
      okxAvgPx: 1900,
      explicitExternalManualEvidence: false,
      symbolExternalManualBlocked: false,
      manualOwnershipLatchActive: false
    });
    ok =
      run(
        "LATCH 6",
        r.ownershipClass === "BOT_V2_MANAGED" &&
          r.manualLatchShouldBeActive === false &&
          !isAutomatedOrderMutationBlockedForOwnership(r),
        r.ownershipClass
      ) && ok;
  }

  // LATCH 7: contract mismatch detection helper
  {
    const evidence = detectManualInterventionEvidence({
      ledgerPaperContracts: 0.03,
      okxActualContracts: 0.06,
      ledgerEntryPrice: 1900,
      okxAvgPx: 1900,
      explicitExternalManualEvidence: false,
      symbolExternalManualBlocked: false,
      manualOwnershipLatchActive: false
    });
    ok =
      run(
        "LATCH 7",
        evidence.detected === true && evidence.reason === "paper_okx_contract_mismatch",
        JSON.stringify(evidence)
      ) && ok;
  }

  const fixedNow = 10_000_000;

  // LATCH FP 1: V2 ADDON fill just after paper 0.03 / OKX 0.05 with bot attribution → no latch
  {
    const ledger = botLedger({
      okxContracts: 0.03,
      lifecycleState: "ADDON_ACTIVE",
      addonRebuildPendingConfirmation: true
    });
    const r = resolvePositionOwnership({
      symbol: "ETHUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.05,
      ledger,
      ledgerPaperContracts: 0.03,
      ledgerEntryPrice: 1900,
      okxAvgPx: 1900,
      explicitExternalManualEvidence: false,
      symbolExternalManualBlocked: true,
      manualOwnershipLatchActive: false
    });
    ok =
      run(
        "LATCH FP 1",
        r.manualLatchShouldBeActive === false &&
          r.ownershipClass === "BOT_V2_MANAGED" &&
          isBotAttributedTransientMismatch(ledger, fixedNow),
        JSON.stringify({ latch: r.manualLatchShouldBeActive, class: r.ownershipClass })
      ) && ok;
  }

  // LATCH FP 2: V2 REDUCE fill transient mismatch → no latch
  {
    const ledger = botLedger({
      okxContracts: 0.05,
      lifecycleState: "PARTIAL_PENDING",
      partialPendingOrdId: "ord-reduce-1",
      partialPendingContracts: 0.02,
      partialPendingAt: fixedNow - 5_000
    });
    const r = resolvePositionOwnership({
      symbol: "ETHUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.03,
      ledger,
      ledgerPaperContracts: 0.05,
      ledgerEntryPrice: 1900,
      okxAvgPx: 1900,
      explicitExternalManualEvidence: false,
      symbolExternalManualBlocked: true,
      manualOwnershipLatchActive: false
    });
    ok =
      run(
        "LATCH FP 2",
        r.manualLatchShouldBeActive === false &&
          r.ownershipClass === "BOT_V2_MANAGED" &&
          isBotAttributedTransientMismatch(ledger, fixedNow),
        JSON.stringify({ latch: r.manualLatchShouldBeActive, class: r.ownershipClass })
      ) && ok;
  }

  // LATCH FP 3: no bot attribution paper 0.03 / OKX 0.06 → latch
  {
    const ledger = unattributedLedger();
    const evidence = detectManualInterventionEvidence({
      ledgerPaperContracts: 0.03,
      okxActualContracts: 0.06,
      ledgerEntryPrice: 1900,
      okxAvgPx: 1900,
      explicitExternalManualEvidence: false,
      symbolExternalManualBlocked: false,
      manualOwnershipLatchActive: false,
      ledger
    });
    const r = resolvePositionOwnership({
      symbol: "ETHUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.06,
      ledger,
      ledgerPaperContracts: 0.03,
      ledgerEntryPrice: 1900,
      okxAvgPx: 1900,
      explicitExternalManualEvidence: false,
      symbolExternalManualBlocked: false,
      manualOwnershipLatchActive: false,
      syncStatus: "ALIGNED",
      reconcileState: "MATCHED"
    });
    ok =
      run(
        "LATCH FP 3",
        evidence.detected === true &&
          evidence.reason === "paper_okx_contract_mismatch" &&
          r.manualLatchShouldBeActive === true &&
          !isBotAttributedTransientMismatch(ledger, fixedNow),
        JSON.stringify({ evidence, latch: r.manualLatchShouldBeActive })
      ) && ok;
  }

  // LATCH FP 4: bot order terminal complete, unexplained mismatch → latch
  {
    const ledger = botLedger({
      okxContracts: 0.03,
      lifecycleState: "BOT_V2_MANAGED",
      reconcileState: "MATCHED",
      addonRebuildPendingConfirmation: false,
      partialPendingOrdId: undefined,
      shockReduceState: "TERMINAL"
    });
    const r = resolvePositionOwnership({
      symbol: "ETHUSDT",
      side: "long",
      okxActualPositionExists: true,
      okxActualContracts: 0.06,
      ledger,
      ledgerPaperContracts: 0.03,
      ledgerEntryPrice: 1900,
      okxAvgPx: 1900,
      explicitExternalManualEvidence: false,
      symbolExternalManualBlocked: false,
      manualOwnershipLatchActive: false,
      syncStatus: "ALIGNED",
      reconcileState: "MATCHED"
    });
    ok =
      run(
        "LATCH FP 4",
        r.manualLatchShouldBeActive === true &&
          r.ownershipClass === "EXTERNAL_MANUAL_MANAGED" &&
          !isBotAttributedTransientMismatch(ledger, fixedNow),
        JSON.stringify(r)
      ) && ok;
  }

  return ok;
}

if (require.main === module) {
  process.exit(runV2PositionLifecycleCaseTests() ? 0 : 1);
}
