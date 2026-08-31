/**
 * Pre-entry TP exact equality proofs (blocking invariants before commit).
 *
 * A. ETH FAST_TREND_SHIFT promoted ENTER — gate executable TP == committed == tpTriggerPx
 * B. BTC FAST_TREND_SHIFT symmetric
 * C. Fractional raw TP — gate normalized TP == submission normalized TP
 * D. tick metadata unavailable — fail-closed (no hardcoded fallback entry)
 * E. Adaptive input change — shared authority keeps gate/downstream divergence = 0
 */

import assert from "node:assert/strict";
import {
    buildV2PreEntryRiskPlanCommitted,
    type V2PreEntryRiskPlanAdaptiveContext
} from "./paper-engine";
import type { EntryExecutionAuthority } from "../engine-v2/types";
import { evaluateTpProfitabilityAuthority } from "../engine-v2/execution/tp-profitability-authority";
import {
    resolvePreEntryPolicySlPrice,
    resolveV2PreEntryExecutableTpBundle,
    resolveV2PreEntryTp1Authority
} from "../engine-v2/execution/pre-entry-tp-provenance";
import { resolveInstrumentTickSzAuthority } from "../engine-v2/execution/instrument-tick-authority";
import { evaluatePreEntryProtectionPlan } from "../engine-v2/execution/pre-entry-protection-plan";
import { buildV2NewEntryAttachAlgoOrds } from "../engine-v2/execution/entry-protection-attach";
import { normalizePxToTickSz } from "../engine-v2/execution/entry-order-type";
import { adaptV2Input } from "../engine-v2/index";
import { buildV2SnapshotBridge } from "./paper-engine";

function pass(label: string, detail?: Record<string, unknown>): void {
    const extra = detail ? ` — ${JSON.stringify(detail)}` : "";
    console.log(`[PRE-ENTRY-TP-EQUALITY][${label}] PASS${extra}`);
}

const noopLogger = { info: () => {}, warn: () => {} };

type FtsScenario = Readonly<{
    symbol: "ETHUSDT" | "BTCUSDT";
    side: "long" | "short";
    entry: number;
    boxHigh: number;
    boxLow: number;
    boxMid: number;
    atr: number;
    tickSz: number;
    rawStructuralSl: number;
}>;

const ETH_FTS: FtsScenario = {
    symbol: "ETHUSDT",
    side: "long",
    entry: 2480,
    boxHigh: 2550,
    boxLow: 2470,
    boxMid: 2510,
    atr: 10,
    tickSz: 0.01,
    rawStructuralSl: 2465
};

const BTC_FTS: FtsScenario = {
    symbol: "BTCUSDT",
    side: "long",
    entry: 67500,
    boxHigh: 69000,
    boxLow: 67000,
    boxMid: 68000,
    atr: 150,
    tickSz: 0.1,
    rawStructuralSl: 66800
};

function makeFtsAuthority(scenario: FtsScenario): EntryExecutionAuthority {
    return {
        decision: "ENTER",
        side: scenario.side,
        stageMarginKrw: 100000,
        regime: "RANGE",
        source: "v2",
        invalidationPx: scenario.rawStructuralSl,
        stopPrice: scenario.rawStructuralSl,
        marketSubtype: "FAST_TREND_SHIFT",
        rangeBoxHighAtEntry: scenario.boxHigh,
        rangeBoxLowAtEntry: scenario.boxLow,
        rangeBoxMidAtEntry: scenario.boxMid
    };
}

function adaptiveContext(scenario: FtsScenario, overrides: Partial<V2PreEntryRiskPlanAdaptiveContext> = {}): V2PreEntryRiskPlanAdaptiveContext {
    return {
        atr: scenario.atr,
        boxHigh: scenario.boxHigh,
        boxLow: scenario.boxLow,
        boxMid: scenario.boxMid,
        marketSubtype: "FAST_TREND_SHIFT",
        routingEngine: "RANGE",
        feeRate: 0.0005,
        preserveCanonicalStructuralStop: true,
        ...overrides
    };
}

