import {
  acquireProtectiveSubmitInflightLock,
  planProtectiveOrderReconcile,
  resetProtectiveSubmitInflightLocksForTests,
  type ProtectiveReconcileContext
} from "../engine-v2/execution/protective-reconcile-plan";

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

function baseCtx(input: Readonly<{
  instId: string;
  positionSide: "long" | "short";
  contracts: number;
  slPx: number;
  tpPx: number;
}>): ProtectiveReconcileContext {
  return {
    instId: input.instId,
    positionSide: input.positionSide,
    openedAt36: "abc123",
    tdModeUsed: "cross",
    contractsToProtect: input.contracts,
    activeStopPrice: input.slPx,
    activeTpPrice: input.tpPx,
    wantsTp: true,
    expectedSide: input.positionSide === "long" ? "sell" : "buy",
    tickSz: input.instId.startsWith("BTC") ? 0.1 : 0.01
  };
}

function slAlgo(
  instId: string,
  side: "long" | "short",
  contracts: number,
  slPx: number,
  algoId: string,
  algoClOrdId = `sl_entry_${algoId}`
): Record<string, unknown> {
  return {
    instId,
    posSide: side,
    side: side === "long" ? "sell" : "buy",
    reduceOnly: true,
    tdMode: "cross",
    ordType: "conditional",
    sz: contracts,
    slTriggerPx: String(slPx),
    algoId,
    algoClOrdId
  };
}

function tpAlgo(
  instId: string,
  side: "long" | "short",
  contracts: number,
  tpPx: number,
  algoId: string,
  algoClOrdId = `tp_entry_${algoId}`
): Record<string, unknown> {
  return {
    instId,
    posSide: side,
    side: side === "long" ? "sell" : "buy",
    reduceOnly: true,
    tdMode: "cross",
    ordType: "conditional",
    sz: contracts,
    tpTriggerPx: String(tpPx),
    algoId,
    algoClOrdId
  };
}

function ocoAlgo(
  instId: string,
  side: "long" | "short",
  contracts: number,
  slPx: number,
  tpPx: number,
  algoId: string,
  algoClOrdId = `sl_entry_${algoId}`
): Record<string, unknown> {
  return {
    instId,
    posSide: side,
    side: side === "long" ? "sell" : "buy",
    reduceOnly: true,
    tdMode: "cross",
    ordType: "oco",
    sz: contracts,
    slTriggerPx: String(slPx),
    tpTriggerPx: String(tpPx),
    algoId,
    algoClOrdId
  };
}

