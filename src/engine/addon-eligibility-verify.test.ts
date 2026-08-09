import type { PaperOpenPositionRecord } from "../models/types";
import { countBlockingOkxOpenOrders } from "./position-ops-monitor";
import { buildV2AddonEligibilityProof } from "../engine-v2/addon/eligibility-proof";
import { evaluateV2AddOnPolicy } from "../engine-v2/addon/policy";
import type { V2StateAuthority } from "../engine-v2/state/types";

const SL_ALGO = "3817272041763885056";
const TP_ALGO = "3817272045823971328";
const INST = "BTC-USDT-SWAP";

function run(label: string, passed: boolean, detail: string): boolean {
  console.log(`[${label}] ${passed ? "PASS" : "FAIL"} — ${detail}`);
  return passed;
}

function baseShortLedger(): PaperOpenPositionRecord {
  return {
    symbol: "BTCUSDT",
    side: "short",
    instId: INST,
    openedAt: Date.now(),
    entryPrice: 95000,
    sizeUsd: 120,
    leverage: 10,
    strategyVersion: "test",
    sourceSignal: "test",
    sourceRunPath: "test",
    protectiveSlAlgoId: SL_ALGO,
    protectiveTpAlgoId: TP_ALGO,
    entryStage: 1,
    pnlPct: -0.004
  } as unknown as PaperOpenPositionRecord;
}

export function runAddonEligibilityVerificationTests(): boolean {
  let ok = true;

  // 1) Protective algos no longer fail-closed pending authority
  const blocking = countBlockingOkxOpenOrders(
    [],
    [
      { algoId: SL_ALGO, instId: INST, posSide: "short", reduceOnly: "true", ordType: "conditional", slTriggerPx: "98000" },
      { algoId: TP_ALGO, instId: INST, posSide: "short", reduceOnly: "true", ordType: "conditional", tpTriggerPx: "90000" }
    ],
    [baseShortLedger()]
  );
  const authorityReady = blocking.blockingAlgosCount === 0 && blocking.blockingPendingCount === 0;
  ok = run("AUTHORITY pending ready (bot SL/TP only)", authorityReady, JSON.stringify(blocking)) && ok;

  // 2) Loss short without same-side confirmation must NOT auto-addon
  const v2State = {
    longPosition: null,
    shortPosition: {
      symbol: "BTCUSDT",
      side: "short",
      entryPrice: 95000,
      sizeUsd: 120,
      entryStage: 1,
      pnlPct: -0.004,
      breakevenStopRequired: true,
      breakevenStopConfirmed: false
    },
    currentPositions: [baseShortLedger()],
    crashState: "",
    pumpState: "",
    accountEquityKrw: 1_960_000
  } as unknown as V2StateAuthority;

  const addOnPolicy = evaluateV2AddOnPolicy({
    symbol: "BTCUSDT",
    side: "short",
    v2State,
    judgment: {
      regime_final: "TREND",
      subtype: "NONE",
      shockPhase: "NONE",
      rangePhase: "NONE",
      trendPhase: "DOWN",
      transitionPhase: "NONE"
    } as any,
    execution: { signal: "WAIT_RECHECK", side: "none" } as any,
    snapshot: {
      qualityScore: 85,
      reviewing_ticks: 2,
      boxPos: 0.8,
      emaGap: 0.004,
      trendWeaknessScore: 0.3,
      rangeConfidence: 0.7,
      lastPrice: 95400,
      atr: 500
    },
    accountEquityUsd: 1400,
    currentSymbolNotionalUsd: 120,
    currentGlobalNotionalUsd: 120
  });

  const proofBlocked = buildV2AddonEligibilityProof({
    symbol: "BTCUSDT",
    positionSide: "short",
    authoritySide: "short",
    currentNotionalUsdt: 120,
    addonRequestedNotionalUsdt: 0,
    addOnPolicy,
    executionAction: "NONE",
    finalDecision: "REJECT",
    liveReadinessPassed: authorityReady,
    okxPendingOrdersReady: authorityReady,
    minOrderBlockReason: null,
    riskBlockReason: "ADDON_POLICY_DENIED",
    cooldownBlocked: false,
    cooldownReason: null,
    currentPrice: 95400,
    entryPrice: 95000
  });

  ok =
    run(
      "ADDON not forced on loss without confirmation",
      addOnPolicy.allowed === false &&
        addOnPolicy.addonBlockedReason === "SAME_SIDE_CONFIRMATION_NOT_MET" &&
        proofBlocked.add_on_allowed === false,
      `policy=${addOnPolicy.reason}, block=${proofBlocked.block_reason}, mode=${addOnPolicy.addonMode}`
    ) && ok;

  ok =
    run(
      "V2_ADDON_ELIGIBILITY_PROOF fields",
      proofBlocked.event === "V2_ADDON_ELIGIBILITY_PROOF" &&
        proofBlocked.position_side === "short" &&
        proofBlocked.authority_side === "short" &&
        proofBlocked.block_reason != null &&
        proofBlocked.adverse_move_pct > 0,
      JSON.stringify({
        add_on_allowed: proofBlocked.add_on_allowed,
        block_reason: proofBlocked.block_reason,
        adverse_move_pct: proofBlocked.adverse_move_pct
      })
    ) && ok;

  // 3) Authority ready path: pending ready + policy allowed shape → no LIVE_ACCOUNT block
  const proofAuthority = buildV2AddonEligibilityProof({
    symbol: "BTCUSDT",
    positionSide: "short",
    authoritySide: "short",
    currentNotionalUsdt: 120,
    addonRequestedNotionalUsdt: 40,
    addOnPolicy: {
      ...addOnPolicy,
      allowed: true,
      reason: "TREND_PYRAMID_PROFIT_FUNDED_ALLOWED" as any,
      addonMode: "PYRAMIDING" as const
    },
    executionAction: "ADDON",
    finalDecision: "ENTER",
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
      "ADDON path reachable when policy+authority ready",
      proofAuthority.add_on_allowed === true && proofAuthority.block_reason == null,
      JSON.stringify(proofAuthority)
    ) && ok;

  return ok;
}

if (require.main === module) {
  process.exit(runAddonEligibilityVerificationTests() ? 0 : 1);
}
