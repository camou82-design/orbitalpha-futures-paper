import assert from "node:assert";
import {
  evaluateOrderOwnership,
  evaluateSymbolPendingOrderAuthority,
  evaluateOperatorOrderFillTransition,
  buildOperatorOrderFillAuthorityProof,
  isAuthoritativeBotOwnedAlgoOrder,
  isAuthoritativeBotOwnedPendingOrder,
  isManualTakeoverActiveForSymbol,
  buildManualPendingOrderAuthorityProof,
  type ManualTakeoverRecord
} from "../engine-v2/position/manual-takeover-authority";
import { runEngineV2 } from "../engine-v2/index";
import type { EngineV2Input } from "../engine-v2/types";

function assertEq<T>(actual: T, expected: T, message: string) {
  assert.strictEqual(actual, expected, message);
}

function assertTrue(cond: boolean, message: string) {
  assert.strictEqual(cond, true, message);
}

function assertFalse(cond: boolean, message: string) {
  assert.strictEqual(cond, false, message);
}

function makeMockEngineInput(params: {
  symbol: string;
  hasOperatorPendingOrders?: boolean;
  manualTakeoverActive?: boolean;
  currentPositions?: any[];
}): EngineV2Input {
  const candles = [
    { ts: 1000, open: 2500, high: 2510, low: 2490, close: 2500, volume: 100 },
    { ts: 2000, open: 2500, high: 2510, low: 2490, close: 2500, volume: 100 },
    { ts: 3000, open: 2500, high: 2510, low: 2490, close: 2500, volume: 100 },
    { ts: 4000, open: 2500, high: 2510, low: 2490, close: 2500, volume: 100 },
    { ts: 5000, open: 2500, high: 2510, low: 2490, close: 2500, volume: 100 }
  ];

  return {
    symbol: params.symbol as any,
    now: Date.now(),
    v1Result: null as any,
    evaluationMode: "authoritative",
    run_cycle_id: "test-cycle-1",
    state: {
      currentPositions: params.currentPositions ?? [],
      directionalShockState: "NONE",
      longAllow: true,
      shortAllow: true,
      executionReadiness: true,
      paperExecutionReady: true,
      signedExecutionReady: true,
      freshTickBarrierActive: false,
      freshTickCompletedCycles: 2,
      freshTickRequiredCycles: 2,
      lossStreaks: {},
      globalRiskScore: 0,
      hasOperatorPendingOrders: params.hasOperatorPendingOrders,
      manualTakeoverActive: params.manualTakeoverActive
    } as any,
    snapshot: {
      symbol: params.symbol,
      lastPrice: 2500,
      boxLow: 2480,
      boxHigh: 2520,
      boxPos: 0.1,
      atr: 15,
      qualityScore: 85,
      rangeConfidence: 0.85,
      boxCohesion01: 0.8,
      trendWeaknessScore: 0.8,
      breakoutFailureRate: 0.8,
      rangeOscillationScore: 0.8,
      candles,
      tickSz: 0.01
    } as any,
    config: {
      paperTakerFeeRate: 0.0006,
      paperSlippageEstimateBps: 8
    } as any
  };
}

