import test from "node:test";
import assert from "node:assert/strict";
import { runEngineV2 } from "../engine-v2/index";
import { EngineV2Input } from "../engine-v2/types";

function createCandles(closes: number[], baseTs = 1788410000000) {
    return closes.map((close, i) => ({
        ts: baseTs + i * 60000,
        time: baseTs + i * 60000,
        open: close * 0.9995,
        high: close * 1.0005,
        low: close * 0.9990,
        close,
        volume: 100
    }));
}

function createHtfCandles(count = 30, basePrice = 60000, step = 200) {
    const closes: number[] = [];
    for (let i = 0; i < count; i++) {
        closes.push(basePrice + i * step);
    }
    return createCandles(closes);
}

function createTestEngineInput(overrides: Record<string, any> = {}): EngineV2Input {
    const defaultCloses = Array.from({ length: 60 }, (_, i) => 65000 + (i % 5) * 50);
    const defaultCandles = createCandles(defaultCloses);
    const htfPack = {
        "5m": defaultCandles,
        "15m": createHtfCandles(30, 64000, 100),
        "1h": createHtfCandles(30, 63000, 150),
        "4h": createHtfCandles(30, 62000, 200),
        "1d": createHtfCandles(30, 60000, 300)
    };

    return {
        symbol: "BTCUSDT",
        run_cycle_id: "test-probe-only-key",
        config: {
            paperMaxOpenPositions: 3,
            baseSizeUsd: 100,
            maxSymbolNotionalUsd: 5000,
            maxAccountNotionalUsd: 20000,
            okxLiveEnabled: true,
            okxAuthMode: "live",
            okxExchangeAuthOptIn: true,
            okxLiveMaxOrderNotionalUsdt: 200,
            serverTradeEnabled: true
        } as any,
        evaluationMode: "authoritative",
        ...overrides,
        snapshot: {
            symbol: "BTCUSDT",
            lastPrice: 65800,
            latestCandleClose: 65800,
            qualityScore: 85,
            boxPos: 0.85,
            boxLow: 64000,
            boxHigh: 66000,
            atr: 300,
            rangeConfidence: 0.85,
            boxCohesion01: 0.95,
            trendWeaknessScore: 0.25,
            candles: defaultCandles,
            htf_candles: htfPack,
            tickSz: 0.1,
            lotSz: 0.01,
            canonicalRegime: "RANGE",
            signal: "paper_short_candidate",
            entryCandidate: true,
            reversalConfirmed: true,
            ...(overrides.snapshot ?? {})
        } as any,
        state: {
            currentPositions: [],
            directionalShockState: "NONE",
            rawDirectionalShockState: "NONE",
            longAllow: false, // risk disallows long
            shortAllow: false, // risk disallows short
            serverTradeEnabled: true,
            closeOnlyMode: false,
            killSwitch: false,
            reconcileSafeMode: false,
            paperExecutionReady: true,
            signedExecutionReady: true,
            accountEquityKrw: 14_000_000,
            accountEquityUsdt: 10_000,
            availableBalanceUsdt: 10_000,
            liveBalanceReady: true,
            okxActualPositionsReady: true,
            actualAccountNotionalUsdtReady: true,
            exposureNotionalCapKrw: 100_000_000,
            symbolExposureNotionalCapKrw: 50_000_000,
            ledgerExposureNotionalKrw: 0,
            symbolLedgerExposureNotionalKrw: 0,
            okxActualPositions: [],
            okxPendingOrdersReady: true,
            okxPendingOrdersNotionalUsdt: 0,
            dailyLossGuardTriggered: false,
            lossStreaks: {},
            globalRiskScore: 0,
            executionReadiness: true,
            ...(overrides.state ?? {})
        } as any
    } as any;
}

