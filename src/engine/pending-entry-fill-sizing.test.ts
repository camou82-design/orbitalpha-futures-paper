import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePendingFillRecordSizing } from "./paper-engine";

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (typeof actual === "number" && typeof expected === "number") {
    if (Math.abs(actual - expected) > 1e-9) {
      throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
    return;
  }
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  if (!value) throw new Error(`${label}: expected true`);
}

function runTests(): void {
  // CASE 1: ETH ctVal=0.1, pos=1.34 contracts (LONG)
  const ethLong = resolvePendingFillRecordSizing({
    actualPos: {
      pos: "1.34",
      avgPx: "2500.0",
      notionalUsd: "335.0"
    },
    ctVal: 0.1
  });

  assertEq(ethLong.contractsAbs, 1.34, "ETH LONG contractsAbs == 1.34");
  assertEq(ethLong.baseQtyAbs, 0.134, "ETH LONG baseQtyAbs == 0.134 (1.34 * 0.1)");
  assertEq(ethLong.actualAvgPx, 2500.0, "ETH LONG actualAvgPx == 2500.0");
  assertEq(ethLong.notionalUsd, 335.0, "ETH LONG notionalUsd == 335.0");

  // CASE 2: ETH ctVal=0.1, pos=-1.34 contracts (SHORT)
  const ethShort = resolvePendingFillRecordSizing({
    actualPos: {
      pos: "-1.34",
      avgPx: "2500.0",
      notionalUsd: "335.0"
    },
    ctVal: 0.1
  });

  assertEq(ethShort.contractsAbs, 1.34, "ETH SHORT contractsAbs == 1.34");
  assertEq(ethShort.baseQtyAbs, 0.134, "ETH SHORT baseQtyAbs == 0.134 (1.34 * 0.1)");
  assertEq(ethShort.actualAvgPx, 2500.0, "ETH SHORT actualAvgPx == 2500.0");
  assertEq(ethShort.notionalUsd, 335.0, "ETH SHORT notionalUsd == 335.0");

  // Symmetry check between LONG and SHORT
  assertEq(ethLong.contractsAbs, ethShort.contractsAbs, "LONG/SHORT contractsAbs symmetry");
  assertEq(ethLong.baseQtyAbs, ethShort.baseQtyAbs, "LONG/SHORT baseQtyAbs symmetry");
  assertEq(ethLong.notionalUsd, ethShort.notionalUsd, "LONG/SHORT notionalUsd symmetry");

  // CASE 3: Notional fallback when actualPos.notionalUsd is missing or 0
  const fallbackSizing = resolvePendingFillRecordSizing({
    actualPos: {
      pos: "1.34",
      avgPx: "2000.0",
      notionalUsd: 0
    },
    ctVal: 0.1
  });
  // baseQtyAbs = 0.134, actualAvgPx = 2000.0 -> notional fallback = 0.134 * 2000 = 268.0
  assertEq(fallbackSizing.notionalUsd, 268.0, "Notional fallback calculates baseQtyAbs * actualAvgPx");

  // CASE 4: Source code binding audit in paper-engine.ts
  const engineSource = readFileSync(join(__dirname, "paper-engine.ts"), "utf8");
  assertTrue(
    engineSource.includes("const sizing = resolvePendingFillRecordSizing("),
    "paper-engine calls resolvePendingFillRecordSizing"
  );
  assertTrue(
    engineSource.includes("record.pos = sizing.baseQtyAbs;"),
    "paper-engine assigns record.pos = sizing.baseQtyAbs"
  );
  assertTrue(
    engineSource.includes("record.baseQty = sizing.baseQtyAbs;"),
    "paper-engine assigns record.baseQty = sizing.baseQtyAbs"
  );
  assertTrue(
    engineSource.includes("record.okxContracts = sizing.contractsAbs;"),
    "paper-engine assigns record.okxContracts = sizing.contractsAbs"
  );
  assertTrue(
    engineSource.includes("record.exchangeFilledSize = sizing.contractsAbs;"),
    "paper-engine assigns record.exchangeFilledSize = sizing.contractsAbs"
  );

  console.info(JSON.stringify({
    event: "PENDING_ENTRY_FILL_SIZING_REGRESSION_PASS",
    cases: ["ETH_LONG_0.134_BASE_1.34_CT", "ETH_SHORT_0.134_BASE_1.34_CT", "SYMMETRY", "NOTIONAL_FALLBACK", "SOURCE_BINDING"]
  }));
}

runTests();
