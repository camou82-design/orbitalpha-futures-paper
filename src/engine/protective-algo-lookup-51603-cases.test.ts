import {
  planProtectiveOrderReconcile,
  acquireProtectiveSubmitInflightLock,
  resetProtectiveSubmitInflightLocksForTests,
  type ProtectiveReconcileContext
} from "../engine-v2/execution/protective-reconcile-plan";
import {
  buildProtectiveClOrdIdCandidates,
  classifyProtectiveAlgoOrderLookupTry,
  clearProtectiveClOrdIdBlocksForSymbolSide,
  isOkxAlgoOrderDoesNotExistError,
  isProtectiveClOrdIdSubmitBlocked,
  markProtectiveClOrdIdSubmitBlocked,
  mergeProtectiveInventoryAfterClOrdIdLookups,
  mergeProtectiveInventoryRows,
  resetProtectiveClOrdIdBlocksForTests,
  resolve51068ProtectiveLookup
} from "../engine-v2/execution/protective-inventory";

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

function ctx(input: Readonly<{
  instId: string;
  side: "long" | "short";
  openedAt36: string;
  contracts: number;
  slPx: number;
  tpPx: number;
}>): ProtectiveReconcileContext {
  return {
    instId: input.instId,
    positionSide: input.side,
    openedAt36: input.openedAt36,
    tdModeUsed: "cross",
    contractsToProtect: input.contracts,
    activeStopPrice: input.slPx,
    activeTpPrice: input.tpPx,
    wantsTp: true,
    expectedSide: input.side === "long" ? "sell" : "buy",
    tickSz: input.instId.startsWith("BTC") ? 0.1 : 0.01
  };
}

function absent51603(clOrdId: string) {
  return {
    ok: false as const,
    error: "okx_api_51603:Order does not exist",
    diagnostics: { retCode: "51603", retMsg: "Order does not exist", requestUrl: `/order-algo?algoClOrdId=${clOrdId}` }
  };
}

function networkError(clOrdId: string) {
  return {
    ok: false as const,
    error: "signed_request_network_error: timeout",
    diagnostics: { retCode: undefined, retMsg: "timeout" }
  };
}

function authError(clOrdId: string) {
  return {
    ok: false as const,
    error: "okx_api_50113:Invalid API key",
    diagnostics: { retCode: "50113", retMsg: "Invalid API key" }
  };
}

function simulateProtectiveSubmitOnce(plan: ReturnType<typeof planProtectiveOrderReconcile>): number {
  let submits = 0;
  if (plan.submitOco) submits += 1;
  else {
    if (plan.needSubmitSl) submits += 1;
    if (plan.needSubmitTp) submits += 1;
  }
  return submits;
}