function buildBridgeAdaptedSnapshotTick(scenario: FtsScenario): number {
    const bridge = buildV2SnapshotBridge({
        lastPrice: scenario.entry,
        latestCandleClose: scenario.entry,
        signal: scenario.side === "long" ? "paper_long_candidate" : "paper_short_candidate",
        entryCandidate: true,
        qualityScore: 72,
        ema20: scenario.entry,
        emaGap: scenario.side === "long" ? 0.006 : -0.006,
        boxHigh: scenario.boxHigh,
        boxLow: scenario.boxLow,
        boxPos: 0.55,
        atr: scenario.atr,
        atr20: scenario.atr,
        tickSz: scenario.tickSz,
        rangeConfidence: 0.78,
        trendWeaknessScore: 0.22,
        boxCohesion01: 0.9,
        breakoutFailureRate: 0.12,
        rangeOscillationScore: 0.62,
        swingHighSlope: 0,
        swingLowSlope: 0,
        rangeCenterSlope: 0,
        boxHighSlope: 0,
        boxLowSlope: 0,
        ema20Slope: 0,
        ema60Slope: 0,
        atrExpansion: 1,
        volumeExpansion: 1,
        reviewing_ticks: 0,
        canonicalRegime: "RANGE"
    } as Parameters<typeof buildV2SnapshotBridge>[0]);
    const v2Input = adaptV2Input(
        scenario.symbol,
        Date.now(),
        bridge as any,
        {
            baseSizeUsd: 100,
            paperMaxOpenPositions: 3,
            paperReentryCooldownMs: 0,
            okxLiveMaxOrderNotionalUsdt: 500,
            paperTakerFeeRate: 0.0005
        } as any,
        {
            currentPositions: [],
            globalRiskScore: 0,
            lossStreaks: {},
            directionalShockState: "NONE",
            longAllow: true,
            shortAllow: true,
            executionReadiness: true,
            freshTickBarrierActive: false,
            freshTickCompletedCycles: 1,
            freshTickRequiredCycles: 1
        } as any,
        { decision: { final_decision: "ENTER" }, regime: "RANGE", side: scenario.side, isBlocked: false } as any,
        [],
        "authoritative",
        `pre_entry_tp_bridge_${scenario.symbol}`
    );
    assert.equal(v2Input.snapshot.tickSz, scenario.tickSz, `${scenario.symbol} bridge/adapt tick propagation`);
    return v2Input.snapshot.tickSz!;
}

