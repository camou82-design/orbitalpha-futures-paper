/**
 * Startup tick:1 manual position mutation barrier — live defect regression (0c21eb5).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createManualTakeoverRecord,
  syncManualTakeoverLifecycleEntries,
  isManualTakeoverActiveForSymbol,
  hydrateManualTakeoverOntoOpenPositions,
  resolvePositionMutationAuthority,
  buildStartupPositionAuthorityBarrierProof,
  evaluateManualTakeoverActionGuard,
  isAuthoritativeBotOwnedAlgoOrder,
  isAuthoritativeBotOwnedPendingOrder
} from "../engine-v2/position/manual-takeover-authority";
import { evaluateOpsWatchProtectiveScanVerdict } from "../engine-v2/execution/protective-order-state";
import type { PaperOpenPositionRecord } from "../models/types";

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`FAIL [${msg}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL [${msg}]: expected true`);
}

function assertFalse(cond: boolean, msg: string): void {
  if (cond) throw new Error(`FAIL [${msg}]: expected false`);
}

function makeBotOpen(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
  return {
    openedAt: 1_700_000_000_000,
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 70_000,
    leverage: 10,
    sizeUsd: 400,
    initialSizeUsd: 400,
    strategyVersion: "paper-v2",
    sourceSignal: "v2_engine",
    sourceRunPath: "live_run",
    lifecycleState: "CLOSE_ONLY_MANAGED",
    status: "open",
    pos: 0.01,
    okxContracts: 0.01,
    isV2Authority: true,
    ...overrides
  };
}

function simulateTick1ProtectiveGate(input: {
  open: PaperOpenPositionRecord;
  manualMap: Map<string, ReturnType<typeof createManualTakeoverRecord>>;
  runCycleId: number;
}): {
  submitCount: number;
  cancelCount: number;
  exitCount: number;
  calculationCount: number;
  proof: Record<string, unknown>;
} {
  const opens = [input.open];
  hydrateManualTakeoverOntoOpenPositions(input.manualMap, opens);
  const side = input.open.side as "long" | "short";
  const manualActive = isManualTakeoverActiveForSymbol(input.open.symbol, side, input.manualMap, opens);
  const authority = resolvePositionMutationAuthority({
    open: opens[0],
    manualTakeoverActiveExternal: manualActive
  });
  const proof = buildStartupPositionAuthorityBarrierProof({
    symbol: String(input.open.symbol),
    side,
    runCycleId: input.runCycleId,
    positionExists: true,
    manualTakeoverLoaded: true,
    ledgerLifecycleState: opens[0].lifecycleState,
    authority
  });
  let submitCount = 0;
  let cancelCount = 0;
  let exitCount = 0;
  let calculationCount = 0;
  if (authority.protectiveReconcileAllowed) submitCount += 1;
  if (authority.positionMutationAllowed) {
    cancelCount += 1;
    exitCount += 1;
    calculationCount += 1;
  }
  const guard = evaluateManualTakeoverActionGuard({
    symbol: String(input.open.symbol),
    side,
    action: "PROTECTIVE_SUBMIT",
    manualTakeoverActive: authority.manualTakeoverActive
  });
  if (guard.allowed) submitCount += 1;
  return { submitCount, cancelCount, exitCount, calculationCount, proof };
}

async function runStartupBarrierCases(): Promise<void> {
  console.log("=== STARTUP POSITION AUTHORITY BARRIER CASES ===");

  // A — persisted manual takeover + BTC short + PM2 restart tick:1
  {
    const map = new Map<string, ReturnType<typeof createManualTakeoverRecord>>();
    const rec = createManualTakeoverRecord({
      symbol: "BTCUSDT",
      side: "short",
      reason: "OPERATOR_MANUAL_INTERVENTION"
    });
    map.set("BTCUSDT:short", rec);
    map.set("BTCUSDT", rec);
    const open = makeBotOpen({
      symbol: "BTCUSDT",
      side: "short",
      lifecycleState: "CLOSE_ONLY_MANAGED",
      manualTakeoverActive: false
    });
    const r = simulateTick1ProtectiveGate({ open, manualMap: map, runCycleId: 1 });
    assertEq(r.submitCount, 0, "CASE A submit");
    assertEq(r.cancelCount, 0, "CASE A cancel");
    assertEq(r.exitCount, 0, "CASE A exit");
    assertEq(r.calculationCount, 0, "CASE A calculation");
    assertEq(r.proof.effective_authority_owner, "OPERATOR", "CASE A owner");
    assertFalse(r.proof.position_mutation_allowed as boolean, "CASE A mutation blocked");
    assertTrue(r.proof.startup_authority_resolved_before_position_mutation as boolean, "CASE A barrier proof");
    console.log("[CASE A] PASS: BTC short manual takeover tick:1 zero mutation");
  }

  // B — ETH long no SL/TP => no protective recreation, no hard block
  {
    const map = new Map<string, ReturnType<typeof createManualTakeoverRecord>>();
    const rec = createManualTakeoverRecord({
      symbol: "ETHUSDT",
      side: "long",
      reason: "EXTERNAL_POSITION_MUTATION"
    });
    map.set("ETHUSDT:long", rec);
    map.set("ETHUSDT", rec);
    const open = makeBotOpen({
      symbol: "ETHUSDT",
      side: "long",
      lifecycleState: "CLOSE_ONLY_MANAGED",
      stopPrice: undefined,
      targetPrice1: undefined
    });
    hydrateManualTakeoverOntoOpenPositions(map, [open]);
    const verdict = evaluateOpsWatchProtectiveScanVerdict({
      nowMs: Date.now(),
      ledger: open,
      reduceOnlyProtectiveFound: false,
      matchingProtectivePendingCount: 0,
      scanClean: true,
      tpRequired: true
    });
    assertEq(verdict.verdict, "PASS", "CASE B ops-watch verdict");
    assertEq(verdict.reason, "manual_takeover_operator_managed", "CASE B ops-watch reason");
    assertFalse(verdict.shouldEmitHardBlockDetected, "CASE B no hard block");
    console.log("[CASE B] PASS: ETH long operator-managed without SL/TP => no hard block");
  }

  // C — ledger CLOSE_ONLY + stale/missing JSON => hydrate from map before mutation
  {
    const map = new Map<string, ReturnType<typeof createManualTakeoverRecord>>();
    const rec = createManualTakeoverRecord({
      symbol: "ETHUSDT",
      side: "long",
      reason: "MANUAL_INTERVENTION_DETECTED"
    });
    map.set("ETHUSDT:long", rec);
    const open = makeBotOpen({
      symbol: "ETHUSDT",
      side: "long",
      lifecycleState: "CLOSE_ONLY_MANAGED",
      manualTakeoverActive: false
    });
    const r = simulateTick1ProtectiveGate({ open, manualMap: map, runCycleId: 1 });
    assertEq(open.lifecycleState, "OPERATOR_MANAGED", "CASE C hydrated lifecycle");
    assertTrue(open.manualTakeoverActive === true, "CASE C hydrated flag");
    assertEq(r.submitCount, 0, "CASE C zero submit");
    console.log("[CASE C] PASS: stale ledger hydrated from takeover map before mutation");
  }

  // D — genuine BOT_V2_MANAGED after restart => protective still allowed
  {
    const open = makeBotOpen({ lifecycleState: "BOT_V2_MANAGED", manualTakeoverActive: false });
    const authority = resolvePositionMutationAuthority({ open, manualTakeoverActiveExternal: false });
    assertEq(authority.effectiveAuthorityOwner, "BOT", "CASE D bot owner");
    assertTrue(authority.protectiveReconcileAllowed, "CASE D protective allowed");
    assertTrue(authority.positionMutationAllowed, "CASE D mutation allowed");
    console.log("[CASE D] PASS: BOT_V2_MANAGED protective reconciliation preserved");
  }

  // E — flat + stale engine algo => quarantine preserved
  {
    const map = new Map<string, ReturnType<typeof createManualTakeoverRecord>>();
    const rec = createManualTakeoverRecord({ symbol: "BTCUSDT", side: "long", reason: "MANUAL_FULL_CLOSE" });
    map.set("BTCUSDT:long", rec);
    map.set("BTCUSDT", rec);
    syncManualTakeoverLifecycleEntries(map, [], { "BTCUSDT:long": 1, BTCUSDT: 1 });
    assertTrue(
      isManualTakeoverActiveForSymbol("BTCUSDT", "long", map, [], { engineOwnedOrderCount: 1 }),
      "CASE E quarantine while stale algo"
    );
    syncManualTakeoverLifecycleEntries(map, [], { "BTCUSDT:long": 0, BTCUSDT: 0 });
    assertFalse(
      isManualTakeoverActiveForSymbol("BTCUSDT", "long", map, [], { engineOwnedOrderCount: 0 }),
      "CASE E cleared after engine orders zero"
    );
    console.log("[CASE E] PASS: flat stale algo quarantine + clear preserved");
  }

  // F — operator manual orders untouched
  {
    const botOpen = makeBotOpen({ protectiveSlAlgoId: "bot-algo-1" });
    const operatorOrd = { ordId: "op-1", clOrdId: "manualOperatorSl", reduceOnly: "true" };
    assertTrue(isAuthoritativeBotOwnedAlgoOrder({ algoId: "bot-algo-1" }, [botOpen]), "CASE F bot algo");
    assertFalse(isAuthoritativeBotOwnedPendingOrder(operatorOrd, [botOpen]), "CASE F operator untouched");
    console.log("[CASE F] PASS: operator manual orders not authoritative bot-owned");
  }

  // G — consecutive restarts => zero operator mutation every restart
  {
    const map = new Map<string, ReturnType<typeof createManualTakeoverRecord>>();
    const rec = createManualTakeoverRecord({
      symbol: "ETHUSDT",
      side: "long",
      reason: "OPERATOR_MANUAL_INTERVENTION"
    });
    map.set("ETHUSDT:long", rec);
    map.set("ETHUSDT", rec);
    for (let restart = 1; restart <= 3; restart += 1) {
      const open = makeBotOpen({
        symbol: "ETHUSDT",
        side: "long",
        lifecycleState: "CLOSE_ONLY_MANAGED",
        manualTakeoverActive: false
      });
      const r = simulateTick1ProtectiveGate({ open, manualMap: map, runCycleId: 1 });
      assertEq(r.submitCount, 0, `CASE G restart ${restart} submit`);
      assertEq(r.calculationCount, 0, `CASE G restart ${restart} calculation`);
    }
    console.log("[CASE G] PASS: 3 consecutive restarts zero operator mutation");
  }

  // Ordering — barrier before reconcile_tick_hydrate in paper-engine
  {
    const src = readFileSync(join(__dirname, "./paper-engine.ts"), "utf8");
    const barrierIdx = src.indexOf("ensureStartupPositionAuthorityBarrier");
    const reconcileIdx = src.indexOf("await this.runPositionStateReconciliation");
    const hydrateIdx = src.indexOf('scope: "reconcile_tick_hydrate"');
    assertTrue(barrierIdx > 0 && reconcileIdx > barrierIdx, "barrier before runPositionStateReconciliation");
    assertTrue(hydrateIdx > barrierIdx, "barrier before reconcile_tick_hydrate path");
    console.log("[ORDERING] PASS: startup barrier precedes reconcile mutation paths");
  }

  console.log("=== ALL STARTUP POSITION AUTHORITY BARRIER CASES PASSED ===");
}

runStartupBarrierCases().catch((e) => {
  console.error(e);
  process.exit(1);
});
