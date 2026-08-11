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

  // CASE — V2 submit skips legacy static 40 cap but emergency 500 from sizing is preserved
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
      roundTripFeeRate: 0,
      lastPrice: 100_000
    });
    if (v2Sized.finalOrderNotionalUsdt > 500) {
      throw new Error(
        `v2 emergency sizing cap: expected <= 500, got ${v2Sized.finalOrderNotionalUsdt}`
      );
    }
    const v2Submit = resolveLiveSubmitStaticSafetyCap({
      authoritySource: "v2",
      okxLiveStaticNotionalCapEnabled: true,
      staticSafetyCapUsdt: 40,
      intendedNotionalUsdt: v2Sized.finalOrderNotionalUsdt
    });
    assertTrue(v2Submit.skipStaticCapForV2Authority, "v2 authority skips legacy static cap");
    assertTrue(
      v2Submit.finalSubmittedNotionalUsdt === v2Sized.finalOrderNotionalUsdt,
      "v2 submit must not re-clamp emergency-sized notional to legacy static 40"
    );
    assertTrue(v2Submit.finalSubmittedNotionalUsdt <= 500, "v2 submit preserves emergency 500 ceiling");
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
      "!skipStaticCapForV2Authority",
      "non-v2 static clamp guard preserved in source"
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
      "v2_static_cap_skip",
      "live_order_size_proof_legacy_fields",
      "v2_emergency_cap_preserved_on_submit",
      "v1_non_v2_static_cap_regression"
    ]
  }));
}

runCases();
