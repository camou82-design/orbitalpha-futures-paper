import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluatePositionProtectionState } from "../engine-v2/execution/protective-order-state";
import {
  resolveProtectiveExistingAlgoLedgerAdoption
} from "./paper-engine";

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  if (!value) throw new Error(`${label}: expected true`);
}

function assertFalse(value: boolean, label: string): void {
  if (value) throw new Error(`${label}: expected false`);
}

const SL = "3823004965083664384";
const TP = "3823004969110196224";

function runCases(): void {
  // CASE A — canonical SL+TP exist, ledger flags false/true/false → repair without submit
  const caseA = resolveProtectiveExistingAlgoLedgerAdoption({
    previousIsProtectiveStopRegistered: false,
    previousIsProtectionFailed: true,
    previousIsTakeProfitRegistered: false,
    previousProtectiveStopAlgoId: undefined,
    previousProtectiveSlAlgoId: undefined,
    previousProtectiveTpAlgoId: undefined,
    slAlgoId: SL,
    tpAlgoId: TP,
    wantsTp: true,
    slCanonicalMatch: true,
    tpCanonicalMatch: true
  });
  assertTrue(caseA.slAdopted, "CASE A slAdopted");
  assertTrue(caseA.tpAdopted, "CASE A tpAdopted");
  assertTrue(caseA.protectionComplete, "CASE A protectionComplete");
  assertTrue(caseA.isProtectiveStopRegistered, "CASE A isProtectiveStopRegistered");
  assertFalse(caseA.isProtectionFailed, "CASE A isProtectionFailed cleared");
  assertTrue(caseA.isTakeProfitRegistered, "CASE A isTakeProfitRegistered");
  assertEq(caseA.protectiveStopAlgoId, SL, "CASE A sl algo id");
  assertEq(caseA.protectiveTpAlgoId, TP, "CASE A tp algo id");
  assertTrue(caseA.ledgerRepairNeeded, "CASE A ledgerRepairNeeded");
  assertTrue(caseA.ledgerRepairNeeded && caseA.protectionComplete, "CASE A success path");

  // CASE B — canonical SL only, TP required but missing → partial adopt, not complete
  const caseB = resolveProtectiveExistingAlgoLedgerAdoption({
    previousIsProtectiveStopRegistered: false,
    previousIsProtectionFailed: true,
    previousIsTakeProfitRegistered: false,
    previousProtectiveStopAlgoId: undefined,
    previousProtectiveSlAlgoId: undefined,
    previousProtectiveTpAlgoId: undefined,
    slAlgoId: SL,
    tpAlgoId: null,
    wantsTp: true,
    slCanonicalMatch: true,
    tpCanonicalMatch: false
  });
  assertTrue(caseB.slAdopted, "CASE B slAdopted");
  assertFalse(caseB.tpAdopted, "CASE B tpAdopted");
  assertFalse(caseB.protectionComplete, "CASE B not protectionComplete");
  assertTrue(caseB.isProtectiveStopRegistered, "CASE B SL registered");
  assertFalse(caseB.isTakeProfitRegistered, "CASE B TP not registered");
  assertTrue(caseB.isProtectionFailed, "CASE B remains failed until TP repaired");
  assertTrue(caseB.ledgerRepairNeeded, "CASE B partial ledger repair");

  // CASE C — mismatch algo must not be adopted
  const caseC = resolveProtectiveExistingAlgoLedgerAdoption({
    previousIsProtectiveStopRegistered: false,
    previousIsProtectionFailed: true,
    previousIsTakeProfitRegistered: false,
    previousProtectiveStopAlgoId: undefined,
    previousProtectiveSlAlgoId: undefined,
    previousProtectiveTpAlgoId: undefined,
    slAlgoId: SL,
    tpAlgoId: TP,
    wantsTp: true,
    slCanonicalMatch: false,
    tpCanonicalMatch: false
  });
  assertFalse(caseC.slAdopted, "CASE C sl not adopted");
  assertFalse(caseC.tpAdopted, "CASE C tp not adopted");
  assertTrue(caseC.isProtectionFailed, "CASE C remains failed");

  // CASE D — ledger already matches → idempotent, no repair
  const caseD = resolveProtectiveExistingAlgoLedgerAdoption({
    previousIsProtectiveStopRegistered: true,
    previousIsProtectionFailed: false,
    previousIsTakeProfitRegistered: true,
    previousProtectiveStopAlgoId: SL,
    previousProtectiveSlAlgoId: SL,
    previousProtectiveTpAlgoId: TP,
    slAlgoId: SL,
    tpAlgoId: TP,
    wantsTp: true,
    slCanonicalMatch: true,
    tpCanonicalMatch: true
  });
  assertTrue(caseD.protectionComplete, "CASE D protectionComplete");
  assertFalse(caseD.ledgerRepairNeeded, "CASE D idempotent no repair");

  // CASE E — BTC suppressor + ensureProtectiveStopOrder adoption proof still present
  const source = readFileSync(join(__dirname, "../../src/engine/paper-engine.ts"), "utf8");
  assertTrue(
    source.includes("isBtcPositionManagementBlocked()") &&
      source.includes("V2_PROTECTIVE_EXISTING_ALGO_ADOPTED_PROOF") &&
      source.includes("existingAlgoAdoption.ledgerRepairNeeded"),
    "CASE E BTC suppressor and adoption proof coexist"
  );
  assertTrue(
    source.includes("existingAlgoAdoption.ledgerRepairNeeded") &&
      source.includes("modified = true"),
    "CASE E ledger repair sets modified for persistence"
  );

  // CASE H — canonical BTC protective algo → found=true, consistency PASS
  const caseH = evaluatePositionProtectionState({
    instId: "BTC-USDT-SWAP",
    positionSide: "long",
    pending: [],
    algos: [
      {
        instId: "BTC-USDT-SWAP",
        posSide: "long",
        side: "sell",
        reduceOnly: "true",
        slTriggerPx: "64013.2",
        algoId: SL
      }
    ],
    tpRequired: false,
    ledger: {
      symbol: "BTCUSDT",
      side: "long",
      stopPrice: 64013.2,
      okxContracts: 0.19
    } as any,
    tickSz: 0.1,
    requiredStopPx: 64013.2,
    requiredContracts: 0.19
  });
  assertTrue(caseH.canonicalProtectiveSlFound, "CASE H canonical SL");
  assertTrue(caseH.reduceOnlyProtectiveFound, "CASE H protective found");
  assertEq(caseH.consistencyCheck, "PASS", "CASE H consistency PASS");

  console.info(JSON.stringify({
    event: "PROTECTIVE_EXISTING_ALGO_ADOPTION_CASES_PASS",
    cases: ["A", "B", "C", "D", "E", "H"]
  }));
}

runCases();