function assertExactTpChain(label: string, scenario: FtsScenario, adaptiveOverrides?: Partial<V2PreEntryRiskPlanAdaptiveContext>): void {
    const authority = makeFtsAuthority(scenario);
    const adaptiveCtx = adaptiveContext(scenario, adaptiveOverrides);
    const rawPolicySlPrice = resolvePreEntryPolicySlPrice({
        side: scenario.side,
        regime: "RANGE",
        entryPrice: scenario.entry,
        rawStructuralSl: scenario.rawStructuralSl
    });
    const bridgeTickSz = buildBridgeAdaptedSnapshotTick(scenario);

    const bundle = resolveV2PreEntryExecutableTpBundle({
        side: scenario.side,
        regime: "RANGE",
        entryPrice: scenario.entry,
        rawStructuralSl: scenario.rawStructuralSl,
        rawPolicySlPrice,
        marketSubtype: "FAST_TREND_SHIFT",
        routingEngine: "RANGE",
        atr: adaptiveCtx.atr ?? null,
        boxHigh: adaptiveCtx.boxHigh ?? null,
        boxLow: adaptiveCtx.boxLow ?? null,
        boxMid: adaptiveCtx.boxMid ?? null,
        feeRate: adaptiveCtx.feeRate ?? null,
        preserveCanonicalStructuralStop: true,
        snapshotTickSz: bridgeTickSz
    });
    assert.equal(bundle.ok, true, `${label} bundle must resolve`);

    if (!bundle.ok) throw new Error(`${label} bundle failed`);

    const profitability = evaluateTpProfitabilityAuthority({
        symbol: scenario.symbol,
        side: scenario.side,
        regime: "RANGE",
        entryPrice: scenario.entry,
        canonicalTp1Price: bundle.rawCanonicalTp1Price,
        canonicalTp1Source: bundle.canonicalTp1Source,
        feeRate: 0.0005,
        paperSlippageEstimateBps: 8,
        tickSz: bundle.tpTickSize
    });

    const committed = buildV2PreEntryRiskPlanCommitted(
        authority,
        {},
        scenario.side,
        scenario.entry,
        noopLogger,
        scenario.symbol,
        adaptiveCtx
    );
    assert.equal(committed.ok, true, `${label} committed plan must resolve`);
    if (!committed.ok) throw new Error(`${label} committed plan failed`);

    const protection = evaluatePreEntryProtectionPlan({
        symbol: scenario.symbol,
        side: scenario.side,
        entryReferencePrice: scenario.entry,
        slPrice: committed.plan.stop_price,
        tpPrice: committed.plan.initial_tp_price,
        isV2Authority: true,
        regime: "RANGE",
        tickSz: bundle.tpTickSize
    });
    assert.equal(protection.protectionPlanReady, true, `${label} protection plan ready`);
    assert.equal(protection.entryBlocked, false, `${label} protection must not block`);

    const attach = buildV2NewEntryAttachAlgoOrds({
        clOrdId: "test-cl-ord",
        submitSzStr: "1",
        stopPrice: protection.slPrice,
        takeProfitPrice: protection.tpPrice,
        isV2RangePartialPlan: false
    });
    const tpTriggerPxRaw = (attach.attachAlgoOrds[0] as { tpTriggerPx?: string } | undefined)?.tpTriggerPx;
    assert.ok(tpTriggerPxRaw != null, `${label} tpTriggerPx must be present`);
    const tpTriggerPx = Number(tpTriggerPxRaw);

    assert.equal(profitability.rawCanonicalTp1Price, bundle.rawCanonicalTp1Price, `${label} raw canonical`);
    assert.equal(profitability.executableTp1Price, bundle.executableTp1Price, `${label} executable canonical`);
    assert.equal(committed.plan.initial_tp_price, bundle.rawCanonicalTp1Price, `${label} committed raw TP`);
    assert.equal(protection.tpPrice, bundle.executableTp1Price, `${label} protection TP`);
    assert.equal(tpTriggerPx, bundle.executableTp1Price, `${label} OKX tpTriggerPx`);
    assert.equal(
        normalizePxToTickSz(bundle.rawCanonicalTp1Price, bundle.tpTickSize),
        bundle.executableTp1Price,
        `${label} tick normalization divergence = 0`
    );

    pass(label, {
        symbol: scenario.symbol,
        rawCanonicalTp1Price: bundle.rawCanonicalTp1Price,
        executableTp1Price: bundle.executableTp1Price,
        committedTp: committed.plan.initial_tp_price,
        protectionTp: protection.tpPrice,
        tpTriggerPx,
        tickSz: bundle.tpTickSize,
        tickSzSource: bundle.tickSzSource,
        tpSource: bundle.tpSource
    });
}

