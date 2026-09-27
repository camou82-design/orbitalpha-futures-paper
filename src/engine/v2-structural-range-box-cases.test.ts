import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../models/types";
import {
  MIN_BOX_HEIGHT_ATR_RATIO,
  buildStructuralBoxCandidate,
  computeLegacyMicroBoxBounds,
  resolveStructuralRangeBox,
  STRUCTURAL_BOX_LOOKBACKS
} from "./structural-range-box";
import { atrWilderLast } from "../strategy/entry-gate";

function makeCandle(ts: number, o: number, h: number, l: number, c: number): Candle {
  return { ts, open: o, high: h, low: l, close: c, volume: 1 };
}

/** Wide 120m range with a tight micro wiggle on the last ~30 bars (BTC-style noise box). */
function buildBtcMicroVsStructuralFixture(): Candle[] {
  const candles: Candle[] = [];
  let ts = 1_700_000_000_000;
  const structuralHigh = 84580;
  const structuralLow = 84180;
  /** 121 bars → 120 completed; last 30 completed are entirely inside micro tail. */
  for (let i = 0; i < 121; i++) {
    const inMicroTail = i >= 90;
    let high: number;
    let low: number;
    let close: number;
    if (inMicroTail) {
      const microIdx = i - 90;
      const pingPong = microIdx % 4;
      if (pingPong === 0 || pingPong === 2) {
        high = 84515.6;
        low = 84426.4;
        close = pingPong === 0 ? 84480 : 84460;
      } else {
        high = 84510;
        low = 84430;
        close = pingPong === 1 ? 84500 : 84440;
      }
    } else {
      const phase = i % 6;
      if (phase === 0 || phase === 3) {
        high = structuralHigh;
        low = structuralHigh - 120;
        close = structuralHigh - 40;
      } else if (phase === 1 || phase === 4) {
        high = structuralLow + 130;
        low = structuralLow;
        close = structuralLow + 55;
      } else {
        high = (structuralHigh + structuralLow) / 2 + 90;
        low = (structuralHigh + structuralLow) / 2 - 90;
        close = (structuralHigh + structuralLow) / 2;
      }
    }
    const open = (high + low) / 2;
    candles.push(makeCandle(ts, open, high, low, close));
    ts += 60_000;
  }
  return candles;
}

