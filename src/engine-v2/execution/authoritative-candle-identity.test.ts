import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveV2AuthoritativeCandleIdentity } from "./authoritative-candle-identity.js";
import { resolveAuthoritativeCandleTs } from "../../engine/paper-engine.js";

describe("V2 AUTHORITATIVE CANDLE IDENTITY", () => {
  it("forming-bar ts = candles[last]; closed-candle ts = last closed bar", () => {
    const candles = [
      { ts: 1788600000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
      { ts: 1788600900000, open: 1.5, high: 2.5, low: 1, close: 2, volume: 120 },
      { ts: 1788601800000, open: 2, high: 2.2, low: 1.8, close: 2.1, volume: 80, forming: true } as any
    ];
    const identity = resolveV2AuthoritativeCandleIdentity(candles);
    assert.equal(identity.authoritativeCandleTs, 1788601800000, "forming-bar tip must be last candle ts");
    assert.equal(identity.closedCandleTs, 1788600900000, "closed-candle ts must be last closed bar before forming tip");
  });

  it("execution layer reads authority.authoritativeCandleTs only — no candle-array fallback", () => {
    const fromAuthority = resolveAuthoritativeCandleTs({
      authority: { authoritativeCandleTs: 1788601800000 }
    });
    assert.equal(fromAuthority, 1788601800000);

    const noFallback = resolveAuthoritativeCandleTs({
      authority: null
    });
    assert.equal(noFallback, null, "Must not reconstruct from candles when authority is absent");
  });
});
