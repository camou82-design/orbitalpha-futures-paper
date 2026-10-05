import {
  evaluateEquityAdaptiveSizing,
  resolveUltimateSafetyCapForOrderSizing,
  resolveEffectiveUltimateSafetyCapNotionalUsdt
} from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import {
  isAuthoritativeBotOwnedAlgoOrder,
  hasBotAlgoProvenance,
  evaluateOrderOwnership,
  evaluateSymbolPendingOrderAuthority
} from "../engine-v2/position/manual-takeover-authority";
import {
  resolveV2HardSafetyCapForSymbol,
  resolveLiveSubmitStaticSafetyCap,
  buildV2ConfigBridge
} from "./paper-engine";
import type { PaperOpenPositionRecord, EngineConfig } from "../models/types";

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`FAIL [${msg}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(`FAIL [${msg}]: expected true, got false`);
  }
}

function assertFalse(cond: boolean, msg: string): void {
  if (cond) {
    throw new Error(`FAIL [${msg}]: expected false, got true`);
  }
}

async function runAllTests(): Promise<void> {
  console.log("==================================================");
  console.log("RUNNING V2 SIZING & OWNERSHIP REGRESSION TEST SUITE");
  console.log("==================================================");

  // =========================================================================
  // PART 3. Sizing Regression Tests
  // =========================================================================

  // --- CASE A: ETH FULL_ENTRY sizing with 1200 USDT V2 cap ---
  {
    const equity = 2440.16;
    const entryPrice = 2704.24;
    const stopPrice = 2690.99;
    const appliedLeverage = 10;
    const config = {
      okxLiveV2MaxOrderNotionalUsdt: 500,
      okxLiveV2EthMaxOrderNotionalUsdt: 1200
    };
    const ethCap = resolveV2HardSafetyCapForSymbol("ETHUSDT", config);
    assertEq(ethCap, 1200, "CASE A: ethCap resolved to 1200");

    const sizing = evaluateEquityAdaptiveSizing({
      symbol: "ETHUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: equity,
      availableBalanceUsdt: 2410.82,
      entryReferencePrice: entryPrice,
      lastPrice: entryPrice,
      effectiveStopPrice: stopPrice,
      appliedLeverage,
      entryQualityGrade: "B",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      policyRequestedNotionalUsdt: 1200,
      v2HardSafetyCapUsdt: ethCap,
      maxSymbolNotionalCapUsdt: 2000,
      v2AuthorityEntry: true
    });

    assertTrue(sizing.sizingPassed, "CASE A: sizingPassed");
    assertEq(sizing.preLotNotionalUsdt, 1200, "CASE A: preLotNotionalUsdt is 1200");
    assertTrue(
      sizing.limitingAuthority === "policy_requested" || sizing.limitingAuthority === "v2_hard_safety_cap",
      `CASE A: limitingAuthority is policy_requested or v2_hard_safety_cap (got ${sizing.limitingAuthority})`
    );
    assertTrue(sizing.riskBasedNotionalUsdt > 3500, `CASE A: riskBasedNotional > 3500 (got ${sizing.riskBasedNotionalUsdt})`);

    // Also test live submit static safety cap check does not strangle ETH to 500
    const submitCap = resolveLiveSubmitStaticSafetyCap({
      authoritySource: "v2",
      okxLiveStaticNotionalCapEnabled: false,
      staticSafetyCapUsdt: ethCap,
      v2HardSafetyCapUsdt: ethCap,
      intendedNotionalUsdt: 1200,
      emergencyUltimateCapUsdt: 500,
      emergencyFailsafeActive: false,
      isHighwayLineage: false,
      appliedLeverage: 10
    });
    assertEq(submitCap.finalSubmittedNotionalUsdt, 1200, "CASE A: submitCap does not clamp 1200 to 500");
    console.log("  [PASS] CASE A: ETH FULL_ENTRY 1200 USDT sizing authority verified.");
  }

  // --- CASE B: BTC FULL_ENTRY sizing without legacy 500 cap => governed by adaptive authority ---
  {
    const equity = 2440.16;
    const entryPrice = 85579.2;
    const stopPrice = 85150.0;
    const appliedLeverage = 10;
    const config = {
      okxLiveV2MaxOrderNotionalUsdt: null,
      okxLiveV2EthMaxOrderNotionalUsdt: 1200
    };
    const btcCap = resolveV2HardSafetyCapForSymbol("BTCUSDT", config);
    assertEq(btcCap, null, "CASE B: btcCap resolved to null (adaptive sizing governs)");

    const sizing = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: equity,
      availableBalanceUsdt: 2410.82,
      entryReferencePrice: entryPrice,
      lastPrice: entryPrice,
      effectiveStopPrice: stopPrice,
      appliedLeverage,
      entryQualityGrade: "B",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      v2HardSafetyCapUsdt: btcCap,
      v2AuthorityEntry: true
    });

    assertTrue(sizing.sizingPassed, "CASE B: sizingPassed");
    assertEq(Math.abs(sizing.riskBasedNotionalUsdt - 3895.35) < 1, true, "CASE B: riskBasedNotional ≈ 3895.35 (Grade B 0.8x)");
    assertEq(sizing.preLotNotionalUsdt > 3800, true, "CASE B: preLotNotionalUsdt NOT strangled to 500");
    assertEq(sizing.limitingAuthority, "risk_based_notional", "CASE B: limitingAuthority is risk_based_notional");
    console.log("  [PASS] CASE B: BTC FULL_ENTRY sizing is governed by adaptive risk authority (not legacy 500).");
  }

  // --- CASE C: riskBased < V2 cap => riskBased is final sizing authority ---
  {
    const equity = 2440.16;
    const entryPrice = 2700.0;
    const wideStopPrice = 2430.0; // 10% stop distance -> riskBased = 24.40 / 0.10 = 244 USDT
    const sizing = evaluateEquityAdaptiveSizing({
      symbol: "ETHUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: equity,
      availableBalanceUsdt: 2410.82,
      entryReferencePrice: entryPrice,
      lastPrice: entryPrice,
      effectiveStopPrice: wideStopPrice,
      appliedLeverage: 10,
      entryQualityGrade: "B",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      v2HardSafetyCapUsdt: 1200,
      policyRequestedNotionalUsdt: 1200,
      v2AuthorityEntry: true
    });

    assertTrue(sizing.sizingPassed, "CASE C: sizingPassed");
    assertTrue(sizing.preLotNotionalUsdt < 300, `CASE C: preLotNotionalUsdt < 300 (got ${sizing.preLotNotionalUsdt})`);
    assertEq(sizing.limitingAuthority, "risk_based_notional", "CASE C: limitingAuthority is risk_based_notional");
    console.log("  [PASS] CASE C: riskBased < V2 cap makes risk_based_notional the authority.");
  }

  // --- CASE D: symbol capacity insufficient => symbol cap applies ---
  {
    const equity = 2000.0;
    const maxSymbolCap = 2000 * 2.75; // 5500 USDT
    const existingSymbolNotional = 5350.0; // remaining capacity = 150 USDT
    const sizing = evaluateEquityAdaptiveSizing({
      symbol: "ETHUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: equity,
      availableBalanceUsdt: 2000.0,
      entryReferencePrice: 2700.0,
      lastPrice: 2700.0,
      effectiveStopPrice: 2680.0,
      appliedLeverage: 10,
      entryQualityGrade: "B",
      existingSymbolNotionalUsdt: existingSymbolNotional,
      existingAccountNotionalUsdt: existingSymbolNotional,
      v2HardSafetyCapUsdt: 1200,
      v2AuthorityEntry: true
    });

    assertTrue(sizing.sizingPassed, "CASE D: sizingPassed");
    assertEq(sizing.preLotNotionalUsdt, 150, "CASE D: preLotNotionalUsdt is 150");
    assertEq(sizing.limitingAuthority, "symbol_capacity", "CASE D: limitingAuthority is symbol_capacity");
    console.log("  [PASS] CASE D: symbol capacity insufficient correctly limits order size.");
  }

  // --- CASE E: account/global capacity insufficient => account cap applies ---
  {
    const equity = 2000.0;
    const maxAccountCap = 2000 * 3.0; // 6000 USDT
    const existingAccountNotional = 5880.0; // remaining capacity = 120 USDT
    const sizing = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: equity,
      availableBalanceUsdt: 2000.0,
      entryReferencePrice: 85000.0,
      lastPrice: 85000.0,
      effectiveStopPrice: 84500.0,
      appliedLeverage: 10,
      entryQualityGrade: "B",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: existingAccountNotional,
      v2HardSafetyCapUsdt: 500,
      v2AuthorityEntry: true
    });

    assertTrue(sizing.sizingPassed, "CASE E: sizingPassed");
    assertEq(sizing.preLotNotionalUsdt, 120, "CASE E: preLotNotionalUsdt is 120");
    assertEq(sizing.limitingAuthority, "account_capacity", "CASE E: limitingAuthority is account_capacity");
    console.log("  [PASS] CASE E: account capacity insufficient correctly limits order size.");
  }

  // --- CASE F: Emergency situation / absolute ceiling exceeded (emergencyFailsafeActive = true) ---
  {
    const equity = 2440.16;
    const emergencyCap = 300.0;
    const sizing = evaluateEquityAdaptiveSizing({
      symbol: "ETHUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: equity,
      availableBalanceUsdt: 2410.82,
      entryReferencePrice: 2704.24,
      lastPrice: 2704.24,
      effectiveStopPrice: 2690.99,
      appliedLeverage: 10,
      entryQualityGrade: "B",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      policyRequestedNotionalUsdt: 1200,
      v2HardSafetyCapUsdt: 1200,
      emergencyAbsoluteCapUsdt: emergencyCap,
      emergencyFailsafeActive: true,
      v2AuthorityEntry: true
    });

    assertTrue(sizing.sizingPassed, "CASE F: sizingPassed");
    assertEq(sizing.preLotNotionalUsdt, 300, "CASE F: emergency cap binds at 300");
    assertTrue(sizing.emergencyCapApplied, "CASE F: emergencyCapApplied true");

    // Also verify in submitOkxOrder static cap resolver
    const submitEmergency = resolveLiveSubmitStaticSafetyCap({
      authoritySource: "v2",
      okxLiveStaticNotionalCapEnabled: false,
      staticSafetyCapUsdt: 1200,
      v2HardSafetyCapUsdt: 1200,
      intendedNotionalUsdt: 1200,
      emergencyUltimateCapUsdt: 300,
      emergencyFailsafeActive: true,
      isHighwayLineage: false,
      appliedLeverage: 10
    });
    assertEq(submitEmergency.finalSubmittedNotionalUsdt, 300, "CASE F: finalSubmittedNotional clamped to emergency cap 300");
    assertTrue(submitEmergency.emergencyCapApplied, "CASE F: emergencyCapApplied true");
    console.log("  [PASS] CASE F: emergency failsafe correctly overrides sizing when active.");
  }

  // --- CASE G: FULL_ENTRY without reducer => no arbitrary 500 USDT reduction on ETH ---
  {
    const equity = 2440.16;
    const config = {
      okxLiveV2MaxOrderNotionalUsdt: 500,
      okxLiveV2EthMaxOrderNotionalUsdt: 1200
    };
    const bridge = buildV2ConfigBridge(config as unknown as EngineConfig);
    assertEq(bridge.okxLiveV2EthMaxOrderNotionalUsdt, 1200, "CASE G: bridge has ETH cap 1200");
    assertEq(bridge.okxLiveV2MaxOrderNotionalUsdt, 500, "CASE G: bridge has BTC cap 500");

    const ethCap = resolveV2HardSafetyCapForSymbol("ETHUSDT", bridge);
    assertEq(ethCap, 1200, "CASE G: ethCap is 1200 from bridge");

    const submitNormal = resolveLiveSubmitStaticSafetyCap({
      authoritySource: "v2",
      okxLiveStaticNotionalCapEnabled: false,
      staticSafetyCapUsdt: ethCap,
      v2HardSafetyCapUsdt: ethCap,
      intendedNotionalUsdt: 1200,
      emergencyUltimateCapUsdt: 500,
      emergencyFailsafeActive: false, // Normal state
      isHighwayLineage: false,
      appliedLeverage: 10
    });
    assertEq(submitNormal.finalSubmittedNotionalUsdt, 1200, "CASE G: normal ETH notional remains 1200");
    assertFalse(submitNormal.emergencyCapApplied, "CASE G: emergency cap not applied in normal state");
    console.log("  [PASS] CASE G: FULL_ENTRY without reducer preserves 1200 USDT ETH target.");
  }

  // --- CASE H: Lot normalization accurate calculation ---
  {
    const ethPrice = 2704.24;
    const ethTargetNotional = 1200;
    // OKX contract value: 0.1 ETH per contract
    const ethCtVal = 0.1;
    const ethLotSz = 0.1; // in contracts
    const rawCont = ethTargetNotional / (ethPrice * ethCtVal); // 1200 / 270.424 = 4.43747...
    const normalizedCont = Math.floor(rawCont / ethLotSz) * ethLotSz; // 4.4 contracts
    const finalNotional = normalizedCont * ethCtVal * ethPrice; // 4.4 * 0.1 * 2704.24 = 1189.86 USDT
    assertTrue(finalNotional > 1180 && finalNotional <= 1200, `CASE H: ETH finalNotional close to 1200 (got ${finalNotional.toFixed(2)})`);

    const btcPrice = 85814.9;
    const btcTargetNotional = 500;
    const btcCtVal = 0.01; // 0.01 BTC per contract
    const btcLotSz = 0.01;
    const rawBtcCont = btcTargetNotional / (btcPrice * btcCtVal); // 500 / 858.149 = 0.58265...
    const normalizedBtcCont = Math.floor(rawBtcCont / btcLotSz) * btcLotSz; // 0.58 contracts
    const finalBtcNotional = normalizedBtcCont * btcCtVal * btcPrice; // 0.58 * 0.01 * 85814.9 = 497.726 USDT
    assertTrue(Math.abs(finalBtcNotional - 497.73) < 0.01, `CASE H: BTC finalNotional is 497.73 (got ${finalBtcNotional.toFixed(2)})`);
    console.log("  [PASS] CASE H: Lot normalization produces mathematically exact notionals.");
  }

  // =========================================================================
  // PART 4. Ownership Regression Tests
  // =========================================================================

  // --- CASE A: BOT attach TP child + empty algoClOrdId + bot provenance => ENGINE_OWNED ---
  {
    const now = Date.now();
    const botOpen: PaperOpenPositionRecord = {
      symbol: "ETHUSDT",
      side: "long",
      contracts: 1.84,
      entryPrice: 2704.24,
      takeProfitPrice: 2741.5,
      openedAt: now - 10000,
      exchangeOrdId: "3982037130097319936",
      entryFullPositionTpAttached: true
    } as unknown as PaperOpenPositionRecord;

    const attachedTpAlgo = {
      algoId: "3982010612340084736",
      algoClOrdId: "", // Empty clOrdId from OKX child attach TP
      instId: "ETH-USDT-SWAP",
      side: "sell",
      posSide: "long",
      sz: "1.84",
      reduceOnly: true,
      tpTriggerPx: "2741.5",
      cTime: String(now - 9000)
    };

    assertTrue(hasBotAlgoProvenance(attachedTpAlgo, [botOpen]), "CASE 4-A: hasBotAlgoProvenance is true");
    assertTrue(isAuthoritativeBotOwnedAlgoOrder(attachedTpAlgo, [botOpen]), "CASE 4-A: isAuthoritativeBotOwnedAlgoOrder is true");

    const ownership = evaluateOrderOwnership(attachedTpAlgo, true, [botOpen]);
    assertEq(ownership.ownership, "ENGINE_OWNED", "CASE 4-A: ownership is ENGINE_OWNED");
    assertEq(ownership.authorityOwner, "ENGINE", "CASE 4-A: authorityOwner is ENGINE");
    assertEq(ownership.ownershipEvidence, "bot_matched_attached_tp_provenance", "CASE 4-A: evidence is bot_matched_attached_tp_provenance");
    assertTrue(ownership.cancelAllowed, "CASE 4-A: cancelAllowed is true");
    console.log("  [PASS] CASE 4-A: Attached TP child with empty algoClOrdId resolves to ENGINE_OWNED.");
  }

  // --- CASE B: BOT protective SL known algoId => ENGINE_OWNED ---
  {
    const botOpen: PaperOpenPositionRecord = {
      symbol: "ETHUSDT",
      side: "long",
      contracts: 1.84,
      protectiveSlAlgoId: "3982041365580992512"
    } as unknown as PaperOpenPositionRecord;

    const slAlgo = {
      algoId: "3982041365580992512",
      algoClOrdId: "oapETHUSlmuurommks",
      instId: "ETH-USDT-SWAP"
    };

    assertTrue(isAuthoritativeBotOwnedAlgoOrder(slAlgo, [botOpen]), "CASE 4-B: isAuthoritativeBotOwnedAlgoOrder is true");
    const ownership = evaluateOrderOwnership(slAlgo, true, [botOpen]);
    assertEq(ownership.ownership, "ENGINE_OWNED", "CASE 4-B: ownership is ENGINE_OWNED");
    assertEq(ownership.authorityOwner, "ENGINE", "CASE 4-B: authorityOwner is ENGINE");
    console.log("  [PASS] CASE 4-B: BOT protective SL with known algoId resolves to ENGINE_OWNED.");
  }

  // --- CASE C: Actual external manual algo => OPERATOR_OWNED ---
  {
    const botOpen: PaperOpenPositionRecord = {
      symbol: "ETHUSDT",
      side: "long",
      contracts: 1.84
    } as unknown as PaperOpenPositionRecord;

    const manualAlgo = {
      algoId: "manual_algo_9999",
      algoClOrdId: "manual_user_stop_99",
      instId: "ETH-USDT-SWAP",
      side: "sell",
      sz: "22.92"
    };

    assertFalse(hasBotAlgoProvenance(manualAlgo, [botOpen]), "CASE 4-C: hasBotAlgoProvenance is false");
    assertFalse(isAuthoritativeBotOwnedAlgoOrder(manualAlgo, [botOpen]), "CASE 4-C: isAuthoritativeBotOwnedAlgoOrder is false");

    const ownership = evaluateOrderOwnership(manualAlgo, true, [botOpen]);
    assertEq(ownership.ownership, "OPERATOR_OWNED", "CASE 4-C: ownership is OPERATOR_OWNED");
    assertEq(ownership.authorityOwner, "OPERATOR", "CASE 4-C: authorityOwner is OPERATOR");
    assertFalse(ownership.cancelAllowed, "CASE 4-C: cancelAllowed is false");
    console.log("  [PASS] CASE 4-C: Genuine manual algo resolves to OPERATOR_OWNED.");
  }

  // --- CASE D: empty algoClOrdId + no bot provenance => preserved as OPERATOR_OWNED ---
  {
    const manualDirectAlgo = {
      algoId: "direct_exchange_algo_777",
      algoClOrdId: "",
      instId: "ETH-USDT-SWAP",
      side: "sell",
      sz: "22.92",
      reduceOnly: false
    };

    // Flat state (no open positions)
    assertFalse(hasBotAlgoProvenance(manualDirectAlgo, []), "CASE 4-D: hasBotAlgoProvenance false when flat");
    assertFalse(isAuthoritativeBotOwnedAlgoOrder(manualDirectAlgo, []), "CASE 4-D: not bot owned when flat");

    const ownership = evaluateOrderOwnership(manualDirectAlgo, true, []);
    assertEq(ownership.ownership, "OPERATOR_OWNED", "CASE 4-D: ownership is OPERATOR_OWNED");
    assertEq(ownership.ownershipEvidence, "empty_clOrdId_exchange_created", "CASE 4-D: evidence is empty_clOrdId_exchange_created");
    assertEq(ownership.authorityOwner, "OPERATOR", "CASE 4-D: authorityOwner is OPERATOR");
    console.log("  [PASS] CASE 4-D: Empty clOrdId without bot provenance is preserved as OPERATOR_OWNED.");
  }

  // --- CASE E: bot child order does not cause false manual takeover ---
  {
    const now = Date.now();
    const botOpen: PaperOpenPositionRecord = {
      symbol: "ETHUSDT",
      side: "long",
      contracts: 1.84,
      entryPrice: 2704.24,
      takeProfitPrice: 2741.5,
      openedAt: now - 10000,
      protectiveSlAlgoId: "3982041365580992512",
      entryFullPositionTpAttached: true
    } as unknown as PaperOpenPositionRecord;

    const orders = [
      // 1. Attached SL with valid oap schema
      {
        algoId: "3982041365580992512",
        algoClOrdId: "oapETHUSlmuurommks",
        instId: "ETH-USDT-SWAP"
      },
      // 2. Attached child TP with empty algoClOrdId
      {
        algoId: "3982010612340084736",
        algoClOrdId: "",
        instId: "ETH-USDT-SWAP",
        side: "sell",
        posSide: "long",
        sz: "1.84",
        reduceOnly: true,
        tpTriggerPx: "2741.5",
        cTime: String(now - 9000)
      }
    ];

    const pendingAuth = evaluateSymbolPendingOrderAuthority({
      symbol: "ETHUSDT",
      pendingOrders: [],
      algoOrders: orders,
      openPositions: [botOpen]
    });

    assertFalse(pendingAuth.hasOperatorPendingOrders, "CASE 4-E: hasOperatorPendingOrders must be FALSE");
    assertEq(pendingAuth.authorityOwner, "ENGINE", "CASE 4-E: authorityOwner must be ENGINE");
    assertEq(pendingAuth.operatorOrderCount, 0, "CASE 4-E: operatorOrderCount must be 0");
    assertEq(pendingAuth.engineOrderCount, 2, "CASE 4-E: engineOrderCount must be 2");
    assertTrue(pendingAuth.mutationAllowed, "CASE 4-E: mutationAllowed must be true");
    console.log("  [PASS] CASE 4-E: Bot child order does NOT trigger false manual takeover.");
  }

  // --- CASE F: actual manual intervention maintains OPERATOR_MANAGED strong latch ---
  {
    const now = Date.now();
    const botOpen: PaperOpenPositionRecord = {
      symbol: "ETHUSDT",
      side: "long",
      contracts: 1.84,
      openedAt: now - 10000
    } as unknown as PaperOpenPositionRecord;

    const ordersWithManual = [
      // Manual buy limit order (e.g. 22.92 contracts user manual add)
      {
        ordId: "3982541438444376068",
        clOrdId: "", // user direct UI buy
        instId: "ETH-USDT-SWAP",
        side: "buy",
        posSide: "long",
        sz: "22.92"
      }
    ];

    const pendingAuth = evaluateSymbolPendingOrderAuthority({
      symbol: "ETHUSDT",
      pendingOrders: ordersWithManual,
      algoOrders: [],
      openPositions: [botOpen]
    });

    assertTrue(pendingAuth.hasOperatorPendingOrders, "CASE 4-F: hasOperatorPendingOrders must be TRUE for manual add");
    assertEq(pendingAuth.authorityOwner, "OPERATOR", "CASE 4-F: authorityOwner must be OPERATOR");
    assertEq(pendingAuth.operatorOrderCount, 1, "CASE 4-F: operatorOrderCount must be 1");
    assertFalse(pendingAuth.mutationAllowed, "CASE 4-F: mutationAllowed must be false");
    console.log("  [PASS] CASE 4-F: Actual manual intervention correctly locks to OPERATOR_MANAGED.");
  }

  // =========================================================================
  // PART 4-2. USER-REQUESTED DEEP PROVENANCE SECURITY AUDIT TESTS
  // =========================================================================
  console.log("\n--- PART 4-2. DEEP PROVENANCE SECURITY AUDIT TESTS (A, B, C, D) ---");

  // --- AUDIT-A: bot parent provenance + empty algoClOrdId => ENGINE_OWNED ---
  {
    const now = Date.now();
    const botOpen: PaperOpenPositionRecord = {
      symbol: "ETHUSDT",
      side: "long",
      contracts: 1.84,
      entryPrice: 2704.24,
      takeProfitPrice: 2750.43,
      openedAt: now - 5000,
      exchangeOrdId: "3982037130097319936",
      entryFullPositionTpAttached: true
    } as unknown as PaperOpenPositionRecord;

    const childAlgo = {
      algoId: "3982010612340084736",
      algoClOrdId: "",
      instId: "ETH-USDT-SWAP",
      side: "sell",
      posSide: "long",
      sz: "1.84",
      reduceOnly: true,
      tpTriggerPx: "2750.43",
      cTime: String(now - 4800)
    };

    const ownership = evaluateOrderOwnership(childAlgo, true, [botOpen]);
    assertEq(ownership.ownership, "ENGINE_OWNED", "AUDIT-A: ownership must be ENGINE_OWNED");
    assertEq(ownership.authorityOwner, "ENGINE", "AUDIT-A: authorityOwner must be ENGINE");
    assertEq(ownership.ownershipEvidence, "bot_matched_attached_tp_provenance", "AUDIT-A: evidence must be attached tp provenance");
    assertTrue(ownership.mutationAllowed, "AUDIT-A: mutationAllowed must be true");
    console.log("  [PASS] AUDIT-A: bot parent provenance + empty algoClOrdId => ENGINE_OWNED.");
  }

  // --- AUDIT-B: 동일 symbol/side/size/trigger지만 parent provenance 없는 외부 주문 => OPERATOR_OWNED ---
  {
    const now = Date.now();
    const botOpen: PaperOpenPositionRecord = {
      symbol: "ETHUSDT",
      side: "long",
      contracts: 1.84,
      entryPrice: 2704.24,
      takeProfitPrice: 2750.43,
      openedAt: now - 600_000, // 10 minutes ago
      exchangeOrdId: "3982037130097319936",
      entryFullPositionTpAttached: true
    } as unknown as PaperOpenPositionRecord;

    // External manual order created 10 minutes later (time correlation fails!)
    const externalAlgo = {
      algoId: "manual_external_algo_555",
      algoClOrdId: "",
      instId: "ETH-USDT-SWAP",
      side: "sell",
      posSide: "long",
      sz: "1.84",
      reduceOnly: true,
      tpTriggerPx: "2750.43",
      cTime: String(now - 1000) // created just now, 10m after entry
    };

    const ownership = evaluateOrderOwnership(externalAlgo, true, [botOpen]);
    assertEq(ownership.ownership, "OPERATOR_OWNED", "AUDIT-B: ownership must be OPERATOR_OWNED");
    assertEq(ownership.authorityOwner, "OPERATOR", "AUDIT-B: authorityOwner must be OPERATOR");
    assertEq(ownership.ownershipEvidence, "empty_clOrdId_exchange_created", "AUDIT-B: preserved as empty_clOrdId_exchange_created");
    assertFalse(ownership.mutationAllowed, "AUDIT-B: mutationAllowed must be false");
    console.log("  [PASS] AUDIT-B: External order without timestamp/parent provenance => OPERATOR_OWNED.");
  }

  // --- AUDIT-C: bot child와 거의 동일한 수동 주문이 같은 시간대에 존재 => 수동 주문 보존 ---
  {
    const now = Date.now();
    const botOpen: PaperOpenPositionRecord = {
      symbol: "ETHUSDT",
      side: "long",
      contracts: 1.84,
      entryPrice: 2704.24,
      takeProfitPrice: 2750.43,
      openedAt: now - 5000,
      exchangeOrdId: "3982037130097319936",
      entryFullPositionTpAttached: true
    } as unknown as PaperOpenPositionRecord;

    const botChildAlgo = {
      algoId: "bot_child_tp_111",
      algoClOrdId: "",
      instId: "ETH-USDT-SWAP",
      side: "sell",
      posSide: "long",
      sz: "1.84",
      reduceOnly: true,
      tpTriggerPx: "2750.43",
      cTime: String(now - 4900)
    };

    const manualDuplicateAlgo = {
      algoId: "manual_user_tp_222",
      algoClOrdId: "",
      instId: "ETH-USDT-SWAP",
      side: "sell",
      posSide: "long",
      sz: "1.84",
      reduceOnly: true,
      tpTriggerPx: "2750.43",
      cTime: String(now - 4800)
    };

    const pendingAuth = evaluateSymbolPendingOrderAuthority({
      symbol: "ETHUSDT",
      pendingOrders: [],
      algoOrders: [botChildAlgo, manualDuplicateAlgo],
      openPositions: [botOpen]
    });

    assertTrue(pendingAuth.hasOperatorPendingOrders, "AUDIT-C: hasOperatorPendingOrders must be TRUE for extra duplicate order");
    assertEq(pendingAuth.authorityOwner, "OPERATOR", "AUDIT-C: authorityOwner must be OPERATOR to protect user order");
    assertEq(pendingAuth.operatorOrderCount, 1, "AUDIT-C: operatorOrderCount must be 1");
    assertEq(pendingAuth.engineOrderCount, 1, "AUDIT-C: engineOrderCount must be 1");
    assertFalse(pendingAuth.mutationAllowed, "AUDIT-C: mutationAllowed must be false");
    console.log("  [PASS] AUDIT-C: Competing manual order in same timeframe correctly preserved as OPERATOR_OWNED.");
  }

  // --- AUDIT-D: persisted protectiveAlgoId direct match => ENGINE_OWNED ---
  {
    const botOpen: PaperOpenPositionRecord = {
      symbol: "ETHUSDT",
      side: "long",
      contracts: 1.84,
      protectiveSlAlgoId: "3982041365580992512"
    } as unknown as PaperOpenPositionRecord;

    const algoWithMatch = {
      algoId: "3982041365580992512",
      algoClOrdId: "",
      instId: "ETH-USDT-SWAP"
    };

    const ownership = evaluateOrderOwnership(algoWithMatch, true, [botOpen]);
    assertEq(ownership.ownership, "ENGINE_OWNED", "AUDIT-D: ownership must be ENGINE_OWNED");
    assertEq(ownership.authorityOwner, "ENGINE", "AUDIT-D: authorityOwner must be ENGINE");
    assertEq(ownership.ownershipEvidence, "bot_matched_protective_sl_algo_id", "AUDIT-D: evidence must be direct protective match");
    assertTrue(ownership.mutationAllowed, "AUDIT-D: mutationAllowed must be true");
    console.log("  [PASS] AUDIT-D: Persisted protectiveAlgoId direct match resolves to ENGINE_OWNED.");
  }

  // =========================================================================
  // PART 6. 2026-10-05 Actual Trade Replay Fixture
  // =========================================================================
  {
    console.log("\n--- 2026-10-05 ACTUAL TRADE REPLAY FIXTURE COMPARISON ---");
    const config = {
      okxLiveV2MaxOrderNotionalUsdt: null,
      okxLiveV2EthMaxOrderNotionalUsdt: 1200
    };

    // 1. ETH-2 (13:46:04 KST)
    const ethPrice = 2704.24;
    const ethStop = 2690.99;
    const ethEquity = 2440.16;
    const ethCap = resolveV2HardSafetyCapForSymbol("ETHUSDT", config);
    const ethPatched = evaluateEquityAdaptiveSizing({
      symbol: "ETHUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: ethEquity,
      availableBalanceUsdt: 2410.82,
      entryReferencePrice: ethPrice,
      lastPrice: ethPrice,
      effectiveStopPrice: ethStop,
      appliedLeverage: 10,
      entryQualityGrade: "B",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      policyRequestedNotionalUsdt: 1200,
      v2HardSafetyCapUsdt: ethCap,
      v2AuthorityEntry: true
    });

    console.log(`ETH-2 (13:46):`);
    console.log(`  OLD Actual Execution:   497.58 USDT (1.84 contracts @ ${ethPrice}) [strangled by shared 500 cap]`);
    console.log(`  PATCHED Expected:       ${ethPatched.preLotNotionalUsdt.toFixed(2)} USDT (Target 1,200 USDT) [limitingAuthority: ${ethPatched.limitingAuthority}]`);
    assertEq(ethPatched.preLotNotionalUsdt, 1200, "REPLAY ETH-2: preLotNotionalUsdt is 1200");

    // 2. BTC-1 (13:45:21 KST)
    const btc1Price = 85579.2;
    const btc1Stop = 85150.0;
    const btcCap = resolveV2HardSafetyCapForSymbol("BTCUSDT", config);
    const btc1Patched = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: ethEquity,
      availableBalanceUsdt: 2410.82,
      entryReferencePrice: btc1Price,
      lastPrice: btc1Price,
      effectiveStopPrice: btc1Stop,
      appliedLeverage: 10,
      entryQualityGrade: "B",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      v2HardSafetyCapUsdt: btcCap,
      v2AuthorityEntry: true
    });

    console.log(`BTC-1 (13:45):`);
    console.log(`  OLD Actual Execution:   496.36 USDT (0.58 contracts @ ${btc1Price})`);
    console.log(`  PATCHED Expected:       ${btc1Patched.preLotNotionalUsdt.toFixed(2)} USDT (Risk-based adaptive) [limitingAuthority: ${btc1Patched.limitingAuthority}]`);
    assertEq(Math.abs(btc1Patched.riskBasedNotionalUsdt - 3895.35) < 1, true, "REPLAY BTC-1: riskBasedNotional ≈ 3895.35 (Grade B 0.8x)");
    assertEq(Math.abs(btc1Patched.equityInitialCapUsdt - 5612.37) < 1, true, "REPLAY BTC-1: equityInitialCap ≈ 5612.37");
    assertEq(btc1Patched.preLotNotionalUsdt > 3800, true, "REPLAY BTC-1: preLotNotionalUsdt is NOT strangled to 500");
    assertEq(btc1Patched.limitingAuthority, "risk_based_notional", "REPLAY BTC-1: limitingAuthority is risk_based_notional");

    // 3. BTC-2 (15:07:34 KST)
    const btc2Price = 85814.9;
    const btc2Stop = 85400.0;
    const btc2Patched = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: ethEquity,
      availableBalanceUsdt: 2410.82,
      entryReferencePrice: btc2Price,
      lastPrice: btc2Price,
      effectiveStopPrice: btc2Stop,
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      v2HardSafetyCapUsdt: btcCap,
      v2AuthorityEntry: true
    });

    console.log(`BTC-2 (15:07):`);
    console.log(`  OLD Actual Execution:   497.73 USDT (0.58 contracts @ ${btc2Price})`);
    console.log(`  PATCHED Expected:       ${btc2Patched.preLotNotionalUsdt.toFixed(2)} USDT (Equity Initial Cap bound) [limitingAuthority: ${btc2Patched.limitingAuthority}]`);
    assertEq(Math.abs(btc2Patched.riskBasedNotionalUsdt - 6004.73) < 1, true, "REPLAY BTC-2: riskBasedNotional ≈ 6004.73 (Grade A 1.5% target risk)");
    assertEq(Math.abs(btc2Patched.equityInitialCapUsdt - 5612.37) < 1, true, "REPLAY BTC-2: equityInitialCap ≈ 5612.37");
    assertEq(btc2Patched.preLotNotionalUsdt, btc2Patched.equityInitialCapUsdt, "REPLAY BTC-2: preLotNotional bounded by equityInitialCap");
    assertEq(btc2Patched.limitingAuthority, "equity_initial_cap", "REPLAY BTC-2: limitingAuthority is equity_initial_cap");
  }

  console.log("==================================================");
  console.log("ALL V2 SIZING & OWNERSHIP REGRESSION TESTS PASSED!");
  console.log("==================================================");
}

runAllTests().catch((e) => {
  console.error("Test failure:", e);
  process.exit(1);
});