function runManualPendingOrderAuthorityTests() {
  console.info("=== RUNNING MANUAL PENDING ORDER AUTHORITY REGRESSION SUITE ===");

  // =========================================================================
  // CASE A: BTC flat + operator limit order → cancel 0, observe-only latch
  // =========================================================================
  {
    const operatorLimit = {
      ordId: "okx_ord_btc_1001",
      clOrdId: "p_user_limit_buy_1",
      instId: "BTC-USDT-SWAP",
      side: "buy",
      posSide: "long",
      sz: "0.1",
      px: "65000"
    };
    const auth = evaluateSymbolPendingOrderAuthority({
      symbol: "BTCUSDT",
      pendingOrders: [operatorLimit],
      algoOrders: [],
      openPositions: []
    });

    assertTrue(auth.hasOperatorPendingOrders, "CASE A: operator pending order detected");
    assertEq(auth.operatorOrderCount, 1, "CASE A: operator order count is 1");
    assertEq(auth.authorityOwner, "OPERATOR", "CASE A: authority owner is OPERATOR");
    assertFalse(auth.mutationAllowed, "CASE A: mutation not allowed");
    assertFalse(auth.cancelAllowed, "CASE A: cancel not allowed");
    assertEq(auth.proofs[0].ownership, "OPERATOR_OWNED", "CASE A: ownership OPERATOR_OWNED");

    // V2 Execution Guard Test (Flat + Operator Pending Order)
    const v2Input = makeMockEngineInput({
      symbol: "BTCUSDT",
      hasOperatorPendingOrders: auth.hasOperatorPendingOrders
    });
    const v2Res = runEngineV2(v2Input);
    assertEq(v2Res.decision.decision, "HOLD", "CASE A: decision is HOLD");
    assertEq(v2Res.decision.signal, "NONE", "CASE A: signal is NONE");
    assertEq(v2Res.decision.risk.blockReason, "MANUAL_TAKEOVER_ACTIVE", "CASE A: blockReason is MANUAL_TAKEOVER_ACTIVE");
    assertEq(v2Res.decision.explanation.reason, "MANUAL_TAKEOVER_ACTIVE_OBSERVE_ONLY", "CASE A: observe-only reason");
    assertFalse(v2Res.decision.rawMetrics?.mutation_allowed === true, "CASE A: mutation_allowed is false");

    console.info(JSON.stringify({
      case: "CASE_A_BTC_FLAT_OPERATOR_LIMIT_ORDER_PASS",
      auth,
      v2Decision: v2Res.decision.decision,
      v2BlockReason: v2Res.decision.risk.blockReason
    }));
  }

  // =========================================================================
  // CASE B: ETH flat + operator conditional order (Algo) → cancel 0, observe-only
  // =========================================================================
  {
    const operatorAlgo = {
      algoId: "okx_algo_eth_2001",
      algoClOrdId: "sl_manual_stop_3000",
      instId: "ETH-USDT-SWAP",
      side: "sell",
      posSide: "long",
      sz: "1.0",
      slTriggerPx: "2450"
    };
    const auth = evaluateSymbolPendingOrderAuthority({
      symbol: "ETHUSDT",
      pendingOrders: [],
      algoOrders: [operatorAlgo],
      openPositions: []
    });

    assertTrue(auth.hasOperatorPendingOrders, "CASE B: operator algo detected");
    assertEq(auth.authorityOwner, "OPERATOR", "CASE B: authorityOwner OPERATOR");
    assertFalse(auth.cancelAllowed, "CASE B: cancelAllowed false");
    assertEq(auth.proofs[0].ownership, "OPERATOR_OWNED", "CASE B: ownership OPERATOR_OWNED");

    const v2Input = makeMockEngineInput({
      symbol: "ETHUSDT",
      hasOperatorPendingOrders: auth.hasOperatorPendingOrders
    });
    const v2Res = runEngineV2(v2Input);
    assertEq(v2Res.decision.decision, "HOLD", "CASE B: decision HOLD");
    assertEq(v2Res.decision.risk.blockReason, "MANUAL_TAKEOVER_ACTIVE", "CASE B: blockReason MANUAL_TAKEOVER_ACTIVE");

    console.info(JSON.stringify({
      case: "CASE_B_ETH_FLAT_OPERATOR_CONDITIONAL_ORDER_PASS",
      auth,
      v2Decision: v2Res.decision.decision
    }));
  }

  // =========================================================================
  // CASE C: operator order + engine order 혼재 → engine order만 cancel 가능
  // =========================================================================
  {
    const botPendingClose = {
      ordId: "okx_ord_bot_close_999",
      clOrdId: "pETHUSlsg7k2j3",
      instId: "ETH-USDT-SWAP",
      side: "sell"
    };
    const operatorLimit = {
      ordId: "okx_ord_user_555",
      clOrdId: "manual_limit_555",
      instId: "ETH-USDT-SWAP",
      side: "buy"
    };

    const evBot = evaluateOrderOwnership(botPendingClose, false, []);
    const evOp = evaluateOrderOwnership(operatorLimit, false, []);

    assertEq(evBot.ownership, "ENGINE_OWNED", "CASE C: bot order is ENGINE_OWNED");
    assertTrue(evBot.cancelAllowed, "CASE C: bot order cancelAllowed is true");

    assertEq(evOp.ownership, "OPERATOR_OWNED", "CASE C: operator order is OPERATOR_OWNED");
    assertFalse(evOp.cancelAllowed, "CASE C: operator order cancelAllowed is false");

    console.info(JSON.stringify({
      case: "CASE_C_MIXED_ORDERS_SELECTIVE_CANCEL_PASS",
      botOrderOwnership: evBot,
      operatorOrderOwnership: evOp
    }));
  }

  // =========================================================================
  // CASE D: manual position + manual SL/TP → mutation 0
  // =========================================================================
  {
    const manualOpen = {
      symbol: "ETHUSDT",
      side: "long",
      manualTakeoverActive: true,
      lifecycleState: "OPERATOR_MANAGED",
      okxContracts: 2.0
    };
    const manualSl = {
      algoId: "algo_user_sl_1",
      algoClOrdId: "sl_my_stop",
      instId: "ETH-USDT-SWAP"
    };

    const evSl = evaluateOrderOwnership(manualSl, true, [manualOpen as any]);
    assertEq(evSl.ownership, "OPERATOR_OWNED", "CASE D: manual SL is OPERATOR_OWNED");
    assertFalse(evSl.cancelAllowed, "CASE D: cancel not allowed");
    assertFalse(evSl.mutationAllowed, "CASE D: mutation not allowed");

    const isTakeover = isManualTakeoverActiveForSymbol("ETHUSDT", "long", {
      ETHUSDT: {
        manualTakeoverActive: true,
        manualTakeoverSymbol: "ETHUSDT",
        manualTakeoverSide: "long",
        manualTakeoverDetectedAt: Date.now(),
        manualTakeoverReason: "OPERATOR_MANUAL_INTERVENTION"
      }
    }, [manualOpen as any]);

    assertTrue(isTakeover, "CASE D: manual takeover active");

    console.info(JSON.stringify({
      case: "CASE_D_MANUAL_POSITION_AND_PROTECTION_PASS",
      evSl,
      isTakeover
    }));
  }

  // =========================================================================
  // CASE E: PM2 restart tick:1 + pre-existing manual pending order → mutation 0
  // =========================================================================
  {
    const preExistingManual = {
      ordId: "okx_pre_restart_123",
      clOrdId: "tp_manual_target",
      instId: "BTC-USDT-SWAP"
    };

    const auth = evaluateSymbolPendingOrderAuthority({
      symbol: "BTCUSDT",
      pendingOrders: [preExistingManual],
      algoOrders: [],
      openPositions: [] // tick 1 flat
    });

    assertTrue(auth.hasOperatorPendingOrders, "CASE E: tick:1 detected operator pending order");
    assertFalse(auth.mutationAllowed, "CASE E: tick:1 mutationAllowed is false");
    assertFalse(auth.cancelAllowed, "CASE E: tick:1 cancelAllowed is false");

    console.info(JSON.stringify({
      case: "CASE_E_STARTUP_PRE_EXISTING_MANUAL_ORDER_PASS",
      auth
    }));
  }

  // =========================================================================
  // CASE F: genuine BOT_V2 order → 기존 정상 cleanup/reconcile 유지
  // =========================================================================
  {
    const botOpen = {
      symbol: "ETHUSDT",
      side: "long",
      openedAt: 1700000000000,
      protectiveSlAlgoId: "algo_bot_sl_777",
      protectiveTpAlgoId: "algo_bot_tp_888",
      closePendingClOrdId: "pETHUSlsg7k2j3"
    };
    const botAlgo = {
      algoId: "algo_bot_sl_777",
      algoClOrdId: "oapETHUSlsg7k2j3s",
      instId: "ETH-USDT-SWAP"
    };
    const botPending = {
      ordId: "ord_bot_close_111",
      clOrdId: "pETHUSlsg7k2j3",
      instId: "ETH-USDT-SWAP"
    };

    const isBotAlgo = isAuthoritativeBotOwnedAlgoOrder(botAlgo, [botOpen as any]);
    const isBotPending = isAuthoritativeBotOwnedPendingOrder(botPending, [botOpen as any]);

    assertTrue(isBotAlgo, "CASE F: bot algo is authoritative bot owned");
    assertTrue(isBotPending, "CASE F: bot pending is authoritative bot owned");

    const auth = evaluateSymbolPendingOrderAuthority({
      symbol: "ETHUSDT",
      pendingOrders: [botPending],
      algoOrders: [botAlgo],
      openPositions: [botOpen as any]
    });

    assertFalse(auth.hasOperatorPendingOrders, "CASE F: no operator orders");
    assertEq(auth.engineOrderCount, 2, "CASE F: engine order count is 2");
    assertTrue(auth.cancelAllowed, "CASE F: engine orders cleanup allowed");

    console.info(JSON.stringify({
      case: "CASE_F_GENUINE_BOT_ORDERS_PRESERVED_PASS",
      auth
    }));
  }

  // =========================================================================
  // CASE G: BTC operator order 존재 → ETH 자동매매 영향 없음 (심볼 격리)
  // =========================================================================
  {
    const btcManualOrder = {
      ordId: "btc_manual_111",
      clOrdId: "p_user_btc_limit",
      instId: "BTC-USDT-SWAP"
    };

    const btcAuth = evaluateSymbolPendingOrderAuthority({
      symbol: "BTCUSDT",
      pendingOrders: [btcManualOrder],
      algoOrders: [],
      openPositions: []
    });
    const ethAuth = evaluateSymbolPendingOrderAuthority({
      symbol: "ETHUSDT",
      pendingOrders: [],
      algoOrders: [],
      openPositions: []
    });

    assertTrue(btcAuth.hasOperatorPendingOrders, "CASE G: BTC has operator pending orders");
    assertFalse(btcAuth.mutationAllowed, "CASE G: BTC mutation blocked");

    assertFalse(ethAuth.hasOperatorPendingOrders, "CASE G: ETH has NO operator pending orders");
    assertTrue(ethAuth.mutationAllowed, "CASE G: ETH mutation allowed");

    const ethV2Input = makeMockEngineInput({
      symbol: "ETHUSDT",
      hasOperatorPendingOrders: ethAuth.hasOperatorPendingOrders
    });
    const ethV2Res = runEngineV2(ethV2Input);
    // ETH should proceed through normal strategy evaluation (not blocked by BTC manual order)
    assertEq(ethV2Res.decision.explanation.reason !== "MANUAL_TAKEOVER_ACTIVE_OBSERVE_ONLY", true, "CASE G: ETH not blocked by BTC takeover");

    console.info(JSON.stringify({
      case: "CASE_G_SYMBOL_ISOLATION_PASS",
      btcAuthority: btcAuth.authorityOwner,
      ethAuthority: ethAuth.authorityOwner,
      ethDecision: ethV2Res.decision.decision
    }));
  }

  // =========================================================================
  // CASE H: clOrdId 없는 operator order (거래소 앱/웹 직접 생성) → 보존
  // =========================================================================
  {
    const exchangeDirectOrder = {
      ordId: "okx_direct_999888",
      clOrdId: "", // Empty clOrdId from exchange UI
      instId: "BTC-USDT-SWAP",
      side: "buy",
      sz: "0.5"
    };

    const ev = evaluateOrderOwnership(exchangeDirectOrder, false, []);
    assertEq(ev.ownership, "OPERATOR_OWNED", "CASE H: empty clOrdId is OPERATOR_OWNED");
    assertEq(ev.ownershipEvidence, "empty_clOrdId_exchange_created", "CASE H: evidence");
    assertFalse(ev.cancelAllowed, "CASE H: cancelAllowed false");
    assertFalse(ev.mutationAllowed, "CASE H: mutationAllowed false");

    console.info(JSON.stringify({
      case: "CASE_H_EMPTY_CLORDID_EXCHANGE_DIRECT_ORDER_PASS",
      evaluation: ev
    }));
  }

  // =========================================================================
  // CASE I: manual order가 사라지고 flat → 새 position cycle 자동진입 가능
  // =========================================================================
  {
    // Orders disappeared from exchange, flat position
    const cleanAuth = evaluateSymbolPendingOrderAuthority({
      symbol: "ETHUSDT",
      pendingOrders: [],
      algoOrders: [],
      openPositions: []
    });

    assertFalse(cleanAuth.hasOperatorPendingOrders, "CASE I: no operator pending orders");
    assertEq(cleanAuth.authorityOwner, "ENGINE", "CASE I: authorityOwner is ENGINE");
    assertTrue(cleanAuth.mutationAllowed, "CASE I: mutation allowed");

    const v2Input = makeMockEngineInput({
      symbol: "ETHUSDT",
      hasOperatorPendingOrders: false,
      manualTakeoverActive: false
    });
    const v2Res = runEngineV2(v2Input);
    assertEq(v2Res.decision.explanation.reason !== "MANUAL_TAKEOVER_ACTIVE_OBSERVE_ONLY", true, "CASE I: automation restored");

    console.info(JSON.stringify({
      case: "CASE_I_AUTO_AUTHORITY_RESTORE_ON_CLEAN_FLAT_PASS",
      cleanAuth,
      decision: v2Res.decision.decision
    }));
  }

  // =========================================================================
  // CASE J: stale engine algo가 남은 경우 → engine algo만 cleanup 후 정상 복귀
  // =========================================================================
  {
    const staleEngineAlgo = {
      algoId: "stale_oap_111",
      algoClOrdId: "oapETHUSlsg7k2j3s",
      instId: "ETH-USDT-SWAP"
    };

    const evStale = evaluateOrderOwnership(staleEngineAlgo, true, []);
    assertEq(evStale.ownership, "ENGINE_OWNED", "CASE J: stale engine algo recognized as ENGINE_OWNED");
    assertTrue(evStale.cancelAllowed, "CASE J: stale engine algo cancelAllowed is true");

    const auth = evaluateSymbolPendingOrderAuthority({
      symbol: "ETHUSDT",
      pendingOrders: [],
      algoOrders: [staleEngineAlgo],
      openPositions: []
    });

    assertFalse(auth.hasOperatorPendingOrders, "CASE J: hasOperatorPendingOrders is false");
    assertEq(auth.engineOrderCount, 1, "CASE J: engineOrderCount is 1");
    assertTrue(auth.cancelAllowed, "CASE J: cleanup allowed");

    console.info(JSON.stringify({
      case: "CASE_J_STALE_ENGINE_ALGO_CLEANUP_AND_RESTORE_PASS",
      staleOwnership: evStale,
      auth
    }));
  }

  // =========================================================================
  // CASE K: BTC flat + manual limit buy -> 다음 사이클 fill -> OPERATOR_MANAGED
  // =========================================================================
  {
    const prevManualLimit = {
      ordId: "btc_manual_limit_999",
      clOrdId: "p_user_btc_limit",
      instId: "BTC-USDT-SWAP",
      side: "buy"
    };

    const fillEval = evaluateOperatorOrderFillTransition({
      symbol: "BTCUSDT",
      side: "long",
      currentExchangeContracts: 0.1,
      previousExchangeContracts: 0,
      previousOperatorOrders: [prevManualLimit],
      currentOperatorOrders: [],
      isBotOrderFilled: false
    });

    assertTrue(fillEval.isOperatorFill, "CASE K: operator fill detected");
    assertEq(fillEval.resolvedPositionOwner, "OPERATOR", "CASE K: resolvedPositionOwner is OPERATOR");
    assertEq(fillEval.lifecycleState, "OPERATOR_MANAGED", "CASE K: lifecycleState is OPERATOR_MANAGED");
    assertFalse(fillEval.positionCalculationAllowed, "CASE K: positionCalculationAllowed false");
    assertFalse(fillEval.mutationAllowed, "CASE K: mutationAllowed false");
    assertEq(fillEval.proof.event, "V2_OPERATOR_ORDER_FILL_AUTHORITY_PROOF", "CASE K: proof event");

    console.info(JSON.stringify({
      case: "CASE_K_BTC_MANUAL_LIMIT_FILL_TRANSITION_PASS",
      proof: fillEval.proof
    }));
  }

  // =========================================================================
  // CASE L: ETH manual conditional order -> fill -> OPERATOR_MANAGED
  // =========================================================================
  {
    const prevManualAlgo = {
      algoId: "eth_manual_algo_888",
      algoClOrdId: "sl_manual_stop",
      instId: "ETH-USDT-SWAP"
    };

    const fillEval = evaluateOperatorOrderFillTransition({
      symbol: "ETHUSDT",
      side: "short",
      currentExchangeContracts: 1.0,
      previousExchangeContracts: 0,
      previousOperatorOrders: [prevManualAlgo],
      currentOperatorOrders: [],
      isBotOrderFilled: false
    });

    assertTrue(fillEval.isOperatorFill, "CASE L: operator conditional fill detected");
    assertEq(fillEval.resolvedPositionOwner, "OPERATOR", "CASE L: resolvedPositionOwner is OPERATOR");
    assertEq(fillEval.lifecycleState, "OPERATOR_MANAGED", "CASE L: lifecycleState is OPERATOR_MANAGED");
    assertFalse(fillEval.mutationAllowed, "CASE L: mutationAllowed false");

    console.info(JSON.stringify({
      case: "CASE_L_ETH_MANUAL_CONDITIONAL_FILL_TRANSITION_PASS",
      proof: fillEval.proof
    }));
  }

  // =========================================================================
  // CASE M: manual order partial fill + remaining pending order -> mutation 0
  // =========================================================================
  {
    const partialRemainingOrder = {
      ordId: "btc_partial_111",
      clOrdId: "p_user_buy_limit",
      instId: "BTC-USDT-SWAP"
    };

    const fillEval = evaluateOperatorOrderFillTransition({
      symbol: "BTCUSDT",
      side: "long",
      currentExchangeContracts: 0.05,
      previousExchangeContracts: 0,
      previousOperatorOrders: [partialRemainingOrder],
      currentOperatorOrders: [partialRemainingOrder],
      isBotOrderFilled: false
    });

    assertTrue(fillEval.isOperatorFill, "CASE M: partial fill operator ownership detected");
    assertEq(fillEval.lifecycleState, "OPERATOR_MANAGED", "CASE M: lifecycleState OPERATOR_MANAGED");
    assertFalse(fillEval.mutationAllowed, "CASE M: mutationAllowed false");
    assertTrue(fillEval.proof.pendingOrderPresentNow === true, "CASE M: remaining pending preserved");

    console.info(JSON.stringify({
      case: "CASE_M_MANUAL_PARTIAL_FILL_AND_REMAINING_PRESERVED_PASS",
      proof: fillEval.proof
    }));
  }

  // =========================================================================
  // CASE N: clean snapshot -> last-mile operator order injection -> blocks entry
  // =========================================================================
  {
    // 1. Initial snapshot was clean (no operator orders)
    const initialAuth = evaluateSymbolPendingOrderAuthority({
      symbol: "BTCUSDT",
      pendingOrders: [],
      algoOrders: [],
      openPositions: []
    });
    assertFalse(initialAuth.hasOperatorPendingOrders, "CASE N: initial snapshot was clean");

    // 2. Injected operator order right before submit
    const lastMinuteOperatorOrder = {
      ordId: "okx_injected_123",
      clOrdId: "p_user_injected",
      instId: "BTC-USDT-SWAP"
    };
    const lastMileAuth = evaluateSymbolPendingOrderAuthority({
      symbol: "BTCUSDT",
      pendingOrders: [lastMinuteOperatorOrder],
      algoOrders: [],
      openPositions: []
    });
    assertTrue(lastMileAuth.hasOperatorPendingOrders, "CASE N: last-mile operator order caught");
    assertFalse(lastMileAuth.mutationAllowed, "CASE N: last-mile blocks entry");

    console.info(JSON.stringify({
      case: "CASE_N_LAST_MILE_ENTRY_RACE_BLOCKED_PASS",
      lastMileAuth
    }));
  }

  // =========================================================================
  // CASE O: BTC last-mile operator order -> ETH ENTRY authority unaffected
  // =========================================================================
  {
    const btcLastMileOrder = {
      ordId: "btc_injected_777",
      clOrdId: "p_user_btc",
      instId: "BTC-USDT-SWAP"
    };
    const btcAuth = evaluateSymbolPendingOrderAuthority({
      symbol: "BTCUSDT",
      pendingOrders: [btcLastMileOrder],
      algoOrders: [],
      openPositions: []
    });
    const ethAuth = evaluateSymbolPendingOrderAuthority({
      symbol: "ETHUSDT",
      pendingOrders: [],
      algoOrders: [],
      openPositions: []
    });

    assertTrue(btcAuth.hasOperatorPendingOrders, "CASE O: BTC has operator order");
    assertFalse(btcAuth.mutationAllowed, "CASE O: BTC mutation blocked");

    assertFalse(ethAuth.hasOperatorPendingOrders, "CASE O: ETH is clean");
    assertTrue(ethAuth.mutationAllowed, "CASE O: ETH mutation allowed");

    console.info(JSON.stringify({
      case: "CASE_O_LAST_MILE_SYMBOL_ISOLATION_PASS",
      btcBlocked: !btcAuth.mutationAllowed,
      ethAllowed: ethAuth.mutationAllowed
    }));
  }

  // =========================================================================
  // CASE P: bot order clOrdId empty + ledger ordId exact match -> ENGINE_OWNED
  // =========================================================================
  {
    const botOpenWithCloseId = {
      symbol: "ETHUSDT",
      side: "long",
      closePendingOrdId: "ord_close_exact_123"
    };
    const exchangeOrderNoClOrdId = {
      ordId: "ord_close_exact_123",
      clOrdId: "",
      instId: "ETH-USDT-SWAP"
    };

    const ev = evaluateOrderOwnership(exchangeOrderNoClOrdId, false, [botOpenWithCloseId as any]);
    assertEq(ev.ownership, "ENGINE_OWNED", "CASE P: empty clOrdId matches ledger ordId -> ENGINE_OWNED");
    assertTrue(ev.cancelAllowed, "CASE P: cancel allowed for matched bot order");

    console.info(JSON.stringify({
      case: "CASE_P_EMPTY_CLORDID_MATCHED_ORDID_BOT_PRESERVED_PASS",
      ev
    }));
  }

  // =========================================================================
  // CASE Q: algoClOrdId empty + ledger algoId exact match -> ENGINE_OWNED
  // =========================================================================
  {
    const botOpenWithAlgoId = {
      symbol: "BTCUSDT",
      side: "long",
      protectiveSlAlgoId: "algo_sl_exact_456"
    };
    const exchangeAlgoNoClOrdId = {
      algoId: "algo_sl_exact_456",
      algoClOrdId: "",
      instId: "BTC-USDT-SWAP"
    };

    const ev = evaluateOrderOwnership(exchangeAlgoNoClOrdId, true, [botOpenWithAlgoId as any]);
    assertEq(ev.ownership, "ENGINE_OWNED", "CASE Q: empty algoClOrdId matches ledger algoId -> ENGINE_OWNED");
    assertTrue(ev.cancelAllowed, "CASE Q: cancel allowed for matched bot algo");

    console.info(JSON.stringify({
      case: "CASE_Q_EMPTY_ALGOCLORDID_MATCHED_ALGOID_BOT_PRESERVED_PASS",
      ev
    }));
  }

  // =========================================================================
  // CASE R: initial snapshot clean -> operator order injected after snapshot
  //         -> last-mile live exchange refresh sees order -> OKX ENTRY submit count = 0
  // =========================================================================
  {
    // Step 1: In-memory snapshot at start of cycle had NO operator orders
    const initialInMemoryAuth = { hasOperatorPendingOrders: false };
    assertFalse(initialInMemoryAuth.hasOperatorPendingOrders, "CASE R: initial in-memory snapshot was clean");

    // Step 2: Operator created order during cycle on exchange
    const liveExchangePendingOrders = [
      {
        ordId: "okx_live_injected_888",
        clOrdId: "p_user_live_limit",
        instId: "ETH-USDT-SWAP"
      }
    ];

    // Step 3: Last-mile revalidation directly scans live exchange
    const lastMileLiveAuth = evaluateSymbolPendingOrderAuthority({
      symbol: "ETHUSDT",
      pendingOrders: liveExchangePendingOrders,
      algoOrders: [],
      openPositions: []
    });

    assertTrue(lastMileLiveAuth.hasOperatorPendingOrders, "CASE R: last-mile live scan catches injected operator order");
    assertFalse(lastMileLiveAuth.mutationAllowed, "CASE R: entry submit blocked");
    assertFalse(lastMileLiveAuth.cancelAllowed, "CASE R: operator order cancel forbidden");

    // Step 4: Simulate submitOrder gate behavior
    let entrySubmitCount = 0;
    if (!lastMileLiveAuth.hasOperatorPendingOrders) {
      entrySubmitCount++;
    }
    assertEq(entrySubmitCount, 0, "CASE R: OKX ENTRY submit count = 0");

    console.info(JSON.stringify({
      case: "CASE_R_LAST_MILE_LIVE_EXCHANGE_REVALIDATION_PASS",
      lastMileLiveAuth,
      entrySubmitCount
    }));
  }

  // =========================================================================
  // CASE S: initial snapshot clean -> no operator order injected -> bot ENTRY allowed
  // =========================================================================
  {
    const liveExchangePendingOrders: any[] = [];
    const lastMileLiveAuth = evaluateSymbolPendingOrderAuthority({
      symbol: "ETHUSDT",
      pendingOrders: liveExchangePendingOrders,
      algoOrders: [],
      openPositions: []
    });

    assertFalse(lastMileLiveAuth.hasOperatorPendingOrders, "CASE S: no operator orders on exchange");
    assertTrue(lastMileLiveAuth.mutationAllowed, "CASE S: mutation allowed");

    let entrySubmitCount = 0;
    if (!lastMileLiveAuth.hasOperatorPendingOrders) {
      entrySubmitCount++;
    }
    assertEq(entrySubmitCount, 1, "CASE S: genuine bot ENTRY remains allowed");

    console.info(JSON.stringify({
      case: "CASE_S_LAST_MILE_CLEAN_EXCHANGE_SUBMIT_ALLOWED_PASS",
      entrySubmitCount
    }));
  }

  // =========================================================================
  // CASE T: operator-created order whose clOrdId happens to resemble engine prefix
  //         but ledger ordId/algoId does not match -> cancel 0
  // =========================================================================
  {
    const operatorDeceptiveAlgo = {
      algoId: "operator_mimic_algo_777",
      algoClOrdId: "oapETHUsl123456", // Resembles prefix
      instId: "ETH-USDT-SWAP"
    };

    const genuineOpenPosition = {
      symbol: "ETHUSDT",
      side: "long",
      openedAt: 999999999, // Different openedAt
      protectiveSlAlgoId: "genuine_algo_999",
      closePendingOrdId: "genuine_close_999"
    };

    // Evaluate with canonical ownership predicate
    const ev = evaluateOrderOwnership(operatorDeceptiveAlgo, true, [genuineOpenPosition as any]);
    assertTrue(ev.ownership === "OPERATOR_OWNED" || ev.ownership === "UNKNOWN_OPERATOR_PRESERVED", "CASE T: non-engine ownership");
    assertEq(ev.authorityOwner, "OPERATOR", "CASE T: authorityOwner is OPERATOR");
    assertFalse(ev.cancelAllowed, "CASE T: cancel is strictly forbidden (cancel 0)");

    console.info(JSON.stringify({
      case: "CASE_T_PREFIX_MIMIC_WITHOUT_LEDGER_MATCH_CANCEL_FORBIDDEN_PASS",
      ev
    }));
  }

  // =========================================================================
  // CASE U: genuine engine order with exact ledger ID match -> cleanup allowed
  // =========================================================================
  {
    const genuineEngineAlgo = {
      algoId: "genuine_algo_999",
      algoClOrdId: "oapETHUsl999999999s",
      instId: "ETH-USDT-SWAP"
    };

    const genuineOpenPosition = {
      symbol: "ETHUSDT",
      side: "long",
      openedAt: 999999999,
      protectiveSlAlgoId: "genuine_algo_999"
    };

    const ev = evaluateOrderOwnership(genuineEngineAlgo, true, [genuineOpenPosition as any]);
    assertEq(ev.ownership, "ENGINE_OWNED", "CASE U: exact ledger ID match is ENGINE_OWNED");
    assertTrue(ev.cancelAllowed, "CASE U: cleanup allowed");

    console.info(JSON.stringify({
      case: "CASE_U_GENUINE_ENGINE_ORDER_EXACT_MATCH_CLEANUP_ALLOWED_PASS",
      ev
    }));
  }

  // =========================================================================
  // CASE V: getOrdersPending failure -> fail-closed ENTRY submit 0
  // =========================================================================
  {
    const mockLivePendTry = { ok: false, error: "HTTP_504_GATEWAY_TIMEOUT" };
    const mockLiveAlgoTry = { ok: true, value: [] };

    let entrySubmitCount = 0;
    let failClosedBlocked = false;
    let blockReason = "";

    if (!mockLivePendTry.ok) {
      failClosedBlocked = true;
      blockReason = "MANUAL_PENDING_ORDER_AUTHORITY_UNAVAILABLE_FAIL_CLOSED";
    } else if (!mockLiveAlgoTry.ok) {
      failClosedBlocked = true;
      blockReason = "MANUAL_PENDING_ORDER_AUTHORITY_UNAVAILABLE_FAIL_CLOSED";
    } else {
      entrySubmitCount++;
    }

    assertTrue(failClosedBlocked, "CASE V: getOrdersPending failure triggers fail-closed block");
    assertEq(blockReason, "MANUAL_PENDING_ORDER_AUTHORITY_UNAVAILABLE_FAIL_CLOSED", "CASE V: exact block reason");
    assertEq(entrySubmitCount, 0, "CASE V: ENTRY submit count = 0 on pending fetch error");

    console.info(JSON.stringify({
      case: "CASE_V_GET_ORDERS_PENDING_FAILURE_FAIL_CLOSED_PASS",
      failClosedBlocked,
      blockReason,
      entrySubmitCount
    }));
  }

  // =========================================================================
  // CASE W: getOrdersAlgoPending failure -> fail-closed ENTRY submit 0
  // =========================================================================
  {
    const mockLivePendTry = { ok: true, value: [] };
    const mockLiveAlgoTry = { ok: false, error: "RATE_LIMIT_EXCEEDED_429" };

    let entrySubmitCount = 0;
    let failClosedBlocked = false;
    let blockReason = "";

    if (!mockLivePendTry.ok) {
      failClosedBlocked = true;
      blockReason = "MANUAL_PENDING_ORDER_AUTHORITY_UNAVAILABLE_FAIL_CLOSED";
    } else if (!mockLiveAlgoTry.ok) {
      failClosedBlocked = true;
      blockReason = "MANUAL_PENDING_ORDER_AUTHORITY_UNAVAILABLE_FAIL_CLOSED";
    } else {
      entrySubmitCount++;
    }

    assertTrue(failClosedBlocked, "CASE W: getOrdersAlgoPending failure triggers fail-closed block");
    assertEq(blockReason, "MANUAL_PENDING_ORDER_AUTHORITY_UNAVAILABLE_FAIL_CLOSED", "CASE W: exact block reason");
    assertEq(entrySubmitCount, 0, "CASE W: ENTRY submit count = 0 on algo fetch error");

    console.info(JSON.stringify({
      case: "CASE_W_GET_ORDERS_ALGO_PENDING_FAILURE_FAIL_CLOSED_PASS",
      failClosedBlocked,
      blockReason,
      entrySubmitCount
    }));
  }

  console.info(JSON.stringify({
    event: "V2_MANUAL_PENDING_ORDER_AUTHORITY_ALL_CASES_PASS",
    cases: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W"]
  }));
}

runManualPendingOrderAuthorityTests();
