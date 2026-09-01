/**
 * Cycle 164 regression — legacy evaluateRiskExposure leg cap must not shrink V2 authoritative sizing.
 */

import assert from "node:assert/strict";
import {
  applyLegacyV1RiskExposureCapClamp,
  resolveV2AuthoritativeFastPathEntryNotionalUsdt
} from "./v2-legacy-riske-cap-authority";

const CYCLE164_AUTHORITY_NOTIONAL = 1880.7290901619533;
const CYCLE164_LEGACY_MAX_LONG = 356.16;
const CYCLE164_SHRUNK_NOTIONAL = 356.16;
const CYCLE164_SYMBOL_CAP = 2350.9113627024417;
const CYCLE164_ACCOUNT_CAP = 2821.09363524293;

function approx(a: number, b: number, tol = 0.01): boolean {
  return Math.abs(a - b) < tol;
}

function pass(label: string, detail?: Record<string, unknown>): void {
  const extra = detail ? ` — ${JSON.stringify(detail)}` : "";
  console.log(`[V2-LEGACY-RISKE-CAP][${label}] PASS${extra}`);
}

// V2 authoritative fast-path — production cycle 164 shape
{
  const v2NotionalBefore = CYCLE164_AUTHORITY_NOTIONAL;
  const v2NotionalAfter = resolveV2AuthoritativeFastPathEntryNotionalUsdt(v2NotionalBefore);
  const v2LegacyRiskeClampApplied = v2NotionalAfter !== v2NotionalBefore;

  assert.equal(v2LegacyRiskeClampApplied, false, "V2_LEGACY_RISKE_CLAMP_APPLIED must be false");
  assert.ok(approx(v2NotionalBefore, CYCLE164_AUTHORITY_NOTIONAL), "V2_NOTIONAL_BEFORE");
  assert.ok(approx(v2NotionalAfter, CYCLE164_AUTHORITY_NOTIONAL), "V2_NOTIONAL_AFTER must stay ~1880.729");
  assert.ok(!approx(v2NotionalAfter, CYCLE164_SHRUNK_NOTIONAL), "V2 must NOT shrink to 356.16");

  pass("V2_CYCLE164_NO_LEGACY_RISKE_CLAMP", {
    V2_LEGACY_RISKE_CLAMP_APPLIED: false,
    V2_NOTIONAL_BEFORE: v2NotionalBefore,
    V2_NOTIONAL_AFTER: v2NotionalAfter,
    V2_SYMBOL_CAP: CYCLE164_SYMBOL_CAP,
    V2_ACCOUNT_CAP: CYCLE164_ACCOUNT_CAP
  });
}

// Legacy/V1 control — riskE clamp preserved
{
  const legacyBefore = CYCLE164_AUTHORITY_NOTIONAL;
  const legacyResult = applyLegacyV1RiskExposureCapClamp({
    entrySizeUsd: legacyBefore,
    side: "long",
    maxLongExposure: CYCLE164_LEGACY_MAX_LONG,
    maxShortExposure: CYCLE164_LEGACY_MAX_LONG,
    longUsd: 0,
    shortUsd: 0
  });

  assert.equal(legacyResult.clampApplied, true, "LEGACY_CONTROL_RISKE_CLAMP_PRESERVED");
  assert.ok(approx(legacyBefore, CYCLE164_AUTHORITY_NOTIONAL), "LEGACY_CONTROL_BEFORE");
  assert.ok(approx(legacyResult.sizeUsd, CYCLE164_SHRUNK_NOTIONAL), "LEGACY_CONTROL_AFTER must be 356.16");

  pass("LEGACY_V1_RISKE_CLAMP_PRESERVED", {
    LEGACY_CONTROL_RISKE_CLAMP_PRESERVED: true,
    LEGACY_CONTROL_BEFORE: legacyBefore,
    LEGACY_CONTROL_AFTER: legacyResult.sizeUsd
  });
}

console.log("[V2-LEGACY-RISKE-CAP] ALL PASS");
