import { adaptV2Input } from "../engine-v2/index";

function assertTrue(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
}

const bridgeState = {
  currentPositions: [],
  globalRiskScore: 0.5,
  lossStreaks: {},
  directionalShockState: "NONE" as const,
  longAllow: true,
  shortAllow: true,
  executionReadiness: true,
  freshTickBarrierActive: false,
  freshTickCompletedCycles: 0,
  freshTickRequiredCycles: 0,
  okxAuthMode: "live" as const,
  okxAuthReady: true,
  okxExchangeAuthOptIn: true,
  okxLiveEnabled: true,
  okxDemoEnabled: false,
  okxApiKeyPresent: true,
  okxApiSecretPresent: true,
  okxPassphrasePresent: true,
  okxSimulatedTradingHeaderEnabled: false
};

const snapshot = {
  lastPrice: 100_000,
  latestCandleClose: 100_000,
  boxHigh: 101_000,
  boxLow: 99_000,
  boxPosDiag: 0.5,
  rangeConfidenceDiag: 0.6,
  ema20: 99_500,
  emaGapDiag: 0.002,
  volatilityProxyDiag: 0.01
};

const config = {
  paperMaxOpenPositions: 2,
  paperReentryCooldownMs: 60_000,
  baseSizeUsd: 40,
  okxLiveMaxOrderNotionalUsdt: null
};

const v1Result = {
  decision: {
    regime_state: "TREND",
    final_decision: "SKIP",
    reject_reason: null
  },
  intentSide: "none" as const
};

const adapted = adaptV2Input(
  "BTCUSDT",
  Date.now(),
  snapshot,
  config,
  bridgeState,
  v1Result
);

assertTrue(adapted.state.okxAuthReady === true, "okxAuthReady preserved");
assertTrue(adapted.state.okxApiKeyPresent === true, "okxApiKeyPresent preserved");
assertTrue(adapted.state.okxApiSecretPresent === true, "okxApiSecretPresent preserved");
assertTrue(adapted.state.okxPassphrasePresent === true, "okxPassphrasePresent preserved");
assertTrue(adapted.state.okxAuthMode === "live", "okxAuthMode preserved");
assertTrue(adapted.state.okxExchangeAuthOptIn === true, "okxExchangeAuthOptIn preserved");
assertTrue(adapted.state.okxLiveEnabled === true, "okxLiveEnabled preserved");
assertTrue(adapted.state.okxDemoEnabled === false, "okxDemoEnabled preserved");
assertTrue(
  adapted.state.okxSimulatedTradingHeaderEnabled === false,
  "okxSimulatedTradingHeaderEnabled preserved"
);

console.info(JSON.stringify({
  event: "V2_OKX_AUTH_BRIDGE_CASES_PASS",
  okx_auth_ready: adapted.state.okxAuthReady,
  okx_api_key_present: adapted.state.okxApiKeyPresent,
  okx_api_secret_present: adapted.state.okxApiSecretPresent,
  okx_passphrase_present: adapted.state.okxPassphrasePresent
}));
