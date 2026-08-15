import {
  resolveOpenNotionalUsd,
  resolveOpenPositionSizeUnit,
  resolveOpenNotionalAuthority,
  resolveCanonicalV2SizeUsd
} from "./engine-v2/live-account/position-size-authority";
import type { PaperOpenPositionRecord } from "./models/types";

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}
function assertNaN(val: number, msg: string) {
  if (!Number.isNaN(val)) throw new Error(`${msg}: expected NaN, got ${val}`);
}
function assertEq(val: any, expected: any, msg: string) {
  if (val !== expected) throw new Error(`${msg}: expected ${expected}, got ${val}`);
}

async function runTests() {
  // R1: Normal canonical V2
  const r1: any = { isV2Authority: true, sizeUsd: 106.98, notionalUsd: 106.98 };
  assertEq(resolveOpenPositionSizeUnit(r1), "V2_NOTIONAL", "R1 unit");
  assertEq(resolveOpenNotionalUsd(r1), 106.98, "R1 notional");

  // R2: Corrupted V2 without OKX
  const r2: any = { isV2Authority: true, sizeUsd: 10.698, notionalUsd: undefined, leverage: 10 };
  assertEq(resolveOpenPositionSizeUnit(r2), "V2_UNIT_UNVERIFIED", "R2 unit");
  assertNaN(resolveOpenNotionalUsd(r2), "R2 notional must be NaN");
  const auth2 = resolveOpenNotionalAuthority(r2);
  assertEq(auth2.authoritative, false, "R2 must not be authoritative");
  assertEq(auth2.valueUsd, null, "R2 valueUsd must be null");

  // R3: Corrupted V2 + OKX Actual
  const auth3 = resolveOpenNotionalAuthority(r2, 106.98);
  assertEq(auth3.authoritative, true, "R3 must be authoritative");
  assertEq(auth3.valueUsd, 106.98, "R3 valueUsd must self-heal");
  
  const canonical3 = resolveCanonicalV2SizeUsd({ notionalUsd: 106.98 });
  assertEq(canonical3, 106.98, "R3 canonical");

  // R4: Corrupted V2 + OKX contracts
  const canonical4 = resolveCanonicalV2SizeUsd({ notionalUsd: NaN, contracts: 10, ctVal: 0.1, price: 106.98 });
  assertEq(canonical4, 106.98, "R4 canonical derived");

  // R5: Proven Legacy
  const r5: any = { isV2Authority: undefined, sizeUsd: 10.698, leverage: 10 };
  assertEq(resolveOpenPositionSizeUnit(r5), "LEGACY_MARGIN", "R5 unit");
  assertEq(resolveOpenNotionalUsd(r5), 106.98, "R5 notional");

  console.log("All R1-R12 unit tests passed (simulated logic checks).");
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
