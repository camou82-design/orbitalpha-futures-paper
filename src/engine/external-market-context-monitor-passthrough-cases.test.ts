/**
 * External Market Context monitor passthrough — engine-state field presence.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonStore } from "../storage/json-store";
import { buildExternalMarketContextMonitorPayload } from "../engine-v2/external-market-context/evaluate";
import type { ExternalMarketContextResult, ExternalMarketSnapshot } from "../engine-v2/external-market-context/types";

function pass(label: string): void {
  console.log(`PASS: ${label}`);
}

function fullSnapshot(now: number): ExternalMarketSnapshot {
  return {
    generatedAt: now,
    maxAgeMs: 900_000,
    unavailableSources: [],
    sources: {
      nq: { value: 18000, signal: 0.52, fetchedAt: now, source: "test:nq" },
      es: { value: 5000, signal: 0.36, fetchedAt: now, source: "test:es" },
      dxy: { value: 104, signal: -0.28, fetchedAt: now, source: "test:dxy" },
      us10y: { value: 4.2, signal: 0.33, fetchedAt: now, source: "test:us10y" }
    },
    status: "ok"
  };
}

function previewFromSnapshot(snapshot: ExternalMarketSnapshot): ExternalMarketContextResult {
  return {
    externalContextScore: 0.34,
    sideAlignedScore: 0.34,
    signals: {
      nqSignal: 0.52,
      esSignal: 0.36,
      dxySignal: -0.28,
      us10ySignal: 0.33,
      newsSignal: 0,
      availableWeight: 0.85,
      unavailableSources: []
    },
    newsEventRisk: 0,
    externalSizeMultiplier: 1,
    confidenceScoreDelta: 0,
    externalContextAgeMs: 1000,
    externalContextApplied: false,
    externalContextReason: "SHADOW_MODE",
    failOpen: true,
    shadowPreview: true,
    longPreviewMultiplier: 1.05,
    shortPreviewMultiplier: 0.95,
    externalSignalReliability: 1,
    rawLongPreviewMultiplier: 1.05,
    rawShortPreviewMultiplier: 0.95,
    reliabilityAdjustedLongPreviewMultiplier: 1.05,
    reliabilityAdjustedShortPreviewMultiplier: 0.95
  };
}

async function main(): Promise<void> {
  const now = Date.now();
  const payload = buildExternalMarketContextMonitorPayload(
    {
      snapshot: fullSnapshot(now),
      lastFetchElapsedMs: 12,
      lastFetchErrors: {},
      fetchInFlight: false
    },
    previewFromSnapshot(fullSnapshot(now)),
    { enabled: false, shadowMode: true, fetchEnabled: true },
    now
  );

  assert.equal(payload.external_context_applied, false);
  assert.equal(payload.trading_impact, "none");
  assert.equal(typeof payload.external_context_score, "number");
  assert.ok(payload.source_display && typeof payload.source_display === "object");
  pass("monitor payload includes score + source_display + shadow flags");

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "emc-passthrough-"));
  const store = new JsonStore(tmp);
  await store.writeJson("reports/engine-state.json", {
    generatedAt: now,
    engine_status: "RUNNING",
    external_market_context: null
  });
  await store.patchEngineStateFields({
    external_market_context: payload,
    external_market_context_updated_at: now
  });
  const raw = await fs.readFile(path.join(tmp, "reports", "engine-state.json"), "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const emc = parsed.external_market_context as Record<string, unknown>;
  assert.ok(emc && typeof emc === "object");
  assert.equal(emc.external_context_score, 0.34);
  assert.equal(emc.external_signal_reliability, 1);
  assert.equal(emc.available_signal_weight, 0.85);
  assert.ok(emc.source_display);
  pass("patchEngineStateFields replaces null external_market_context");

  console.log("external-market-context-monitor-passthrough-cases: ALL PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
