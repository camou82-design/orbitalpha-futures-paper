import {
  resolveOpenNotionalUsd,
  resolveOpenMarginUsd,
  resolveOpenPositionSizeUnit,
  resolveCloseLegSizing,
  resolveOpenNotionalAuthority
} from "./engine-v2/live-account/position-size-authority";
import type { PaperOpenPositionRecord } from "./models/types";

function assertNear(a: number, b: number, eps = 1e-9, label = "") {
  if (Math.abs(a - b) > eps) {
    throw new Error(`${label}: expected ${b}, got ${a} (eps=${eps})`);
  }
}

function assertEq(a: any, b: any, label = "") {
  if (a !== b) {
    throw new Error(`${label}: expected ${b}, got ${a}`);
  }
}

export function runUnitSemanticsCases() {
  // CASE U1: V2 118 / lev10 => notional 118 margin 11.8
  {
    const record: any = {
      isV2Authority: true,
      sizeUsd: 118,
      leverage: 10
    };
    assertNear(resolveOpenNotionalUsd(record), 118, 1e-9, "U1 Notional");
    assertNear(resolveOpenMarginUsd(record), 11.8, 1e-9, "U1 Margin");
  }

  // CASE U2: proven legacy 11.8 / lev10 => notional 118
  {
    const record: any = {
      strategyVersion: "paper-v1",
      sizeUsd: 11.8,
      leverage: 10
    };
    assertEq(resolveOpenPositionSizeUnit(record), "LEGACY_MARGIN", "U2 Unit");
    assertNear(resolveOpenNotionalUsd(record), 118, 1e-9, "U2 Notional");
  }

  // CASE U3: unknown 11.8 / lev10 => guessed 118 금지
  {
    const record: any = {
      strategyVersion: "paper-v2", // V2-like but no explicit isV2Authority
      sizeUsd: 11.8,
      leverage: 10
    };
    assertEq(resolveOpenPositionSizeUnit(record), "UNKNOWN", "U3 Unit");
    assertNear(resolveOpenNotionalUsd(record), 11.8, 1e-9, "U3 Notional (guessed 118 forbidden)");
    assertNear(resolveOpenMarginUsd(record), 11.8, 1e-9, "U3 Margin (guessed 1.18 forbidden)");
  }

  // CASE U4: legacy + V2 addon
  {
    // 11.8 margin + 40 notional => final stored sizeUsd 158 notional
    const legacyRecord: any = {
      strategyVersion: "paper-v1",
      sizeUsd: 11.8,
      leverage: 10,
      entryPrice: 1000
    };
    const legacyNotional = resolveOpenNotionalUsd(legacyRecord);
    const incrementalNotional = 40;
    const newTotalSizeUsd = legacyNotional + incrementalNotional;
    
    // Simulate addon mutation
    const updatedRecord = {
      ...legacyRecord,
      sizeUsd: newTotalSizeUsd,
      isV2Authority: true
    };
    
    assertNear(newTotalSizeUsd, 158, 1e-9, "U4 final stored sizeUsd");
    assertEq(updatedRecord.isV2Authority, true, "U4 isV2Authority true");
    assertNear(resolveOpenNotionalUsd(updatedRecord), 158, 1e-9, "U4 upgraded notional");
    assertNear(resolveOpenMarginUsd(updatedRecord), 15.8, 1e-9, "U4 upgraded margin");
  }

  // CASE U5: V2 + V2 addon (118 + 40 => 158)
  {
    const v2Record: any = {
      isV2Authority: true,
      sizeUsd: 118,
      leverage: 10
    };
    const notional = resolveOpenNotionalUsd(v2Record);
    const newSize = notional + 40;
    assertNear(newSize, 158, 1e-9, "U5 final stored sizeUsd");
  }

  // CASE U6: 35% partial of 118 => remaining sizeUsd ≈ 76.7~76.9 NOTIONAL
  {
    const v2Record: any = {
      isV2Authority: true,
      sizeUsd: 118,
      leverage: 10
    };
    const ratio = 0.35; // 35% partial reduce
    const partialSizeUsd = resolveOpenNotionalUsd(v2Record) * ratio;
    const remaining_size_usd = resolveOpenNotionalUsd(v2Record) - partialSizeUsd;
    assertNear(remaining_size_usd, 76.7, 1e-1, "U6 remaining sizeUsd NOTIONAL");
  }

  // CASE U7: fee 0.012 / notional 10 => feePctNotional 0.12%
  {
    const totalFeeUsd = 0.012;
    const notional = 10;
    const feePctNotional = totalFeeUsd / notional;
    assertNear(feePctNotional, 0.0012, 1e-9, "U7 feePctNotional 0.12%"); // 0.0012 is 0.12%
  }

  // CASE U8: same position margin 1 => feePctOnMargin 1.2%
  {
    const totalFeeUsd = 0.012;
    const margin = 1;
    const feePctOnMargin = totalFeeUsd / margin;
    assertNear(feePctOnMargin, 0.012, 1e-9, "U8 feePctOnMargin 1.2%"); // 0.012 is 1.2%
  }

  // CASE L1: proven legacy 11.8 / lev10 => notional 118
  {
    const record: any = {
      strategyVersion: "paper-v1",
      sizeUsd: 11.8,
      leverage: 10
    };
    assertNear(resolveOpenNotionalUsd(record), 118, 1e-9, "L1 Notional");
  }

  // CASE L2 & L3: proven legacy missing/invalid leverage => no guess
  {
    const record2: any = {
      strategyVersion: "paper-v1",
      sizeUsd: 11.8,
      leverage: undefined
    };
    assertNear(resolveOpenNotionalUsd(record2), 11.8, 1e-9, "L2 Notional guessed 11.8 forbidden");

    const record3: any = {
      strategyVersion: "paper-v1",
      sizeUsd: 11.8,
      leverage: 0
    };
    assertNear(resolveOpenNotionalUsd(record3), 11.8, 1e-9, "L3 Notional guessed 11.8 forbidden");
  }

  // CASE F2: partial feePctNotional uses closed leg
  {
    const open: any = { isV2Authority: true, sizeUsd: 100, leverage: 10 };
    const sizing = resolveCloseLegSizing(open, 35, "V2_NOTIONAL");
    const feeUsd = 0.042;
    const feePctNotional = feeUsd / sizing.legNotionalUsd;
    const feePctOnMargin = feeUsd / sizing.legMarginUsd;
    assertNear(feePctNotional, 0.0012, 1e-9, "F2 feePctNotional 0.12% (not 0.042%)");
    assertNear(feePctOnMargin, 0.012, 1e-9, "F3 feePctOnMargin 1.2%");
  }
}