async function runCases(): Promise<void> {
  resetProtectiveClOrdIdBlocksForTests();
  resetProtectiveSubmitInflightLocksForTests();

  // CASE A — pending empty, 51603 lookup → inventory success, both missing, OCO submit 1
  {
    const openedAt36 = "msplnw3gs";
    const instId = "BTC-USDT-SWAP";
    const slCl = `oapBTCUs${openedAt36}s`;
    const tpCl = `oapBTCUs${openedAt36}t`;
    const reconcileCtx = ctx({ instId, side: "short", openedAt36, contracts: 0.4, slPx: 97000, tpPx: 90000 });
    const candidates = buildProtectiveClOrdIdCandidates({
      slAlgoClOrdId: slCl,
      tpAlgoClOrdId: tpCl,
      engineOwnedPrefix: `oapBTCUs${openedAt36}`
    });
    assertTrue(isOkxAlgoOrderDoesNotExistError({ retCode: "51603" }), "CASE A 51603 detect");
    assertEq(classifyProtectiveAlgoOrderLookupTry(absent51603(slCl)), "ABSENT", "CASE A classify");
    const merged = mergeProtectiveInventoryAfterClOrdIdLookups({
      pendingRows: [],
      attachRows: [],
      clOrdCandidates: candidates,
      lookupRowsByClOrdId: Object.fromEntries(candidates.map((c) => [c, "ABSENT" as const]))
    });
    assertTrue(merged.inventory != null, "CASE A inventory success");
    assertEq(merged.lookupAbsentCount, candidates.length, "CASE A absent count");
    const plan = planProtectiveOrderReconcile(merged.inventory!, reconcileCtx);
    assertTrue(plan.submitOco, "CASE A submitOco");
    assertEq(simulateProtectiveSubmitOnce(plan), 1, "CASE A submit count");
  }

  // CASE B — network error → abort, submit 0
  {
    const cl = "oapETHUlabc123s";
    assertEq(classifyProtectiveAlgoOrderLookupTry(networkError(cl)), "ERROR", "CASE B classify");
    const merged = mergeProtectiveInventoryAfterClOrdIdLookups({
      pendingRows: [],
      attachRows: [],
      clOrdCandidates: [cl],
      lookupRowsByClOrdId: { [cl]: "ERROR" }
    });
    assertEq(merged.inventory, null, "CASE B inventory aborted");
  }

  // CASE C — auth/rate-limit error → abort, submit 0
  {
    const cl = "oapETHUlabc123s";
    assertEq(classifyProtectiveAlgoOrderLookupTry(authError(cl)), "ERROR", "CASE C classify");
    const merged = mergeProtectiveInventoryAfterClOrdIdLookups({
      pendingRows: [],
      attachRows: [],
      clOrdCandidates: [cl],
      lookupRowsByClOrdId: { [cl]: "ERROR" }
    });
    assertEq(merged.inventory, null, "CASE C inventory aborted");
  }

  // CASE D — BTC short / ETH short symmetry with 51603 ABSENT
  for (const row of [
    { symbol: "BTCUSDT", instId: "BTC-USDT-SWAP", side: "short" as const, openedAt36: "btcsh001", contracts: 0.2, slPx: 98000, tpPx: 91000 },
    { symbol: "ETHUSDT", instId: "ETH-USDT-SWAP", side: "short" as const, openedAt36: "ethsh001", contracts: 1.5, slPx: 3200, tpPx: 2900 }
  ]) {
    const slCl = `oap${row.symbol.slice(0, 5)}s${row.openedAt36}s`;
    const tpCl = `oap${row.symbol.slice(0, 5)}s${row.openedAt36}t`;
    const candidates = buildProtectiveClOrdIdCandidates({
      slAlgoClOrdId: slCl,
      tpAlgoClOrdId: tpCl,
      engineOwnedPrefix: `oap${row.symbol.slice(0, 5)}s${row.openedAt36}`
    });
    const merged = mergeProtectiveInventoryAfterClOrdIdLookups({
      pendingRows: [],
      attachRows: [],
      clOrdCandidates: candidates,
      lookupRowsByClOrdId: Object.fromEntries(candidates.map((c) => [c, "ABSENT" as const]))
    });
    assertTrue(merged.inventory != null, `${row.symbol} CASE D inventory`);
    const plan = planProtectiveOrderReconcile(
      merged.inventory!,
      ctx({ instId: row.instId, side: row.side, openedAt36: row.openedAt36, contracts: row.contracts, slPx: row.slPx, tpPx: row.tpPx })
    );
    assertTrue(plan.submitOco, `${row.symbol} CASE D submitOco`);
  }

  // CASE E — existing valid OCO FOUND → adopt, submit 0
  {
    const clOrdId = "oapBTCUsmsplnw3gs";
    const row = {
      instId: "BTC-USDT-SWAP",
      posSide: "short",
      side: "buy",
      reduceOnly: true,
      tdMode: "cross",
      ordType: "oco",
      sz: 0.4,
      slTriggerPx: "97000",
      tpTriggerPx: "90000",
      algoId: "btc_live_oco",
      algoClOrdId: clOrdId,
      state: "live"
    };
    const reconcileCtx = ctx({ instId: "BTC-USDT-SWAP", side: "short", openedAt36: "msplnw3gs", contracts: 0.4, slPx: 97000, tpPx: 90000 });
    const resolution = resolve51068ProtectiveLookup(row, reconcileCtx, clOrdId);
    assertEq(resolution.action, "adopt", "CASE E adopt");
    const plan = planProtectiveOrderReconcile([row], reconcileCtx);
    assertFalse(plan.submitOco, "CASE E submitOco");
    assertEq(simulateProtectiveSubmitOnce(plan), 0, "CASE E submit count");
  }

  // CASE F — 51068 + matching FOUND → ADOPT
  {
    const clOrdId = "oapETHUlmsplnw3gs";
    const reconcileCtx = ctx({ instId: "ETH-USDT-SWAP", side: "long", openedAt36: "msplnw3gs", contracts: 1.2, slPx: 3050, tpPx: 3350 });
    const liveRow = {
      instId: "ETH-USDT-SWAP",
      posSide: "long",
      side: "sell",
      reduceOnly: true,
      tdMode: "cross",
      ordType: "oco",
      sz: 1.2,
      slTriggerPx: "3050",
      tpTriggerPx: "3350",
      algoId: "eth_live_oco",
      algoClOrdId: clOrdId,
      state: "live"
    };
    assertEq(classifyProtectiveAlgoOrderLookupTry({ ok: true, value: [liveRow] }), "FOUND", "CASE F found");
    const resolution = resolve51068ProtectiveLookup(liveRow, reconcileCtx, clOrdId);
    assertEq(resolution.action, "adopt", "CASE F adopt");
  }

  // CASE G — 51068 + genuine lookup ERROR → block retained
  {
    resetProtectiveClOrdIdBlocksForTests();
    const clOrdId = "oapBTCUsmsplnw3gs";
    markProtectiveClOrdIdSubmitBlocked("BTCUSDT", "short", clOrdId);
    assertEq(classifyProtectiveAlgoOrderLookupTry(authError(clOrdId)), "ERROR", "CASE G error");
    assertTrue(isProtectiveClOrdIdSubmitBlocked("BTCUSDT", "short", clOrdId), "CASE G blocked");
  }

  // CASE H — old cycle blocked clOrdId does not block new openedAt clOrdId
  {
    resetProtectiveClOrdIdBlocksForTests();
    markProtectiveClOrdIdSubmitBlocked("BTCUSDT", "short", "oapBTCUsoldcycle1s");
    assertTrue(isProtectiveClOrdIdSubmitBlocked("BTCUSDT", "short", "oapBTCUsoldcycle1s"), "CASE H old blocked");
    assertFalse(isProtectiveClOrdIdSubmitBlocked("BTCUSDT", "short", "oapBTCUsnewcycle2s"), "CASE H new not blocked");
    clearProtectiveClOrdIdBlocksForSymbolSide("BTCUSDT", "short");
    assertFalse(isProtectiveClOrdIdSubmitBlocked("BTCUSDT", "short", "oapBTCUsoldcycle1s"), "CASE H cleared on cycle end");
  }

  // CASE I — same invocation submit max 1 (single-flight lock)
  {
    resetProtectiveSubmitInflightLocksForTests();
    let submitCount = 0;
    const first = acquireProtectiveSubmitInflightLock("BTCUSDT:short", () => {
      submitCount += 1;
      return Promise.resolve("done");
    });
    assertFalse(first.lock.joinedExisting, "CASE I first lock owner");
    const second = acquireProtectiveSubmitInflightLock("BTCUSDT:short", () => {
      submitCount += 1;
      return Promise.resolve("joined");
    });
    assertTrue(second.lock.joinedExisting, "CASE I joined existing");
    await Promise.all([first.promise, second.promise]);
    assertEq(submitCount, 1, "CASE I single submit body");
  }

  console.info(JSON.stringify({
    event: "PROTECTIVE_ALGO_LOOKUP_51603_CASES_PASS",
    cases: ["A", "B", "C", "D", "E", "F", "G", "H", "I"]
  }));
}

runCases().catch((err) => {
  console.error(err);
  process.exit(1);
});
