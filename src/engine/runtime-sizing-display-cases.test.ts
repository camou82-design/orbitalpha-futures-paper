import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RISK_PER_TRADE_PCT,
  MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE,
  MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE,
  MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE,
  evaluateEquityAdaptiveSizing,
  resolveUltimateSafetyCapForOrderSizing
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
  assertIncludes(indexTs, "v2AuthorityEntry: true", "index passes v2 authority entry sizing flag");
  assertTrue(!indexTs.includes("\n            max_order_notional_usdt: maxOrderNotionalUsdt,"), "legacy max_order_notional renamed in proofs");

  assertTrue(RISK_PER_TRADE_PCT === 0.01, "risk pct constant");
  assertTrue(MAX_INITIAL_NOTIONAL_EQUITY_MULTIPLE === 2.0, "initial cap constant");
  assertTrue(MAX_SYMBOL_NOTIONAL_EQUITY_MULTIPLE === 2.5, "symbol cap constant");
  assertTrue(MAX_ACCOUNT_NOTIONAL_EQUITY_MULTIPLE === 3.0, "account cap constant");

  // CASE W — V2 authority entry is NOT truncated by legacy 40 USDT cap
  {
    const v2Sized = evaluateEquityAdaptiveSizing({
      symbol: "ETHUSDT",
      side: "long",
      orderKind: "ENTRY",
      accountEquityUsdt: 800,
      availableBalanceUsdt: 800,
      entryReferencePrice: 3_500,
      effectiveStopPrice: 3_450,
      appliedLeverage: 10,
      entryQualityGrade: "A",
      existingSymbolNotionalUsdt: 0,
      existingAccountNotionalUsdt: 0,
      emergencyAbsoluteCapUsdt: 500,
      legacyStaticCapUsdt: 40,
      v2AuthorityEntry: true,
      roundTripFeeRate: 0,
      lastPrice: 3_500,
      instrumentSizing: { lotSz: 0.01, minSz: 0.01, ctVal: 0.1, ctValCcy: "ETH" }
    });
    assertTrue(v2Sized.sizingPassed, "v2 grade-A sizing passes");
    assertTrue(v2Sized.effectiveLiveCapUsdt === 500, "v2 ultimate cap is emergency only");
    assertTrue(v2Sized.finalOrderNotionalUsdt > 40, "v2 final notional exceeds legacy 40");
    const v2Submit = resolveLiveSubmitStaticSafetyCap({
      authoritySource: "v2",
      okxLiveStaticNotionalCapEnabled: true,
      staticSafetyCapUsdt: null,
      intendedNotionalUsdt: v2Sized.finalOrderNotionalUsdt,
      emergencyUltimateCapUsdt: 500
    });
    assertTrue(v2Submit.skipStaticCapForV2Authority, "v2 authority skips legacy static cap");
    assertTrue(v2Submit.finalSubmittedNotionalUsdt === v2Sized.finalOrderNotionalUsdt, "v2 submit preserves risk sizing");
    assertTrue(v2Submit.finalSizeSource === "v2_risk", "v2 submit source is v2_risk");
  }

  // CASE X — non-V2 / legacy submit path still applies OKX_LIVE_MAX_ORDER_NOTIONAL_USDT static clamp
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
    const legacySized = evaluateEquityAdaptiveSizing({
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
    assertTrue(legacySized.finalOrderNotionalUsdt <= 40, "non-v2 equity path clamps to min(500,40)=40");
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
    const ultimate = resolveUltimateSafetyCapForOrderSizing({
      v2AuthorityEntry: false,
      emergencyCapUsdt: 500,
      legacyStaticCapUsdt: 40
    });
    assertTrue(ultimate.effectiveLiveCapUsdt === 40, "non-v2 ultimate resolves to legacy when lower");
  }

  console.info(JSON.stringify({
    event: "RUNTIME_SIZING_DISPLAY_CASES_PASS",
    cases: [
      "engine_24h_constants",
      "v2_not_truncated_by_legacy_40",
      "non_v2_legacy_40_cap_preserved",
      "live_order_size_proof_legacy_fields",
      "v1_non_v2_static_cap_regression"
    ]
  }));
}

runCases();