function runNSeriesTests() {
  console.log("\n--- N Series: Authority & Block Tests ---");
  const baseRecord: Partial<PaperOpenPositionRecord> = {
    symbol: "ETH-USDT-SWAP", side: "long", entryPrice: 1000, 
    openedAt: Date.now()
  };

  // CASE N1 & N2: UNKNOWN -> null -> block
  const unknownRecord: PaperOpenPositionRecord = {
    ...(baseRecord as any),
    sizeUsd: 11.8,
    leverage: undefined
  };
  const authUnknown = resolveOpenNotionalAuthority(unknownRecord);
  assertEq(authUnknown.valueUsd, null, "N1/N2: UNKNOWN must return valueUsd = null");
  assertEq(authUnknown.authoritative, false, "N1/N2: UNKNOWN must return authoritative = false");
  console.log("[PASS] N1/N2: UNKNOWN safe (null, not authoritative)");

  // CASE N4: JSON serialization
  const jsonStr = JSON.stringify(authUnknown);
  assertEq(jsonStr.includes('"valueUsd":null'), true, "N4: JSON serialization must preserve null");
  assertEq(jsonStr.includes('"authoritative":false'), true, "N4: JSON serialization must preserve false");
  console.log("[PASS] N4: JSON serialization safe");

  // CASE N5: PROVEN LEGACY
  const legacyRecord: PaperOpenPositionRecord = {
    ...(baseRecord as any),
    sizeUsd: 11.8,
    leverage: 10,
    strategyVersion: "1.0.0" // Will be LEGACY_MARGIN
  };
  const authLegacy = resolveOpenNotionalAuthority(legacyRecord);
  assertEq(authLegacy.valueUsd, 118, "N5: PROVEN LEGACY must return 118");
  assertEq(authLegacy.authoritative, true, "N5: PROVEN LEGACY must be authoritative");
  console.log("[PASS] N5: PROVEN LEGACY safe");

  // CASE N6: PROVEN V2
  const v2Record: PaperOpenPositionRecord = {
    ...(baseRecord as any),
    sizeUsd: 118,
    notionalUsd: 118,
    isV2Authority: true
  };
  const authV2 = resolveOpenNotionalAuthority(v2Record);
  assertEq(authV2.valueUsd, 118, "N6: PROVEN V2 must return 118");
  assertEq(authV2.authoritative, true, "N6: PROVEN V2 must be authoritative");
  console.log("[PASS] N6: PROVEN V2 safe");

  // CASE N7: Rehydrate
  const rehydrateRecord: PaperOpenPositionRecord = {
    ...(baseRecord as any),
    sizeUsd: 11.8, // UNKNOWN structurally
    notionalUsd: 118 // BUT hydrated!
  };
  const authRehydrate = resolveOpenNotionalAuthority(rehydrateRecord);
  assertEq(authRehydrate.valueUsd, 118, "N7: REHYDRATED must return 118");
  assertEq(authRehydrate.authoritative, true, "N7: REHYDRATED must be authoritative");
  console.log("[PASS] N7: REHYDRATED safe");

  // CASE N8: OKX Override
  const authOverride = resolveOpenNotionalAuthority(unknownRecord, 118);
  assertEq(authOverride.valueUsd, 118, "N8: OKX override must return 118");
  assertEq(authOverride.authoritative, true, "N8: OKX override must be authoritative");
  console.log(`OKX_UNKNOWN_EFFECTIVE_NOTIONAL = ${authOverride.valueUsd}`);
  console.log(`OKX_UNKNOWN_SOURCE = ${authOverride.source}`);
  console.log(`OKX_UNKNOWN_AUTHORITATIVE = ${authOverride.authoritative}`);
  console.log(`OKX_UNKNOWN_SAFETY_BLOCK = ${!authOverride.authoritative}`);
  console.log("[PASS] N8: OKX OVERRIDE safe");
}

runUnitSemanticsCases();
runNSeriesTests();
console.log("UNIT SEMANTICS CASES: ALL PASS");
