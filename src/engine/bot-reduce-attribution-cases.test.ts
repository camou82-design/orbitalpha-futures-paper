import type { PaperOpenPositionRecord } from "../models/types";
import { attributePositionSizeMutation } from "../engine-v2/position/bot-size-mutation-attribution";
import { evaluateManualOwnershipLatchTrigger } from "../engine-v2/position/manual-ownership-latch";

function assertTrue(v: boolean, label: string): void {
  if (!v) throw new Error(`${label}: expected true`);
}

function assertFalse(v: boolean, label: string): void {
  if (v) throw new Error(`${label}: expected false`);
}

function assertEq<T>(a: T, b: T, label: string): void {
  if (a !== b) throw new Error(`${label}: expected ${String(b)}, got ${String(a)}`);
}

function botLedger(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
  return {
    symbol: "BTCUSDT",
    side: "long",
    openedAt: 1,
    entryPrice: 64231.9,
    sizeUsd: 13.475,
    okxContracts: 0.21,
    isV2Authority: true,
    authoritySourceAtEntry: "v2",
    exchangeClOrdId: "pbtc001",
    lastBotExecutionAt: Date.now() - 5_000,
    lastBotExecutionReason: "executor_stop_loss",
    ...overrides
  } as PaperOpenPositionRecord;
}

// CASE E — bot reduce 0.02: 0.21 → 0.19
{
  const attr = attributePositionSizeMutation({
    beforeContracts: 0.21,
    afterContracts: 0.19,
    botOrderEvidenceFound: true,
    matchingBotReduceContracts: 0.02,
    ledger: botLedger(),
    manualEvidenceIndependent: false
  });
  assertEq(attr.attribution, "BOT", "CASE E attribution");
  const latch = evaluateManualOwnershipLatchTrigger({
    ledger: botLedger(),
    syncStatus: "ALIGNED",
    okxActualContracts: 0.19,
    okxActualPositionExists: true,
    ledgerPaperContracts: 0.21,
    okxFetchReady: true
  });
  assertFalse(latch.shouldLatch, "CASE E no manual latch");
}

// CASE F — no bot evidence + independent manual evidence → manual
{
  const attr = attributePositionSizeMutation({
    beforeContracts: 0.21,
    afterContracts: 0.19,
    botOrderEvidenceFound: false,
    ledger: {
      symbol: "BTCUSDT",
      side: "long",
      manualLifecycleEvidenceIndependent: true
    } as PaperOpenPositionRecord,
    manualEvidenceIndependent: true
  });
  assertEq(attr.attribution, "MANUAL", "CASE F manual attribution");
}

console.log("bot-reduce-attribution-cases: ALL PASS");
