import test from "node:test";
import assert from "node:assert/strict";
import {
    resolveOpenMarginUsd,
    resolveOpenNotionalAuthority,
    resolveOpenNotionalUsd,
    resolveOpenPositionSizeUnit
} from "../engine-v2/live-account/position-size-authority";
function sumCurrentMarginUsed(positions: unknown[]): number {
    return positions.reduce<number>((acc, p) => acc + resolveOpenMarginUsd(p as any), 0);
}

test("manual BTC long: persisted notionalUsd does not flip sizeUsd to V2_NOTIONAL", () => {
    const manualBtcLong = {
        symbol: "BTCUSDT",
        side: "long",
        sizeUsd: 306.75,
        notionalUsd: 3067.53,
        leverage: 10,
        isV2Authority: false,
        strategyVersion: "1.0.0"
    };

    assert.equal(resolveOpenPositionSizeUnit(manualBtcLong as any), "LEGACY_MARGIN");
    assert.ok(Math.abs(resolveOpenMarginUsd(manualBtcLong as any) - 306.75) < 0.01);
    assert.ok(Math.abs(resolveOpenNotionalUsd(manualBtcLong as any) - 3067.53) < 0.01);

    const auth = resolveOpenNotionalAuthority(manualBtcLong as any);
    assert.equal(auth.source, "PERSISTED_NOTIONAL");
    assert.equal(auth.authoritative, true);
    assert.equal(auth.unit, "LEGACY_MARGIN");
    assert.ok(Math.abs((auth.valueUsd ?? 0) - 3067.53) < 0.01);

    const currentMarginUsed = sumCurrentMarginUsed([manualBtcLong]);
    assert.ok(Math.abs(currentMarginUsed - 306.75) < 0.01);
    assert.ok(Math.abs(currentMarginUsed - 306.75 / 10) > 1, "must not treat sizeUsd as notional margin");
});

test("canonical V2 row keeps V2_NOTIONAL size semantics", () => {
    const v2Row = {
        symbol: "ETHUSDT",
        side: "short",
        sizeUsd: 106.98,
        notionalUsd: 106.98,
        leverage: 10,
        isV2Authority: true
    };

    assert.equal(resolveOpenPositionSizeUnit(v2Row as any), "V2_NOTIONAL");
    assert.ok(Math.abs(resolveOpenMarginUsd(v2Row as any) - 10.698) < 0.001);
    const auth = resolveOpenNotionalAuthority(v2Row as any, 999);
    assert.equal(auth.source, "PERSISTED_NOTIONAL");
    assert.equal(auth.unit, "V2_NOTIONAL");
    assert.equal(auth.valueUsd, 106.98);
});

test("policy currentMarginUsed formula uses legacy margin (~306.75 not ~30.67)", () => {
    const manualBtcLong = {
        symbol: "BTCUSDT",
        side: "long",
        sizeUsd: 306.75,
        notionalUsd: 3067.53,
        leverage: 10,
        isV2Authority: false
    };

    const currentMarginUsed = sumCurrentMarginUsed([manualBtcLong]);
    const stageMarginKrw = 14_000;
    const maxUsableMarginKrw = 440_000;

    assert.ok(Math.abs(currentMarginUsed - 306.75) < 0.01);
    assert.equal(currentMarginUsed * 1400 + stageMarginKrw > maxUsableMarginKrw, true);
    assert.equal((currentMarginUsed / 10) * 1400 + stageMarginKrw > maxUsableMarginKrw, false);
});
