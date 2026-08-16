/**
 * BLOCKER 4-7 — MANUAL POSITION EXCLUSION FROM V2 STRATEGY EXPOSURE
 * Regression test suite
 */

import {
  analyzePaperExposure
} from "../engine-v2/live-account/exposure-authority";
import { isV2AuthorityRow } from "../engine-v2/live-account/position-size-authority";

function run(label: string, passed: boolean, detail: string): boolean {
  const tag = passed ? "PASS" : "FAIL";
  console.log(`[BLOCKER-4-7][${label}] ${tag} — ${detail}`);
  return passed;
}

let allOk = true;

// CASE A & CASE B: Manual BTC 258 + BOT_V2 ETH 100
// → V2 strategy account exposure = 100, manual 258 is excluded from strategy cap
{
  const manualBtc: any = {
    symbol: "BTCUSDT",
    side: "long",
    sizeUsd: undefined,
    notionalUsd: undefined,
    strategyVersion: "v2_manual"
  };
  const botEth: any = {
    symbol: "ETHUSDT",
    side: "long",
    sizeUsd: undefined,
    notionalUsd: 100,
    lifecycleState: "BOT_V2_MANAGED"
  };
  const okxActualPositions = [
    { symbol: "BTCUSDT", side: "long", notionalUsd: 258 },
    { symbol: "ETHUSDT", side: "long", notionalUsd: 100 }
  ];
  
  const result = analyzePaperExposure([manualBtc, botEth], undefined, okxActualPositions);
  
  allOk = run(
    "CASE A & B - Total Exposure",
    result.total === 358,
    `total=${result.total} (Manual BTC + BOT_V2 ETH)`
  ) && allOk;

  allOk = run(
    "CASE A & B - Strategy Exposure",
    result.strategyOnly === 100,
    `strategyOnly=${result.strategyOnly} (Only ETH included)`
  ) && allOk;

  allOk = run(
    "CASE A & B - Manual External Exposure",
    result.manualExternal === 258,
    `manualExternal=${result.manualExternal} (Only BTC included)`
  ) && allOk;
}

// CASE C & D: BOT_V2 exposure is 400 → Both strategy and total have 400.
{
  const botEth: any = {
    symbol: "ETHUSDT",
    side: "short",
    sizeUsd: undefined,
    notionalUsd: 400,
    lifecycleState: "BOT_V2_MANAGED"
  };
  const okxActualPositions = [
    { symbol: "ETHUSDT", side: "short", notionalUsd: 400 }
  ];
  
  const result = analyzePaperExposure([botEth], undefined, okxActualPositions);
  
  allOk = run(
    "CASE C & D - Strategy Exposure = 400",
    result.strategyOnly === 400,
    `strategyOnly=${result.strategyOnly}`
  ) && allOk;
}

// CASE F: Corrupted V2 (V2_UNIT_UNVERIFIED) + OKX actual missing → Fail-closed
{
  const corruptedV2: any = {
    symbol: "ETHUSDT",
    side: "long",
    sizeUsd: undefined,
    notionalUsd: undefined,
    isV2Authority: true
  };
  const result = analyzePaperExposure([corruptedV2], undefined, undefined);
  
  allOk = run(
    "CASE F - Fail Closed Strategy",
    result.strategyOnly === null,
    `strategyOnly=${result.strategyOnly}`
  ) && allOk;
  
  allOk = run(
    "CASE F - Fail Closed Total",
    result.total === null,
    `total=${result.total}`
  ) && allOk;
}

// CASE G & H: Manual BTC + OKX missing → Fail-closed
{
  const manualBtc: any = {
    symbol: "BTCUSDT",
    side: "long",
    sizeUsd: undefined,
    notionalUsd: undefined,
    strategyVersion: "v2_manual"
  };
  const result = analyzePaperExposure([manualBtc], undefined, undefined);
  
  allOk = run(
    "CASE G & H - Fail Closed Missing Manual OKX",
    result.total === null,
    `total=${result.total} (Requires OKX actual for manual with unknown unit)`
  ) && allOk;
}

console.log("\n=== BLOCKER 4-7 SUMMARY ===");
if (allOk) {
  console.log("ALL_RELEVANT_REGRESSION = PASS");
  console.log("READY_TO_COMMIT_BLOCKER_4_7 = YES");
} else {
  console.error("ALL_RELEVANT_REGRESSION = FAIL");
  console.error("READY_TO_COMMIT_BLOCKER_4_7 = NO");
  process.exit(1);
}
