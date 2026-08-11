import { evaluateV2ExitPolicy } from "../engine-v2/exit/policy";
import {
  persistPendingCompletedTradeFinalize,
  clearPendingCompletedTradeFinalize,
  isOpenLedgerTerminalCleanupBlocked,
  buildClosedRowFromPendingFinalize
} from "../engine-v2/lifecycle/pending-finalize";
import type { PaperOpenPositionRecord } from "../models/types";
import type { MarketJudgmentOutput } from "../engine-v2/types";

function run(label: string, ok: boolean, detail: string): boolean {
  console.log(`[${label}] ${ok ? "PASS" : "FAIL"} — ${detail}`);
  return ok;
}

function botOpen(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
  return {
    symbol: "ETHUSDT",
    side: "long",
    openedAt: 1786408899302,
    entryPrice: 1872.29,
    avgPx: 1872.29,
    okxContracts: 0.06,
    sizeUsd: 5,
    leverage: 10,
    isV2Authority: true,
    authoritySourceAtEntry: "v2",
    strategyVersion: "paper-v2",
    status: "open",
    sourceSignal: "v2_bot_entry",
    lifecycleState: "BOT_V2_MANAGED",
    reconcileState: "MATCHED",
    ...overrides
  } as PaperOpenPositionRecord;
}

function baseJudgment(overrides: Partial<MarketJudgmentOutput> = {}): MarketJudgmentOutput {
  return {
    regime: "RANGE",
    regime_final: "TREND",
    subtype: "RANGE_FLAT",
    shockPhase: "NONE",
    rangePhase: "UPPER",
    trendPhase: "UP",
    transitionPhase: "CONFLICT",
    reason: "test",
    ...overrides
  } as MarketJudgmentOutput;
}

function baseV2State(positionSide: "long" | "short" = "long") {
  return {
    symbolPositions: [
      {
        side: positionSide,
        pnlPct: 0.001,
        peakUnrealizedPnlPct: 0.02,
        sizeUsd: 5,
        entryStage: 1,
        tp1Triggered: false
      }
    ],
    crashState: "NONE",
    pumpState: "NONE"
  } as any;
}

