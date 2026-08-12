import {
  planProtectiveOrderReconcile,
  type ProtectiveReconcileContext
} from "../engine-v2/execution/protective-reconcile-plan";
import {
  buildEntryAttachProtectiveCandidates,
  clearProtectiveClOrdIdBlocksForSymbolSide,
  inventoryRowsMatchingClOrdId,
  isOkxAlgoClOrdIdExistsError,
  isProtectiveClOrdIdSubmitBlocked,
  markProtectiveClOrdIdSubmitBlocked,
  mergeProtectiveInventoryRows,
  normalizeProtectiveOrderClOrdIds,
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
  contracts: number;
  slPx: number;
  tpPx: number;
}>): ProtectiveReconcileContext {
  return {
    instId: input.instId,
    positionSide: input.side,
    openedAt36: "msplnw3gs",
    tdModeUsed: "cross",
    contractsToProtect: input.contracts,
    activeStopPrice: input.slPx,
    activeTpPrice: input.tpPx,
    wantsTp: true,
    expectedSide: input.side === "long" ? "sell" : "buy",
    tickSz: input.instId.startsWith("BTC") ? 0.1 : 0.01
  };
}

function runCases(): void {
  resetProtectiveClOrdIdBlocksForTests();

  // CASE A — pending empty, entry attach OCO candidate → submit 0
  {
    const instId = "ETH-USDT-SWAP";
    const reconcileCtx = ctx({ instId, side: "long", contracts: 2.5, slPx: 3100, tpPx: 3400 });
    const attach = buildEntryAttachProtectiveCandidates({
      instId,
      positionSide: "long",
      tdModeUsed: "cross",
      expectedSide: "sell",
      contracts: 2.5,
      activeStopPrice: 3100,
      activeTpPrice: 3400,
      wantsTp: true,
      entryClOrdId: "pETHentry001"
    });
    const inventory = mergeProtectiveInventoryRows([], attach);
    const plan = planProtectiveOrderReconcile(inventory, reconcileCtx);
    assertFalse(plan.needSubmitSl, "CASE A needSubmitSl");
    assertFalse(plan.needSubmitTp, "CASE A needSubmitTp");
    assertFalse(plan.submitOco, "CASE A submitOco");
  }

  // CASE B — attachAlgoClOrdId normalized lookup → adopt
  {
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
      algoId: "btc_attach_live",
      attachAlgoClOrdId: "sl_pBTCentry99"
    };
    const ids = normalizeProtectiveOrderClOrdIds(row);
    assertTrue(ids.includes("sl_pBTCentry99"), "CASE B attach id normalized");
    const hits = inventoryRowsMatchingClOrdId([row], "sl_pBTCentry99");
    assertEq(hits.length, 1, "CASE B inventory match count");
    const reconcileCtx = ctx({ instId: "BTC-USDT-SWAP", side: "short", contracts: 0.4, slPx: 97000, tpPx: 90000 });
    const resolution = resolve51068ProtectiveLookup(row, reconcileCtx, "sl_pBTCentry99");
    assertEq(resolution.action, "adopt", "CASE B adopt action");
  }

  // CASE C — 51068 + authoritative lookup matching → adopt (retry block next cycle)
  {
    const instId = "ETH-USDT-SWAP";
    const clOrdId = "oapETHUSlmsplnw3gs";
    const reconcileCtx = ctx({ instId, side: "long", contracts: 1.2, slPx: 3050, tpPx: 3350 });
    const liveRow = {
      instId,
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
    assertTrue(
      isOkxAlgoClOrdIdExistsError({
        sCode: "51068",
        sMsg: "oapETHUSlmsplnw3gs already exists within algoClOrdId and attachAlgoClOrdId"
      }),
      "CASE C 51068 detect"
    );
    const resolution = resolve51068ProtectiveLookup(liveRow, reconcileCtx, clOrdId);
    assertEq(resolution.action, "adopt", "CASE C adopt");
    markProtectiveClOrdIdSubmitBlocked("ETHUSDT", "long", clOrdId);
    assertTrue(isProtectiveClOrdIdSubmitBlocked("ETHUSDT", "long", clOrdId), "CASE C blocked");
  }

  // CASE D — 51068 stale size → stale replacement once
  {
    const instId = "ETH-USDT-SWAP";
    const clOrdId = "oapETHUSlmsplnw3gs";
    const reconcileCtx = ctx({ instId, side: "long", contracts: 2.0, slPx: 3050, tpPx: 3350 });
    const staleRow = {
      instId,
      posSide: "long",
      side: "sell",
      reduceOnly: true,
      tdMode: "cross",
      ordType: "oco",
      sz: 1.0,
      slTriggerPx: "3050",
      tpTriggerPx: "3350",
      algoId: "eth_stale_oco",
      algoClOrdId: clOrdId,
      state: "live"
    };
    const resolution = resolve51068ProtectiveLookup(staleRow, reconcileCtx, clOrdId);
    assertEq(resolution.action, "stale_replace", "CASE D stale_replace");
    if (resolution.action === "stale_replace") {
      assertEq(resolution.cancelAlgoId, "eth_stale_oco", "CASE D cancel id");
    }
  }

  // CASE E — consecutive cycle same clOrdId blocked after 51068 miss
  {
    resetProtectiveClOrdIdBlocksForTests();
    const clOrdId = "oapBTCUSsmsplnw3gs";
    markProtectiveClOrdIdSubmitBlocked("BTCUSDT", "short", clOrdId);
    assertTrue(isProtectiveClOrdIdSubmitBlocked("BTCUSDT", "short", clOrdId), "CASE E cycle1 block");
    assertTrue(isProtectiveClOrdIdSubmitBlocked("BTCUSDT", "short", clOrdId), "CASE E cycle2 block");
  }

  // CASE F — BTC/ETH long/short attach inventory symmetry
  for (const row of [
    { symbol: "BTCUSDT", instId: "BTC-USDT-SWAP", side: "short" as const, contracts: 0.2, slPx: 98000, tpPx: 91000, entry: "pBTC001" },
    { symbol: "ETHUSDT", instId: "ETH-USDT-SWAP", side: "long" as const, contracts: 3, slPx: 3000, tpPx: 3300, entry: "pETH001" }
  ]) {
    const reconcileCtx = ctx({
      instId: row.instId,
      side: row.side,
      contracts: row.contracts,
      slPx: row.slPx,
      tpPx: row.tpPx
    });
    const attach = buildEntryAttachProtectiveCandidates({
      instId: row.instId,
      positionSide: row.side,
      tdModeUsed: "cross",
      expectedSide: row.side === "long" ? "sell" : "buy",
      contracts: row.contracts,
      activeStopPrice: row.slPx,
      activeTpPrice: row.tpPx,
      wantsTp: true,
      entryClOrdId: row.entry
    });
    const plan = planProtectiveOrderReconcile(mergeProtectiveInventoryRows([], attach), reconcileCtx);
    assertFalse(plan.submitOco, `${row.symbol} ${row.side} CASE F submitOco`);
    assertFalse(plan.needSubmitSl, `${row.symbol} ${row.side} CASE F needSubmitSl`);
    assertFalse(plan.needSubmitTp, `${row.symbol} ${row.side} CASE F needSubmitTp`);
  }

  // CASE G — pending OCO + attach + lookup same clOrdId → merge dedupe 1 row
  {
    const clOrdId = "sl_pETHentry001";
    const pending = [{
      instId: "ETH-USDT-SWAP",
      posSide: "long",
      side: "sell",
      reduceOnly: true,
      tdMode: "cross",
      ordType: "oco",
      sz: 2.5,
      slTriggerPx: "3100",
      tpTriggerPx: "3400",
      algoId: "eth_live_oco",
      algoClOrdId: clOrdId,
      state: "live"
    }];
    const attach = buildEntryAttachProtectiveCandidates({
      instId: "ETH-USDT-SWAP",
      positionSide: "long",
      tdModeUsed: "cross",
      expectedSide: "sell",
      contracts: 2.5,
      activeStopPrice: 3100,
      activeTpPrice: 3400,
      wantsTp: true,
      entryClOrdId: "pETHentry001"
    });
    const lookup = [{
      ...pending[0],
      _protectiveInventorySource: "authoritative_lookup"
    }];
    const merged = mergeProtectiveInventoryRows(pending, attach, lookup);
    assertEq(merged.length, 1, "CASE G merged count");
    assertEq(String(merged[0].algoId), "eth_live_oco", "CASE G canonical algoId");
    const reconcileCtx = ctx({ instId: "ETH-USDT-SWAP", side: "long", contracts: 2.5, slPx: 3100, tpPx: 3400 });
    const plan = planProtectiveOrderReconcile(merged, reconcileCtx);
    assertFalse(plan.submitOco, "CASE G submitOco");
    assertEq(plan.duplicateSlCount, 0, "CASE G duplicateSlCount");
  }

  // CASE H — symbol+side latch clears on position cycle end hook
  {
    resetProtectiveClOrdIdBlocksForTests();
    markProtectiveClOrdIdSubmitBlocked("ETHUSDT", "long", "oapETHUSlmsplnw3gs");
    markProtectiveClOrdIdSubmitBlocked("ETHUSDT", "short", "oapETHUSsmsplnw3gs");
    clearProtectiveClOrdIdBlocksForSymbolSide("ETHUSDT", "long");
    assertFalse(isProtectiveClOrdIdSubmitBlocked("ETHUSDT", "long", "oapETHUSlmsplnw3gs"), "CASE H long cleared");
    assertTrue(isProtectiveClOrdIdSubmitBlocked("ETHUSDT", "short", "oapETHUSsmsplnw3gs"), "CASE H short retained");
    clearProtectiveClOrdIdBlocksForSymbolSide("ETHUSDT", "short");
    assertFalse(isProtectiveClOrdIdSubmitBlocked("ETHUSDT", "short", "oapETHUSsmsplnw3gs"), "CASE H short cleared");
  }

  console.info(JSON.stringify({
    event: "PROTECTIVE_INVENTORY_51068_CASES_PASS",
    cases: ["A", "B", "C", "D", "E", "F", "G", "H"]
  }));
}

runCases();