describe("V2 structural RANGE box authority", () => {
  it("CASE A: legacy 30-bar min/max matches narrow ~89 USD micro box", () => {
    const all = buildBtcMicroVsStructuralFixture();
    const completed = all.slice(0, -1);
    const legacy = computeLegacyMicroBoxBounds(completed, 30);
    assert.ok(legacy.boxHeight !== null && legacy.boxHeight > 80 && legacy.boxHeight < 100);
    assert.ok(legacy.boxHigh !== null && legacy.boxHigh > 84500);
    assert.ok(legacy.boxLow !== null && legacy.boxLow < 84440);
  });

  it("CASE B: structural selection prefers wider 60/120 lookback over micro window", () => {
    const all = buildBtcMicroVsStructuralFixture();
    const completed = all.slice(0, -1);
    const lastPrice = all[all.length - 1]!.close;
    const atr = atrWilderLast(completed, 14);
    assert.ok(atr !== null && atr > 0);

    const resolved = resolveStructuralRangeBox({
      symbol: "BTCUSDT",
      completed1m: completed,
      lastPrice,
      atr,
      prevState: null,
      nowTs: Date.now()
    });

    assert.ok(resolved.microBoxHeight !== null && resolved.microBoxHeight < 100);
    assert.ok(resolved.boxHigh !== null && resolved.boxLow !== null);
    const structuralHeight = resolved.boxHigh! - resolved.boxLow!;
    assert.ok(structuralHeight > resolved.microBoxHeight! * 1.8);
    assert.ok(resolved.lookback !== null && resolved.lookback >= 60);
    assert.equal(resolved.selectedReason.startsWith("structural_candidate_lookback_"), true);
    assert.ok(resolved.upperTouchCount >= 2 && resolved.lowerTouchCount >= 2);
    assert.ok(
      resolved.boxHeightAtrRatio !== null &&
        resolved.boxHeightAtrRatio >= MIN_BOX_HEIGHT_ATR_RATIO
    );
  });

  it("CASE C: 30-lookback cluster candidate loses to longer lookback on score", () => {
    const all = buildBtcMicroVsStructuralFixture();
    const completed = all.slice(0, -1);
    const atr = atrWilderLast(completed, 14);
    const c30 = buildStructuralBoxCandidate(completed, 30, atr);
    const c120 = buildStructuralBoxCandidate(completed, 120, atr);
    assert.ok(c30 !== null && c120 !== null);
    assert.ok(c120.boxHeight > c30.boxHeight);
    assert.ok(c120.score > c30.score);
  });

  it("CASE D: MIN_BOX_HEIGHT_ATR_RATIO rejects ultra-narrow noise when touches exist only in micro tail", () => {
    const narrowOnly: Candle[] = [];
    let ts = 1_700_000_000_000;
    for (let i = 0; i < 40; i++) {
      narrowOnly.push(makeCandle(ts, 84470, 84515.6, 84426.4, 84470));
      ts += 60_000;
    }
    const completed = narrowOnly.slice(0, -1);
    const atr = atrWilderLast(completed, 14);
    const c = buildStructuralBoxCandidate(completed, 30, atr);
    assert.ok(c !== null);
    const height = c.boxHeight;
    const ratio = atr !== null && atr > 0 ? height / atr : 0;
    if (ratio < MIN_BOX_HEIGHT_ATR_RATIO) {
      assert.equal(c.widthValid, false);
      assert.equal(c.rejectedReason, "width_below_atr_floor");
    }
  });

  it("CASE E: hysteresis keeps prior box when a new micro candidate appears without breakout hold", () => {
    const all = buildBtcMicroVsStructuralFixture();
    const completed = all.slice(0, -1);
    const lastPrice = all[all.length - 1]!.close;
    const atr = atrWilderLast(completed, 14)!;

    const first = resolveStructuralRangeBox({
      symbol: "BTCUSDT",
      completed1m: completed,
      lastPrice,
      atr,
      prevState: null,
      nowTs: 1
    });
    assert.ok(first.nextState !== null && first.boxHigh !== null);

    const stalePrev = {
      boxHigh: first.boxHigh! + 250,
      boxLow: first.boxLow! - 250,
      lookback: 120,
      selectedReason: "synthetic_stale_wider_box",
      updatedAtTs: 1
    };

    const second = resolveStructuralRangeBox({
      symbol: "BTCUSDT",
      completed1m: completed,
      lastPrice,
      atr,
      prevState: stalePrev,
      nowTs: 2
    });
    assert.equal(second.hysteresisApplied, true);
    assert.equal(second.boxHigh, stalePrev.boxHigh);
    assert.equal(second.boxLow, stalePrev.boxLow);
    assert.equal(second.breakoutHold, false);
  });

  it("CASE G: before/after — legacy ~89 USD micro vs structural authority on same fixture", () => {
    const all = buildBtcMicroVsStructuralFixture();
    const completed = all.slice(0, -1);
    const lastPrice = 84470;
    const atr = atrWilderLast(completed, 14);
    const legacy = computeLegacyMicroBoxBounds(completed, 30);
    const resolved = resolveStructuralRangeBox({
      symbol: "BTCUSDT",
      completed1m: completed,
      lastPrice,
      atr,
      prevState: null,
      nowTs: 4
    });
    assert.ok(legacy.boxHeight !== null && legacy.boxHeight < 100);
    assert.ok(resolved.boxHigh !== null && resolved.boxLow !== null);
    const structuralHeight = resolved.boxHigh! - resolved.boxLow!;
    assert.ok(structuralHeight > legacy.boxHeight! * 2);
    assert.notDeepEqual(
      { high: legacy.boxHigh, low: legacy.boxLow },
      { high: resolved.boxHigh, low: resolved.boxLow }
    );
  });

  it("CASE F: all configured lookbacks are evaluated", () => {
    const all = buildBtcMicroVsStructuralFixture();
    const completed = all.slice(0, -1);
    const resolved = resolveStructuralRangeBox({
      symbol: "BTCUSDT",
      completed1m: completed,
      lastPrice: completed[completed.length - 1]!.close,
      atr: atrWilderLast(completed, 14),
      prevState: null,
      nowTs: 3
    });
    assert.equal(resolved.candidates.length, STRUCTURAL_BOX_LOOKBACKS.length);
  });
});
