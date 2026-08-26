import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RISK_PER_TRADE_PCT,
  MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE,
  MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
  MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE,
  evaluateEquityAdaptiveSizing
} from "../engine-v2/risk-sizing/equity-adaptive-sizing";
import { resolveLiveSubmitStaticSafetyCap } from "./paper-engine";

function assertTrue(value: boolean, label: string): void {
  if (!value) throw new Error(`${label}: expected true`);
}

function assertIncludes(source: string, needle: string, label: string): void {
  if (!source.includes(needle)) {
    throw new Error(`${label}: expected source to include ${needle}`);
  }
}

function runCases(): void {
  const paperEngine = readFileSync(join(__dirname, "../../src/engine/paper-engine.ts"), "utf8");
  const indexTs = readFileSync(join(__dirname, "../../src/engine-v2/index.ts"), "utf8");

  assertIncludes(paperEngine, "RISK_PER_TRADE_PCT", "paper-engine imports risk pct");
  assertIncludes(paperEngine, "MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE", "paper-engine imports initial cap");
  assertTrue(!paperEngine.includes("risk_per_trade_pct: 0.005,"), "ENGINE_24H hardcoded risk removed");
  assertTrue(!paperEngine.includes("* 0.8 : null,\n      symbol_cap_usdt"), "ENGINE_24H hardcoded initial cap removed");

  assertIncludes(paperEngine, "skipStaticCapForV2Authority", "v2 static cap skip");
  assertIncludes(paperEngine, 'order_size_authority: input.authoritySource === "v2" ? "risk.finalOrderNotionalUsdt"', "submit proof authority");

  assertIncludes(indexTs, "legacy_max_order_notional_usdt", "index legacy order cap field");
  assertIncludes(indexTs, 'order_size_authority: "risk.finalOrderNotionalUsdt"', "index proof authority");
  assertIncludes(indexTs, "equity_adaptive_symbol_cap_usdt", "index equity adaptive cap proof");
  assertTrue(!indexTs.includes("\n            max_order_notional_usdt: maxOrderNotionalUsdt,"), "legacy max_order_notional renamed in proofs");

  assertTrue(RISK_PER_TRADE_PCT === 0.01, "risk pct constant");
  assertTrue(MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE === 2.0, "initial cap constant");
  assertTrue(MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE === 2.5, "symbol cap constant");
  assertTrue(MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE === 3.0, "account cap constant");

  // CASE — V2 submit applies effective static cap (legacy hard ceiling) even for v2 authority
  {
    const v2Sized = evaluateEquityAdaptiveSizing({
      symbol: "BTCUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: 600,
      availableBalanceUsdt: 600,
      entryReferencePrice: 100_000,
      effectiveStopPrice: 99_500,
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      emergencyAbsoluteCapUsdt: 500,
      legacyStaticCapUsdt: 40,
      roundTripFeeRate: 0,
      lastPrice: 100_000
    });
    assertTrue(v2Sized.finalOrderNotionalUsdt <= 40, "v2 equity path clamps to min(500,40)=40");
    assertTrue(v2Sized.effectiveLiveCapUsdt === 40, "effective live cap is legacy when lower");
    const v2Submit = resolveLiveSubmitStaticSafetyCap({
      authoritySource: "v2",
      okxLiveStaticNotionalCapEnabled: true,
      staticSafetyCapUsdt: 40,
      intendedNotionalUsdt: 356
    });
    assertTrue(!v2Submit.skipStaticCapForV2Authority, "v2 authority no longer skips static cap");
    assertTrue(v2Submit.finalSubmittedNotionalUsdt === 40, "v2 submit last-mile clamps to 40");
    assertTrue(v2Submit.finalSizeSource === "static_safety_cap", "v2 submit static cap source");
  }

  // CASE — non-V2 / legacy submit path still applies OKX_LIVE_MAX_ORDER_NOTIONAL_USDT static clamp
  {
    assertIncludes(
      paperEngine,
      "resolveLiveSubmitStaticSafetyCap",
      "paper-engine exports static safety cap resolver"
    );
    assertIncludes(
      paperEngine,
      "resolveEffectiveLiveOrderNotionalCap",
      "paper-engine uses effective live cap resolution"
    );
    const legacySubmit = resolveLiveSubmitStaticSafetyCap({
      authoritySource: "legacy",
      okxLiveStaticNotionalCapEnabled: true,
      staticSafetyCapUsdt: 40,
      intendedNotionalUsdt: 128
    });
    assertTrue(!legacySubmit.skipStaticCapForV2Authority, "non-v2 authority does not skip static cap");
    assertTrue(legacySubmit.finalSizeSource === "static_safety_cap", "non-v2 static cap applied");
    assertTrue(legacySubmit.finalSubmittedNotionalUsdt === 40, "non-v2 clamp to static cap");
    const v1Submit = resolveLiveSubmitStaticSafetyCap({
      authoritySource: null,
      okxLiveStaticNotionalCapEnabled: true,
      staticSafetyCapUsdt: 40,
      intendedNotionalUsdt: 30
    });
    assertTrue(v1Submit.finalSubmittedNotionalUsdt === 30, "non-v2 below cap unchanged");
  }

  console.info(JSON.stringify({
    event: "RUNTIME_SIZING_DISPLAY_CASES_PASS",
    cases: [
      "engine_24h_constants",
      "v2_static_cap_applied_on_submit",
      "live_order_size_proof_legacy_fields",
      "v2_effective_cap_clamp_on_submit",
      "v1_non_v2_static_cap_regression"
    ]
  }));
}

runCases();