function runPreEntryTpExactEqualityCases(): void {
    console.info("=== RUNNING PRE-ENTRY TP EXACT EQUALITY CASES ===");

    // CASE A — ETH FAST_TREND_SHIFT
    assertExactTpChain("CASE_A_ETH_FAST_TREND_SHIFT", ETH_FTS);

    // CASE B — BTC FAST_TREND_SHIFT
    assertExactTpChain("CASE_B_BTC_FAST_TREND_SHIFT", BTC_FTS);

    // CASE C — fractional raw TP tick normalization parity (FTS escalation needs atr/box authority metadata)
    {
        const entry = 2480.005;
        const tickSz = 0.01;
        const rawTp = 2523.337; // not tick-aligned
        const bridgeTickSz = buildBridgeAdaptedSnapshotTick({ ...ETH_FTS, entry, tickSz });
        const bundle = resolveV2PreEntryExecutableTpBundle({
            side: "long",
            regime: "RANGE",
            entryPrice: entry,
            rawStructuralSl: 2465,
            rawPolicySlPrice: resolvePreEntryPolicySlPrice({
                side: "long",
                regime: "RANGE",
                entryPrice: entry,
                rawStructuralSl: 2465
            }),
            execMetaTakeProfitPlanTp1: rawTp,
            marketSubtype: "FAST_TREND_SHIFT",
            routingEngine: "RANGE",
            atr: ETH_FTS.atr,
            boxHigh: ETH_FTS.boxHigh,
            boxLow: ETH_FTS.boxLow,
            boxMid: ETH_FTS.boxMid,
            feeRate: 0.0005,
            paperSlippageEstimateBps: 8,
            preserveCanonicalStructuralStop: true,
            adaptiveContextPresent: false,
            snapshotTickSz: bridgeTickSz,
            symbol: "ETHUSDT"
        });
        assert.equal(bundle.ok, true);
        if (!bundle.ok) throw new Error("CASE C bundle failed");

        const gateNorm = bundle.executableTp1Price;
        const submitNorm = normalizePxToTickSz(rawTp, tickSz);
        const protection = evaluatePreEntryProtectionPlan({
            symbol: "ETHUSDT",
            side: "long",
            entryReferencePrice: entry,
            slPrice: 2465,
            tpPrice: rawTp,
            isV2Authority: true,
            regime: "RANGE",
            tickSz
        });
        const attach = buildV2NewEntryAttachAlgoOrds({
            clOrdId: "c",
            submitSzStr: "1",
            stopPrice: protection.slPrice,
            takeProfitPrice: protection.tpPrice,
            isV2RangePartialPlan: false
        });
        const tpTriggerPx = Number((attach.attachAlgoOrds[0] as { tpTriggerPx: string }).tpTriggerPx);

        assert.equal(bundle.rawCanonicalTp1Price, rawTp, "CASE C canonical raw TP unchanged");
        assert.equal(bundle.tpSource, "authority_tp_price", "CASE C explicit execMeta TP preserved");
        assert.equal(bundle.tickSzSource, "snapshot.tickSz", "CASE C tickSz source unchanged");
        assert.notEqual(rawTp, gateNorm, "CASE C raw TP must require normalization");
        assert.equal(gateNorm, submitNorm);
        assert.equal(protection.tpPrice, gateNorm);
        assert.equal(tpTriggerPx, gateNorm);
        pass("CASE_C_FRACTIONAL_TICK_NORMALIZATION", {
            rawTp,
            gateNorm,
            submitNorm,
            tpTriggerPx,
            tpSource: bundle.tpSource,
            tickSzSource: bundle.tickSzSource
        });
    }

    // CASE D — tick metadata unavailable => fail-closed
    {
        const tickAuth = resolveInstrumentTickSzAuthority({});
        assert.equal(tickAuth.ok, false);
        if (tickAuth.ok) throw new Error("CASE D tick auth should fail");
        assert.equal(tickAuth.blockReason, "INSTRUMENT_TICK_SZ_UNAVAILABLE");

        const bundle = resolveV2PreEntryExecutableTpBundle({
            side: "long",
            regime: "RANGE",
            entryPrice: ETH_FTS.entry,
            rawStructuralSl: ETH_FTS.rawStructuralSl,
            rawPolicySlPrice: resolvePreEntryPolicySlPrice({
                side: "long",
                regime: "RANGE",
                entryPrice: ETH_FTS.entry,
                rawStructuralSl: ETH_FTS.rawStructuralSl
            }),
            marketSubtype: "FAST_TREND_SHIFT",
            routingEngine: "RANGE",
            atr: ETH_FTS.atr,
            boxHigh: ETH_FTS.boxHigh,
            boxLow: ETH_FTS.boxLow,
            feeRate: 0.0005,
            preserveCanonicalStructuralStop: true
        });
        assert.equal(bundle.ok, false);
        if (bundle.ok) throw new Error("CASE D bundle should fail without tick");
        assert.equal(bundle.blockReason, "INSTRUMENT_TICK_SZ_UNAVAILABLE");

        const prof = evaluateTpProfitabilityAuthority({
            symbol: "ETHUSDT",
            side: "long",
            regime: "RANGE",
            entryPrice: ETH_FTS.entry,
            canonicalTp1Price: 2520,
            canonicalTp1Source: "engine_calculated",
            feeRate: 0.0005,
            paperSlippageEstimateBps: 8,
            tickSz: null
        });
        assert.equal(prof.entryAllowed, false);
        assert.equal(prof.blockReason, "V2_TP_PROFITABILITY_COST_AUTHORITY_INVALID");
        pass("CASE_D_TICK_UNAVAILABLE_FAIL_CLOSED", { bundleBlockReason: bundle.blockReason });
    }

    // CASE E — adaptive input change; gate and downstream share resolveV2PreEntryTp1Authority
    {
        const bridgeTickSz = buildBridgeAdaptedSnapshotTick(ETH_FTS);
        const baseInput = {
            side: "long" as const,
            regime: "RANGE",
            entryPrice: ETH_FTS.entry,
            rawStructuralSl: ETH_FTS.rawStructuralSl,
            rawPolicySlPrice: resolvePreEntryPolicySlPrice({
                side: "long" as const,
                regime: "RANGE",
                entryPrice: ETH_FTS.entry,
                rawStructuralSl: ETH_FTS.rawStructuralSl
            }),
            marketSubtype: "FAST_TREND_SHIFT",
            routingEngine: "RANGE",
            boxHigh: ETH_FTS.boxHigh,
            boxLow: ETH_FTS.boxLow,
            boxMid: ETH_FTS.boxMid,
            feeRate: 0.0005,
            preserveCanonicalStructuralStop: true,
            snapshotTickSz: bridgeTickSz
        };

        const atrVariants = [8, 10, 14];
        for (const atr of atrVariants) {
            const gateAuthority = resolveV2PreEntryTp1Authority({ ...baseInput, atr });
            const downstreamAuthority = resolveV2PreEntryTp1Authority({
                ...baseInput,
                atr,
                rangeBoxHighAtEntry: ETH_FTS.boxHigh,
                rangeBoxLowAtEntry: ETH_FTS.boxLow,
                rangeBoxMidAtEntry: ETH_FTS.boxMid,
                adaptiveContextPresent: true
            });
            assert.equal(gateAuthority.ok, downstreamAuthority.ok, `CASE E atr=${atr} ok parity`);
            if (gateAuthority.ok && downstreamAuthority.ok) {
                assert.equal(gateAuthority.rawTp1Price, downstreamAuthority.rawTp1Price, `CASE E atr=${atr} raw TP`);
                assert.equal(gateAuthority.tpSource, downstreamAuthority.tpSource, `CASE E atr=${atr} source`);
            }
        }

        const bundleAtr14 = resolveV2PreEntryExecutableTpBundle({ ...baseInput, atr: 14 });
        assert.equal(bundleAtr14.ok, true);
        if (!bundleAtr14.ok) throw new Error("CASE E bundle failed");
        assertExactTpChain("CASE_E_ADAPTIVE_ATR_14", ETH_FTS, { atr: 14 });
    }

    console.info("=== ALL PRE-ENTRY TP EXACT EQUALITY CASES PASSED ===");
}

runPreEntryTpExactEqualityCases();