async function runCases(): Promise<void> {
  // CASE 1 — BTC short: existing TP + SL missing → SL only
  {
    const instId = "BTC-USDT-SWAP";
    const ctx = baseCtx({ instId, positionSide: "short", contracts: 0.5, slPx: 95000, tpPx: 88000 });
    const plan = planProtectiveOrderReconcile(
      [tpAlgo(instId, "short", 0.5, 88000, "btc_tp_only")],
      ctx
    );
    assertFalse(plan.needSubmitTp, "CASE1 needSubmitTp");
    assertTrue(plan.needSubmitSl, "CASE1 needSubmitSl");
    assertFalse(plan.submitOco, "CASE1 submitOco");
    assertEq(plan.cancelAlgoIds.length, 0, "CASE1 cancel count");
  }

  // CASE 2 — ETH short: existing SL + TP missing → TP only
  {
    const instId = "ETH-USDT-SWAP";
    const ctx = baseCtx({ instId, positionSide: "short", contracts: 2.1, slPx: 3400, tpPx: 3100 });
    const plan = planProtectiveOrderReconcile(
      [slAlgo(instId, "short", 2.1, 3400, "eth_sl_only")],
      ctx
    );
    assertFalse(plan.needSubmitSl, "CASE2 needSubmitSl");
    assertTrue(plan.needSubmitTp, "CASE2 needSubmitTp");
    assertFalse(plan.submitOco, "CASE2 submitOco");
  }

  // CASE 3 — BTC + ETH: valid SL+TP → submit 0
  const case3Rows: Array<{
    label: string;
    instId: string;
    side: "long" | "short";
    contracts: number;
    slPx: number;
    tpPx: number;
  }> = [
    { label: "BTC", instId: "BTC-USDT-SWAP", side: "short", contracts: 0.3, slPx: 96000, tpPx: 89000 },
    { label: "ETH", instId: "ETH-USDT-SWAP", side: "long", contracts: 1.5, slPx: 3000, tpPx: 3400 }
  ];
  for (const row of case3Rows) {
    const ctx = baseCtx({
      instId: row.instId,
      positionSide: row.side,
      contracts: row.contracts,
      slPx: row.slPx,
      tpPx: row.tpPx
    });
    const plan = planProtectiveOrderReconcile(
      [
        slAlgo(row.instId, row.side, row.contracts, row.slPx, `${row.label}_sl`),
        tpAlgo(row.instId, row.side, row.contracts, row.tpPx, `${row.label}_tp`)
      ],
      ctx
    );
    assertFalse(plan.needSubmitSl, `${row.label} CASE3 needSubmitSl`);
    assertFalse(plan.needSubmitTp, `${row.label} CASE3 needSubmitTp`);
    assertFalse(plan.submitOco, `${row.label} CASE3 submitOco`);
    assertEq(plan.cancelAlgoIds.length, 0, `${row.label} CASE3 cancel count`);
  }

  // CASE 4 — OCO valid set → no individual adds; duplicate individuals cancelled
  {
    const instId = "ETH-USDT-SWAP";
    const ctx = baseCtx({ instId, positionSide: "short", contracts: 3, slPx: 3500, tpPx: 3200 });
    const plan = planProtectiveOrderReconcile(
      [
        ocoAlgo(instId, "short", 3, 3500, 3200, "eth_oco_canon"),
        slAlgo(instId, "short", 3, 3500, "eth_dup_sl"),
        tpAlgo(instId, "short", 3, 3200, "eth_dup_tp")
      ],
      ctx
    );
    assertFalse(plan.needSubmitSl, "CASE4 needSubmitSl");
    assertFalse(plan.needSubmitTp, "CASE4 needSubmitTp");
    assertFalse(plan.submitOco, "CASE4 submitOco");
    assertEq(plan.cancelAlgoIds.length, 2, "CASE4 duplicate cancel count");
    assertTrue(plan.cancelAlgoIds.includes("eth_dup_sl"), "CASE4 cancel dup SL");
    assertTrue(plan.cancelAlgoIds.includes("eth_dup_tp"), "CASE4 cancel dup TP");
  }

  // CASE 5 — stale size + current actual → stale cancelled, one new set needed
  {
    const instId = "BTC-USDT-SWAP";
    const ctx = baseCtx({ instId, positionSide: "short", contracts: 0.8, slPx: 97000, tpPx: 90000 });
    const plan = planProtectiveOrderReconcile(
      [ocoAlgo(instId, "short", 0.5, 97000, 90000, "btc_stale_oco")],
      ctx
    );
    assertEq(plan.staleCount, 1, "CASE5 staleCount");
    assertTrue(plan.cancelAlgoIds.includes("btc_stale_oco"), "CASE5 cancel stale");
    assertTrue(plan.submitOco, "CASE5 submitOco after stale");
  }

  // CASE 6 — single-flight lock: concurrent callers → one acquires, one joins
  {
    resetProtectiveSubmitInflightLocksForTests();
    let runs = 0;
    const slow = (): Promise<number> =>
      new Promise((resolve) => {
        runs += 1;
        setTimeout(() => resolve(runs), 30);
      });
    const key = "ETHUSDT:short";
    const a = acquireProtectiveSubmitInflightLock(key, slow);
    const b = acquireProtectiveSubmitInflightLock(key, slow);
    assertTrue(a.lock.acquired, "CASE6 first acquired");
    assertFalse(b.lock.acquired, "CASE6 second joined");
    assertTrue(b.lock.joinedExisting, "CASE6 joinedExisting");
    const [ra, rb] = await Promise.all([a.promise, b.promise]);
    assertEq(ra, 1, "CASE6 first result");
    assertEq(rb, 1, "CASE6 joined same result");
    assertEq(runs, 1, "CASE6 single run");
    resetProtectiveSubmitInflightLocksForTests();
  }

  // CASE 7 — reduce: actual contracts changed → stale old size cancelled, new OCO submit
  {
    const instId = "ETH-USDT-SWAP";
    const ctx = baseCtx({ instId, positionSide: "long", contracts: 1.0, slPx: 2900, tpPx: 3300 });
    const plan = planProtectiveOrderReconcile(
      [
        ocoAlgo(instId, "long", 2.0, 2900, 3300, "eth_pre_reduce_oco"),
        slAlgo(instId, "long", 2.0, 2900, "eth_pre_reduce_sl")
      ],
      ctx
    );
    assertEq(plan.staleCount, 2, "CASE7 stale both old-size");
    assertTrue(plan.submitOco, "CASE7 submit new OCO at reduced size");
    assertEq(plan.cancelAlgoIds.length, 2, "CASE7 cancel old protectives");
  }

  // CASE 8 — long/short symmetry: attach entry OCO adopted for both sides
  for (const side of ["long", "short"] as const) {
    const instId = side === "long" ? "BTC-USDT-SWAP" : "ETH-USDT-SWAP";
    const slPx = side === "long" ? 60000 : 3600;
    const tpPx = side === "long" ? 68000 : 3200;
    const ctx = baseCtx({ instId, positionSide: side, contracts: 1, slPx, tpPx });
    const plan = planProtectiveOrderReconcile(
      [ocoAlgo(instId, side, 1, slPx, tpPx, `${side}_attach_oco`, `sl_v2entry_${side}`)],
      ctx
    );
    assertFalse(plan.needSubmitSl, `${side} CASE8 needSubmitSl`);
    assertFalse(plan.needSubmitTp, `${side} CASE8 needSubmitTp`);
    assertFalse(plan.submitOco, `${side} CASE8 submitOco`);
    assertTrue(plan.canonicalSl != null, `${side} CASE8 canonicalSl`);
    assertTrue(plan.canonicalTp != null, `${side} CASE8 canonicalTp`);
  }

  // CASE 9 — both legs missing → single OCO submit (not two conditionals)
  {
    const instId = "BTC-USDT-SWAP";
    const ctx = baseCtx({ instId, positionSide: "short", contracts: 0.2, slPx: 98000, tpPx: 91000 });
    const plan = planProtectiveOrderReconcile([], ctx);
    assertTrue(plan.submitOco, "CASE9 submitOco");
    assertFalse(plan.needSubmitSl, "CASE9 needSubmitSl suppressed by OCO");
    assertFalse(plan.needSubmitTp, "CASE9 needSubmitTp suppressed by OCO");
  }

  console.info(JSON.stringify({
    event: "PROTECTIVE_RECONCILE_COLLISION_CASES_PASS",
    cases: ["1", "2", "3", "4", "5", "6", "7", "8", "9"]
  }));
}

runCases().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