async function main() {
  let ok = true;

  // FINALIZE A: pending context persisted + cleanup blocked
  {
    const open = botOpen();
    persistPendingCompletedTradeFinalize(open, {
      flowId: "ETHUSDT:long:1786408899302",
      positionCycleId: "ETHUSDT:long:1786408899302",
      entryAvgPx: 1872.29,
      exitAvgPx: 1877.57,
      finalCloseReason: "V2_EXIT",
      finalFillAt: Date.now(),
      tradeSource: "BOT_V2",
      cumulativePnlUsdNet: 0.5,
      cumulativeFeeUsd: 0.05,
      partialReduceCount: 0,
      closeReason: "v2_exit_authority",
      closeSource: "BOT_EXECUTION_ATTRIBUTION"
    });
    ok =
      run(
        "FINALIZE A",
        open.finalizePending === true && isOpenLedgerTerminalCleanupBlocked(open) === true,
        JSON.stringify({ pending: open.finalizePending, blocked: isOpenLedgerTerminalCleanupBlocked(open) })
      ) && ok;
  }

  // FINALIZE B: rebuild closed row from pending context
  {
    const open = botOpen({
      finalizePending: true,
      pendingFinalizeFlowId: "ETHUSDT:long:1786408899302",
      pendingFinalizeEntryAvgPx: 1872.29,
      pendingFinalizeExitAvgPx: 1877.57,
      pendingFinalizeFinalCloseReason: "V2_EXIT",
      pendingFinalizeFinalFillAt: 1786409999999,
      pendingFinalizeCumulativePnlUsdNet: 0.4,
      pendingFinalizeCumulativeFeeUsd: 0.04,
      pendingFinalizeCloseReason: "v2_exit_authority",
      pendingFinalizeCloseSource: "BOT_EXECUTION_ATTRIBUTION"
    });
    const row = buildClosedRowFromPendingFinalize(open, Date.now());
    ok =
      run(
        "FINALIZE B",
        row != null &&
          row.isPositionCycleFinal === true &&
          row.exitAvgPx === 1877.57 &&
          row.finalCloseReason === "V2_EXIT",
        JSON.stringify(row)
      ) && ok;
  }

  // FINALIZE C: clear pending restores cleanup allowance
  {
    const open = botOpen({ finalizePending: true, pendingFinalizeFlowId: "x" });
    clearPendingCompletedTradeFinalize(open);
    ok =
      run(
        "FINALIZE C",
        open.finalizePending !== true && isOpenLedgerTerminalCleanupBlocked(open) === false,
        String(open.finalizePending)
      ) && ok;
  }

  // HYST A: ETH-like weak opposite + profit protection → HOLD not FULL_EXIT
  {
    const r = evaluateV2ExitPolicy({
      symbol: "ETHUSDT",
      v2State: baseV2State("long"),
      judgment: baseJudgment(),
      snapshot: {
        boxPos: 0.8,
        boxBreakSide: "none",
        emaGap: 0.001,
        trendWeaknessScore: 0.2,
        rangeConfidence: 0.6,
        qualityScore: 71
      },
      trendSideCandidate: "long",
      rangeSideCandidate: "short",
      reversalConfirmed: false
    });
    ok =
      run(
        "HYST A",
        r.action !== "FULL_EXIT" &&
          r.oppositeHysteresisState === "PROFIT_PROTECT_HOLD" &&
          r.thesisValid === true,
        JSON.stringify({
          action: r.action,
          reason: r.reason,
          hysteresis: r.oppositeHysteresisState
        })
      ) && ok;
  }

  // HYST B: same-side trend UP + range short candidate only → HOLD
  {
    const r = evaluateV2ExitPolicy({
      symbol: "ETHUSDT",
      v2State: {
        ...baseV2State("long"),
        symbolPositions: [
          {
            side: "long",
            pnlPct: 0.01,
            peakUnrealizedPnlPct: 0.012,
            sizeUsd: 5,
            entryStage: 1
          }
        ]
      },
      judgment: baseJudgment({ transitionPhase: "CONFLICT" }),
      snapshot: {
        boxPos: 0.78,
        boxBreakSide: "none",
        emaGap: 0.0008,
        trendWeaknessScore: 0.25,
        rangeConfidence: 0.55,
        qualityScore: 65
      },
      trendSideCandidate: "long",
      rangeSideCandidate: "short"
    });
    ok =
      run(
        "HYST B",
        r.action === "HOLD" || r.action === "WATCH",
        `${r.action}|${r.reason}|${r.oppositeHysteresisState}`
      ) && ok;
  }

  // HYST C: invalidation breach → FULL_EXIT allowed
  {
    const r = evaluateV2ExitPolicy({
      symbol: "ETHUSDT",
      v2State: baseV2State("long"),
      judgment: baseJudgment({ regime_final: "RANGE", rangePhase: "LOWER" }),
      snapshot: {
        boxPos: 0.1,
        boxBreakSide: "lower",
        emaGap: -0.002,
        trendWeaknessScore: 0.35,
        rangeConfidence: 0.4,
        qualityScore: 50
      },
      trendSideCandidate: "short",
      rangeSideCandidate: "short"
    });
    ok =
      run(
        "HYST C",
        r.action === "FULL_EXIT" && r.reason === "RANGE_FULL_EXIT_BOX_BREAK",
        `${r.action}|${r.reason}|${r.oppositeHysteresisState}`
      ) && ok;
  }

  // HYST D: confirmed opposite + conflict → reduce not full exit from profit protect
  {
    const r = evaluateV2ExitPolicy({
      symbol: "ETHUSDT",
      v2State: {
        ...baseV2State("long"),
        symbolPositions: [
          {
            side: "long",
            pnlPct: 0.001,
            peakUnrealizedPnlPct: 0.02,
            sizeUsd: 5,
            entryStage: 1,
            tp1Triggered: false
          }
        ]
      },
      judgment: baseJudgment({ transitionPhase: "CONFLICT", subtype: "TRANSITION_CONFLICT" }),
      snapshot: {
        boxPos: 0.82,
        boxBreakSide: "none",
        emaGap: 0.0005,
        trendWeaknessScore: 0.35,
        rangeConfidence: 0.5,
        qualityScore: 60
      },
      trendSideCandidate: "long",
      rangeSideCandidate: "short",
      reversalConfirmed: true
    });
    ok =
      run(
        "HYST D",
        r.action === "REDUCE" || r.oppositeHysteresisState === "CONFIRMED_OPPOSITE_REDUCE",
        `${r.action}|${r.oppositeHysteresisState}`
      ) && ok;
  }

  if (!ok) process.exit(1);
  console.log("ALL FINALIZE/HYSTERESIS CASES PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
