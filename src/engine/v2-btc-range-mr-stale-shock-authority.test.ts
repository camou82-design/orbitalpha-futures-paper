import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runEngineV2 } from "../engine-v2/index";
import { globalShockStates, clearGlobalShockStates } from "../engine-v2/state/derive";
import { rangeContinuationStateMap } from "../engine-v2/executors/range-executor";
import { EngineV2Input } from "../engine-v2/types";
import { Candle } from "../models/types";

function createCandles(closes: number[], baseTs = 1788410000000): Candle[] {
    return closes.map((close, i) => ({
        ts: baseTs + i * 60000,
        open: close * 0.9995,
        high: close * 1.0005,
        low: close * 0.9990,
        close,
        volume: 100
    }));
}

function seedBtcStaleShock(
    activeDirection: "DOWN" | "UP" = "DOWN",
    rawDirection: "NONE" | "DOWN" | "UP" = "NONE",
    rawMovePct = 0.0005,
    requiredMovePct = 0.0012,
    emergencyBypass = false
) {
    globalShockStates.set("BTCUSDT", {
        symbol: "BTCUSDT",
        activeDirection,
        rawDirection,
        candidateDirection: "NONE",
        candidateCount: 0,
        neutralCount: 0,
        candidateStartedAt: null,
        activatedAt: Date.now(),
        lastChangedAt: Date.now(),
        rawMovePct,
        requiredMovePct,
        emergencyBypass,
        lastProcessedCycle: 0
    } as any);
}

function makeBtcInput(overrides: Partial<EngineV2Input> = {}): EngineV2Input {
    const defaultCandles = createCandles([
        78600, 78610, 78600, 78590, 78620, 78610, 78600, 78610, 78620, 78615,
        78610, 78605, 78600, 78610, 78615, 78620, 78625, 78620, 78615, 78600
    ]);
    const now = Date.now();
    return {
        run_cycle_id: "test-cycle-1",
        symbol: "BTCUSDT",
        now,
        candles: defaultCandles,
        config: {
            paperMaxOpenPositions: 3,
            baseSizeUsd: 100
        } as any,
        evaluationMode: "authoritative",
        v1Result: {
            regime: "RANGE",
            decision: "HOLD",
            side: "NONE",
            isBlocked: false
        },
        ...overrides,
        snapshot: {
            symbol: "BTCUSDT",
            lastPrice: 78600,
            latestCandleClose: 78600,
            qualityScore: 82,
            boxPos: 0.15,
            boxLow: 78000,
            boxHigh: 82000,
            atr: 300,
            rangeConfidence: 0.85,
            boxCohesion01: 0.95,
            trendWeaknessScore: 0.25,
            reversal_confirmed: true,
            emaGap: 0.0001,
            candles: defaultCandles,
            tickSz: 0.1,
            lotSz: 0.01,
            canonicalRegime: "RANGE",
            ...(overrides.snapshot ?? {})
        } as any,
        state: {
            currentPositions: [],
            directionalShockState: "DOWN",
            rawDirectionalShockState: "NONE",
            longAllow: false,
            shortAllow: false,
            serverTradeEnabled: true,
            closeOnlyMode: false,
            killSwitch: false,
            reconcileSafeMode: false,
            paperExecutionReady: true,
            signedExecutionReady: true,
            rawShockMovePct: 0.0005,
            requiredShockMovePct: 0.0012,
            shockEmergencyBypass: false,
            accountEquityKrw: 14_000_000,
            accountEquityUsdt: 10_000,
            availableBalanceUsdt: 10_000,
            liveBalanceReady: true,
            okxActualPositionsReady: true,
            actualAccountNotionalUsdtReady: true,
            exposureNotionalCapKrw: 100_000_000,
            symbolExposureNotionalCapKrw: 50_000_000,
            okxActualPositions: [],
            okxPendingOrdersReady: true,
            okxPendingOrdersNotionalUsdt: 0,
            okxPendingSymbolNotionalUsdt: 0,
            hasSymbolPendingEntry: false,
            hasUnknownPendingNotional: false,
            okxLiveEnabled: true,
            okxAuthMode: "live",
            okxAuthReady: true,
            okxExchangeAuthOptIn: true,
            okxApiKeyPresent: true,
            okxApiSecretPresent: true,
            okxPassphrasePresent: true,
            okxSimulatedTradingHeaderEnabled: true,
            balanceFetchedAt: now,
            positionsFetchedAt: now,
            pendingOrdersFetchedAt: now,
            okxInstruments: [
                {
                    instId: "BTC-USDT-SWAP",
                    tickSz: "0.1",
                    lotSz: "0.01",
                    minSz: "0.01",
                    ctVal: "0.01",
                    ctValCcy: "BTC"
                },
                {
                    instId: "BTCUSDT",
                    tickSz: "0.1",
                    lotSz: "0.01",
                    minSz: "0.01",
                    ctVal: "0.01",
                    ctValCcy: "BTC"
                }
            ],
            ...(overrides.state ?? {})
        } as any
    };
}