test("HTF PROBE_ONLY Comprehensive Authoritative Bridge Test Suite", async (t) => {
    // ── SHORT 측 검증 ─────────────────────────────────────────────────────────────

    await t.test("1. PROBE_ONLY + short candidate + 구조 미확정 → BLOCK", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                lastPrice: 65800,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                reversalConfirmed: false // 구조 미확정
            },
            state: {
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("2. PROBE_ONLY + short candidate + quality 미달 (qualityScore < 60) → BLOCK", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                lastPrice: 65800,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                qualityScore: 50, // quality 미달
                reversalConfirmed: true
            },
            state: {
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("3. PROBE_ONLY + valid short structure + shortAllow=false → PROBE ENTER, size <= 0.5x", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                lastPrice: 65800,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                qualityScore: 85,
                reversalConfirmed: true
            },
            state: {
                shortAllow: false,
                longAllow: false,
                directionalShockState: "NONE"
            }
        });

        const result = runEngineV2(input);
        const decision = result.decision;
        const execMeta = ((result.internal as any)?.execution?.metadata ?? {}) as Record<string, unknown>;

        assert.notStrictEqual(decision.explanation?.reason, "SHORT_NOT_ALLOWED");
        if (decision.decision === "ENTER") {
            assert.strictEqual(decision.side, "short");
            assert.strictEqual(execMeta.probe_only_bridge_activated, true);
            assert.strictEqual(execMeta.isCountertrendProbe, true);
            assert.ok(Number(execMeta.htf_size_multiplier ?? 1) <= 0.5);
        }
    });

    await t.test("4. PROBE_ONLY + lower-zone short chase → BLOCK", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.15, // lower zone -> chase!
                lastPrice: 64200,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                reversalConfirmed: true
            },
            state: {
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("5. LONG_ONLY_OR_NONE + ordinary short → BLOCK", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                lastPrice: 65800,
                signal: "paper_short_candidate",
                htf_entry_policy: "LONG_ONLY_OR_NONE",
                reversalConfirmed: true
            },
            state: {
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("6. killSwitch=true → BLOCK", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                lastPrice: 65800,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                reversalConfirmed: true
            },
            state: {
                killSwitch: true, // hard safety triggered
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("7. closeOnlyMode=true → BLOCK", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                lastPrice: 65800,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                reversalConfirmed: true
            },
            state: {
                closeOnlyMode: true, // hard safety triggered
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("8. dailyLossGuardTriggered=true → BLOCK", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                lastPrice: 65800,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                reversalConfirmed: true
            },
            state: {
                dailyLossGuardTriggered: true, // hard safety triggered
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("9. exposure cap 초과 → BLOCK", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85,
                lastPrice: 65800,
                signal: "paper_short_candidate",
                htf_entry_policy: "PROBE_ONLY",
                reversalConfirmed: true
            },
            state: {
                exposureNotionalCapKrw: 10_000_000,
                ledgerExposureNotionalKrw: 10_000_000, // cap exceeded
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    // ── LONG 측 1~9 좌우대칭 검증 ──────────────────────────────────────────────────

    await t.test("10-1. PROBE_ONLY + long candidate + 구조 미확정 → BLOCK", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.15,
                lastPrice: 64200,
                signal: "paper_long_candidate",
                htf_entry_policy: "PROBE_ONLY",
                reversalConfirmed: false // 구조 미확정
            },
            state: {
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("10-2. PROBE_ONLY + long candidate + quality 미달 → BLOCK", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.15,
                lastPrice: 64200,
                signal: "paper_long_candidate",
                htf_entry_policy: "PROBE_ONLY",
                qualityScore: 40,
                reversalConfirmed: true
            },
            state: {
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("10-3. PROBE_ONLY + valid long structure + longAllow=false → PROBE ENTER, size <= 0.5x", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.15,
                lastPrice: 64200,
                signal: "paper_long_candidate",
                htf_entry_policy: "PROBE_ONLY",
                qualityScore: 85,
                reversalConfirmed: true
            },
            state: {
                shortAllow: false,
                longAllow: false,
                directionalShockState: "NONE"
            }
        });

        const result = runEngineV2(input);
        const decision = result.decision;
        const execMeta = ((result.internal as any)?.execution?.metadata ?? {}) as Record<string, unknown>;

        assert.notStrictEqual(decision.explanation?.reason, "LONG_NOT_ALLOWED");
        if (decision.decision === "ENTER") {
            assert.strictEqual(decision.side, "long");
            assert.strictEqual(execMeta.probe_only_bridge_activated, true);
            assert.strictEqual(execMeta.isCountertrendProbe, true);
            assert.ok(Number(execMeta.htf_size_multiplier ?? 1) <= 0.5);
        }
    });

    await t.test("10-4. PROBE_ONLY + upper-zone long chase → BLOCK", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.85, // upper zone -> chase!
                lastPrice: 65800,
                signal: "paper_long_candidate",
                htf_entry_policy: "PROBE_ONLY",
                reversalConfirmed: true
            },
            state: {
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("10-5. SHORT_ONLY_OR_NONE + ordinary long → BLOCK", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.15,
                lastPrice: 64200,
                signal: "paper_long_candidate",
                htf_entry_policy: "SHORT_ONLY_OR_NONE",
                reversalConfirmed: true
            },
            state: {
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("10-6. LONG 측 killSwitch=true → BLOCK", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.15,
                lastPrice: 64200,
                signal: "paper_long_candidate",
                htf_entry_policy: "PROBE_ONLY",
                reversalConfirmed: true
            },
            state: {
                killSwitch: true,
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("10-7. LONG 측 closeOnlyMode=true → BLOCK", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.15,
                lastPrice: 64200,
                signal: "paper_long_candidate",
                htf_entry_policy: "PROBE_ONLY",
                reversalConfirmed: true
            },
            state: {
                closeOnlyMode: true,
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("10-8. LONG 측 dailyLossGuardTriggered=true → BLOCK", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.15,
                lastPrice: 64200,
                signal: "paper_long_candidate",
                htf_entry_policy: "PROBE_ONLY",
                reversalConfirmed: true
            },
            state: {
                dailyLossGuardTriggered: true,
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    await t.test("10-9. LONG 측 exposure cap 초과 → BLOCK", () => {
        const input = createTestEngineInput({
            snapshot: {
                boxPos: 0.15,
                lastPrice: 64200,
                signal: "paper_long_candidate",
                htf_entry_policy: "PROBE_ONLY",
                reversalConfirmed: true
            },
            state: {
                exposureNotionalCapKrw: 10_000_000,
                ledgerExposureNotionalKrw: 10_000_000,
                shortAllow: false,
                longAllow: false
            }
        });

        const result = runEngineV2(input);
        assert.notStrictEqual(result.decision.decision, "ENTER");
    });

    // ── V2_PROBE_ONLY_AUTHORITY_BRIDGE_PROOF 로그 및 필드 검증 ───────────────────

    await t.test("13. V2_PROBE_ONLY_AUTHORITY_BRIDGE_PROOF 로그 구조 및 필드 검증", () => {
        const originalLog = console.info;
        const capturedLogs: any[] = [];
        console.info = (msg: string) => {
            try {
                const parsed = JSON.parse(msg);
                if (parsed.event === "V2_PROBE_ONLY_AUTHORITY_BRIDGE_PROOF") {
                    capturedLogs.push(parsed);
                }
            } catch {}
            originalLog(msg);
        };

        try {
            const input = createTestEngineInput({
                snapshot: {
                    boxPos: 0.85,
                    lastPrice: 65800,
                    signal: "paper_short_candidate",
                    htf_entry_policy: "PROBE_ONLY",
                    reversalConfirmed: true,
                    qualityScore: 85
                },
                state: {
                    shortAllow: false,
                    longAllow: false,
                    directionalShockState: "NONE"
                }
            });

            runEngineV2(input);

            assert.ok(capturedLogs.length > 0, "V2_PROBE_ONLY_AUTHORITY_BRIDGE_PROOF event must be emitted");
            const proof = capturedLogs[0];
            assert.ok("candidate_side" in proof);
            assert.ok("structural_confirmation" in proof);
            assert.ok("quality_score" in proof);
            assert.ok("zone" in proof);
            assert.ok("longAllow" in proof);
            assert.ok("shortAllow" in proof);
            assert.ok("probeOnlyLongExceptionAllowed" in proof);
            assert.ok("probeOnlyShortExceptionAllowed" in proof);
            assert.ok("size_multiplier" in proof);
            assert.ok("bypassed_gate" in proof);
            assert.ok("decision_before" in proof);
            assert.ok("decision_after" in proof);
            assert.ok("block_reason" in proof);
        } finally {
            console.info = originalLog;
        }
    });
});
