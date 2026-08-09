import type { PaperOpenPositionRecord } from "../models/types";
import {
  classifyOkxOpenOrderPurpose,
  countBlockingOkxOpenOrders,
  evaluateV2ReducePendingGuard
} from "./position-ops-monitor";

const SL_ALGO = "3817272041763885056";
const TP_ALGO = "3817272045823971328";
const INST = "BTC-USDT-SWAP";

function baseLedger(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
  return {
    symbol: "BTCUSDT",
    side: "long",
    instId: INST,
    openedAt: Date.now(),
    entryPrice: 90000,
    sizeUsd: 100,
    protectiveSlAlgoId: SL_ALGO,
    protectiveTpAlgoId: TP_ALGO,
    ...overrides
  } as PaperOpenPositionRecord;
}

function runCase(label: string, passed: boolean, detail: string): boolean {
  console.log(`[${label}] ${passed ? "PASS" : "FAIL"} — ${detail}`);
  return passed;
}

export function runOkxOpenOrderClassifyTests(): boolean {
  let allPassed = true;
  const ledger = baseLedger();

  // CASE A
  const caseA = classifyOkxOpenOrderPurpose(
    { algoId: SL_ALGO, instId: INST, posSide: "long", reduceOnly: "true" },
    ledger
  );
  allPassed =
    runCase(
      "CASE A",
      caseA.purpose === "protective-stop" && caseA.manualReduceDetected === false,
      `purpose=${caseA.purpose}, manual=${caseA.manualReduceDetected}`
    ) && allPassed;

  // CASE B
  const caseB = classifyOkxOpenOrderPurpose(
    { algoId: TP_ALGO, instId: INST, posSide: "long", reduceOnly: "true" },
    ledger
  );
  allPassed =
    runCase(
      "CASE B",
      caseB.purpose === "protective-take-profit" && caseB.manualReduceDetected === false,
      `purpose=${caseB.purpose}, manual=${caseB.manualReduceDetected}`
    ) && allPassed;

  // CASE C
  const caseC = classifyOkxOpenOrderPurpose(
    { algoId: "9999999999999999999", instId: INST, posSide: "long", reduceOnly: "true" },
    ledger
  );
  allPassed =
    runCase(
      "CASE C",
      caseC.purpose === "manual-reduce-purpose" && caseC.manualReduceDetected === true,
      `purpose=${caseC.purpose}, manual=${caseC.manualReduceDetected}`
    ) && allPassed;

  // CASE D
  const blocking = countBlockingOkxOpenOrders(
    [],
    [
      { algoId: SL_ALGO, instId: INST, posSide: "long", reduceOnly: "true", ordType: "conditional", slTriggerPx: "85000" },
      { algoId: TP_ALGO, instId: INST, posSide: "long", reduceOnly: "true", ordType: "conditional", tpTriggerPx: "95000" }
    ],
    [ledger]
  );
  const caseDReady =
    blocking.blockingPendingCount === 0 &&
    blocking.blockingAlgosCount === 0 &&
    blocking.botManagedProtectiveCount === 2;
  allPassed =
    runCase(
      "CASE D",
      caseDReady,
      `blockingPending=${blocking.blockingPendingCount}, blockingAlgos=${blocking.blockingAlgosCount}, botManaged=${blocking.botManagedProtectiveCount}`
    ) && allPassed;

  // CASE E
  const pendingOpen = baseLedger({
    lifecycleState: "PARTIAL_PENDING",
    partialPendingOrdId: "ord-pending-1",
    partialPendingClOrdId: "oap123456",
    partialPendingContracts: 2
  });
  const caseE = evaluateV2ReducePendingGuard({
    open: pendingOpen,
    flowId: "BTCUSDT:long:123",
    instId: INST,
    pendingSwapOrders: [
      {
        instId: INST,
        posSide: "long",
        reduceOnly: "true",
        clOrdId: "oap123456",
        ordId: "ord-pending-1",
        state: "live"
      }
    ]
  });
  allPassed =
    runCase(
      "CASE E",
      caseE.pending === true && caseE.submitAllowed === false,
      `pending=${caseE.pending}, submit_allowed=${caseE.submitAllowed}`
    ) && allPassed;

  // CASE F
  const clearedOpen = baseLedger({ lifecycleState: "OPEN" });
  const caseF = evaluateV2ReducePendingGuard({
    open: clearedOpen,
    flowId: "BTCUSDT:long:123",
    instId: INST,
    pendingSwapOrders: [
      {
        instId: INST,
        posSide: "long",
        reduceOnly: "true",
        clOrdId: "oap123456",
        ordId: "ord-pending-1",
        state: "filled"
      }
    ]
  });
  allPassed =
    runCase(
      "CASE F",
      caseF.pending === false && caseF.submitAllowed === true,
      `pending=${caseF.pending}, submit_allowed=${caseF.submitAllowed}, terminal=${caseF.terminalState}`
    ) && allPassed;

  return allPassed;
}

if (require.main === module) {
  const ok = runOkxOpenOrderClassifyTests();
  process.exit(ok ? 0 : 1);
}