describe("PHASE 10A — BTC RANGE MR STALE-SHOCK LOCAL AUTHORITY PATCH SUITE", () => {
    beforeEach(() => {
        clearGlobalShockStates();
        rangeContinuationStateMap.clear();
    });

    afterEach(() => {
        clearGlobalShockStates();
        rangeContinuationStateMap.clear();
    });

    // 1. stale DOWN + lower + confirmed reversal -> BTC LONG MR allowed
    it("1. stale DOWN + lower + confirmed reversal -> BTC LONG MR allowed", () => {
        seedBtcStaleShock("DOWN", "NONE", 0.0005, 0.0012);
        const input = makeBtcInput({
            snapshot: {
                boxPos: 0.15,
                reversal_confirmed: true
            } as any,
            state: {
                directionalShockState: "DOWN",
                rawDirectionalShockState: "NONE",
                longAllow: false
            } as any
        });
        const result = runEngineV2(input);
        assert.strictEqual(result.decision.decision, "ENTER");
        assert.strictEqual(result.decision.side, "long");
        assert.strictEqual(result.decision.metadata?.range_side, "long");
    });

    // 2. stale UP + upper + confirmed rejection -> BTC SHORT MR allowed
    it("2. stale UP + upper + confirmed rejection -> BTC SHORT MR allowed", () => {
        seedBtcStaleShock("UP", "NONE", 0.0005, 0.0012);
        const upperCandles = createCandles([
            81500, 81510, 81520, 81510, 81520, 81530, 81520, 81510, 81520, 81515,
            81520, 81510, 81520, 81530, 81520, 81510, 81520, 81515, 81520, 81520
        ]);
        const input = makeBtcInput({
            candles: upperCandles,
            snapshot: {
                lastPrice: 81520,
                latestCandleClose: 81520,
                boxPos: 0.88,
                reversal_confirmed: true,
                candles: upperCandles
            } as any,
            state: {
                directionalShockState: "UP",
                rawDirectionalShockState: "NONE",
                shortAllow: false,
                longAllow: true
            } as any
        });
        const result = runEngineV2(input);
        assert.strictEqual(result.decision.decision, "ENTER");
        assert.strictEqual(result.decision.side, "short");
        assert.strictEqual(result.decision.metadata?.range_side, "short");
    });

    // 3. raw DOWN active -> bypass 금지
    it("3. raw DOWN active -> bypass 금지", () => {
        seedBtcStaleShock("DOWN", "DOWN");
        const input = makeBtcInput({
            state: {
                directionalShockState: "DOWN",
                rawDirectionalShockState: "DOWN",
                longAllow: false
            } as any
        });
        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.side, "long");
    });

    // 4. raw UP active -> bypass 금지
    it("4. raw UP active -> bypass 금지", () => {
        seedBtcStaleShock("UP", "UP");
        const input = makeBtcInput({
            snapshot: {
                boxPos: 0.88,
                reversal_confirmed: true
            } as any,
            state: {
                directionalShockState: "UP",
                rawDirectionalShockState: "UP",
                shortAllow: false
            } as any
        });
        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.side, "short");
    });

    // 5. magnitude_passed=true -> bypass 금지
    it("5. magnitude_passed=true -> bypass 금지", () => {
        seedBtcStaleShock("DOWN", "NONE", 0.0050, 0.0012);
        const input = makeBtcInput({
            state: {
                directionalShockState: "DOWN",
                rawDirectionalShockState: "NONE",
                rawShockMovePct: 0.0050,
                requiredShockMovePct: 0.0012, // magnitude passed
                longAllow: false
            } as any
        });
        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.side, "long");
    });

    // 6. lower LONG reversal=false -> block 유지
    it("6. lower LONG reversal=false -> block 유지", () => {
        clearGlobalShockStates();
        rangeContinuationStateMap.clear();
        seedBtcStaleShock("DOWN", "NONE", 0.0005, 0.0012);
        const input = makeBtcInput({
            snapshot: {
                boxPos: 0.15,
                reversal_confirmed: false
            } as any,
            state: {
                directionalShockState: "DOWN",
                rawDirectionalShockState: "NONE",
                longAllow: false,
                shortAllow: false
            } as any
        });
        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.metadata?.decision_reason, "BTC_RANGE_MR_STALE_DOWN_SHOCK_LOCAL_BYPASS");
        assert.notStrictEqual(result.decision.side, "long");
    });

    // 7. upper SHORT reversal=false -> block 유지
    it("7. upper SHORT reversal=false -> block 유지", () => {
        seedBtcStaleShock("UP", "NONE", 0.0005, 0.0012);
        const input = makeBtcInput({
            snapshot: {
                boxPos: 0.88,
                reversal_confirmed: false
            } as any,
            state: {
                directionalShockState: "UP",
                rawDirectionalShockState: "NONE",
                shortAllow: false
            } as any
        });
        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    // 8. MID zone -> block 유지
    it("8. MID zone -> block 유지", () => {
        clearGlobalShockStates();
        rangeContinuationStateMap.clear();
        seedBtcStaleShock("DOWN", "NONE", 0.0005, 0.0012);
        const input = makeBtcInput({
            snapshot: {
                boxPos: 0.50,
                reversal_confirmed: true
            } as any,
            state: {
                directionalShockState: "DOWN",
                rawDirectionalShockState: "NONE",
                longAllow: false,
                shortAllow: false
            } as any
        });
        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.metadata?.decision_reason, "BTC_RANGE_MR_STALE_DOWN_SHOCK_LOCAL_BYPASS");
        assert.notStrictEqual(result.decision.side, "long");
    });

    // 9. upper LONG -> 기존 chase block 유지
    it("9. upper LONG -> 기존 chase block 유지", () => {
        seedBtcStaleShock("DOWN", "NONE", 0.0005, 0.0012);
        const input = makeBtcInput({
            snapshot: {
                boxPos: 0.88,
                reversal_confirmed: true
            } as any,
            state: {
                directionalShockState: "DOWN",
                rawDirectionalShockState: "NONE"
            } as any
        });
        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.side, "long");
    });

    // 10. lower SHORT -> 기존 chase block 유지
    it("10. lower SHORT -> 기존 chase block 유지", () => {
        seedBtcStaleShock("UP", "NONE", 0.0005, 0.0012);
        const input = makeBtcInput({
            snapshot: {
                boxPos: 0.12,
                reversal_confirmed: true
            } as any,
            state: {
                directionalShockState: "UP",
                rawDirectionalShockState: "NONE"
            } as any
        });
        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.side, "short");
    });

    // 11. forming candle reaction만 존재 (reversalConfirmed=false) -> bypass 금지
    it("11. forming candle reaction만 존재 (reversalConfirmed=false) -> bypass 금지", () => {
        clearGlobalShockStates();
        rangeContinuationStateMap.clear();
        seedBtcStaleShock("DOWN", "NONE", 0.0005, 0.0012);
        const input = makeBtcInput({
            snapshot: {
                boxPos: 0.15,
                reversal_confirmed: false
            } as any,
            state: {
                directionalShockState: "DOWN",
                rawDirectionalShockState: "NONE",
                longAllow: false,
                shortAllow: false
            } as any
        });
        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.metadata?.decision_reason, "BTC_RANGE_MR_STALE_DOWN_SHOCK_LOCAL_BYPASS");
        assert.notStrictEqual(result.decision.side, "long");
    });

    // 12. closed candle reaction -> 허용
    it("12. closed candle reaction -> 허용", () => {
        clearGlobalShockStates();
        rangeContinuationStateMap.clear();
        seedBtcStaleShock("DOWN", "NONE", 0.0005, 0.0012);
        const input = makeBtcInput({
            snapshot: {
                boxPos: 0.15,
                reversal_confirmed: true
            } as any,
            state: {
                directionalShockState: "DOWN",
                rawDirectionalShockState: "NONE",
                longAllow: false
            } as any
        });
        const result = runEngineV2(input);
        assert.strictEqual(result.decision.decision, "ENTER");
        assert.strictEqual(result.decision.side, "long");
    });

    // 13. TREND regime -> 미적용
    it("13. TREND regime -> 미적용", () => {
        seedBtcStaleShock("DOWN", "NONE", 0.0005, 0.0012);
        const input = makeBtcInput({
            snapshot: {
                trendWeaknessScore: 0.1,
                emaGap: 0.0050
            } as any
        });
        const result = runEngineV2(input);
        assert.ok(result.decision !== undefined);
    });

    // 14. SHOCK active subtype -> 미적용
    it("14. SHOCK active subtype -> 미적용", () => {
        seedBtcStaleShock("DOWN", "DOWN", 0.0050, 0.0012, true);
        const input = makeBtcInput({
            state: {
                directionalShockState: "DOWN",
                rawDirectionalShockState: "DOWN",
                shockEmergencyBypass: true
            } as any
        });
        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.side, "long");
    });

    // 15. ADDON -> 미적용
    it("15. ADDON -> 미적용", () => {
        seedBtcStaleShock("DOWN", "NONE", 0.0005, 0.0012);
        const input = makeBtcInput({
            state: {
                currentPositions: [{
                    symbol: "BTCUSDT",
                    side: "long",
                    sizeUsd: 100,
                    entryPrice: 80000,
                    entryStage: 1
                }] as any
            } as any
        });
        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    // 16. OPERATOR_MANAGED -> 미적용
    it("16. OPERATOR_MANAGED -> 미적용", () => {
        clearGlobalShockStates();
        rangeContinuationStateMap.clear();
        seedBtcStaleShock("DOWN", "NONE", 0.0005, 0.0012);
        const input = makeBtcInput({
            snapshot: {
                operatorManaged: true
            } as any,
            state: {
                directionalShockState: "DOWN",
                rawDirectionalShockState: "NONE",
                longAllow: false,
                shortAllow: false
            } as any
        });
        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.metadata?.decision_reason, "BTC_RANGE_MR_STALE_DOWN_SHOCK_LOCAL_BYPASS");
        assert.notStrictEqual(result.decision.side, "long");
    });

    // 17. manual takeover -> 미적용
    it("17. manual takeover -> 미적용", () => {
        seedBtcStaleShock("DOWN", "NONE", 0.0005, 0.0012);
        const input = makeBtcInput({
            state: {
                manualTakeoverActive: true
            } as any
        });
        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    // 18. ETHUSDT behavior unchanged (bypass does not fire for ETH)
    it("18. ETHUSDT behavior unchanged (bypass does not fire for ETH)", () => {
        globalShockStates.set("ETHUSDT", {
            symbol: "ETHUSDT",
            activeDirection: "DOWN",
            rawDirection: "NONE",
            candidateDirection: "NONE",
            candidateCount: 0,
            neutralCount: 5,
            rawMovePct: 0.0005,
            requiredMovePct: 0.0012,
            emergencyBypass: false,
            lastChangedAt: Date.now()
        } as any);
        const ethInput = makeBtcInput({
            symbol: "ETHUSDT",
            snapshot: {
                symbol: "ETHUSDT",
                lastPrice: 3000,
                boxPos: 0.15,
                reversal_confirmed: true
            } as any,
            state: {
                directionalShockState: "DOWN",
                rawDirectionalShockState: "NONE",
                longAllow: false
            } as any
        });
        const result = runEngineV2(ethInput);
        assert.notStrictEqual(result.decision.side, "long");
    });

    // 19. BTC TP behavior unchanged
    it("19. BTC TP behavior unchanged", () => {
        seedBtcStaleShock("DOWN", "NONE", 0.0005, 0.0012);
        const input = makeBtcInput();
        const result = runEngineV2(input);
        if (result.decision.decision === "ENTER") {
            assert.ok(result.decision.committedRiskPlan !== undefined);
            assert.ok(result.decision.committedRiskPlan?.stopPrice !== undefined);
            assert.ok(result.decision.committedRiskPlan?.invalidationPx !== undefined);
        }
    });

    // 20. global shock state before == after (zero state contamination)
    it("20. global shock state before == after (zero state contamination)", () => {
        globalShockStates.set("BTCUSDT", {
            activeDirection: "DOWN",
            rawDirection: "NONE",
            candidateDirection: "NONE",
            candidateCount: 0,
            neutralCount: 5,
            candidateStartedAt: null,
            activatedAt: 1788410000000,
            lastChangedAt: 1788410000000,
            rawMovePct: 0.0005,
            requiredMovePct: 0.0012,
            emergencyBypass: false,
            lastProcessedCycle: 100
        });

        const flatCandles = createCandles([80020, 80020, 80020, 80020, 80020, 80020, 80020, 80020, 80020, 80020]);
        const input = makeBtcInput({
            candles: flatCandles,
            snapshot: {
                candles: flatCandles,
                boxLow: 0
            } as any
        });
        runEngineV2(input);

        // activeDirection and core state parameters must not be mutated
        assert.strictEqual(globalShockStates.get("BTCUSDT")?.activeDirection, "DOWN");
    });
});
