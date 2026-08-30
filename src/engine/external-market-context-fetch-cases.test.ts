import {
    aggregateCryptoNewsSentiment,
    applySignalReliabilityToMultiplier,
    assembleExternalMarketSnapshot,
    buildExternalMarketContextProofLog,
    buildExternalMarketContextShadowProofLog,
    buildSignalBreakdown,
    combineDirectionalAndEventRiskMultipliers,
    computeEventRiskMultiplier,
    computeExternalContextScore,
    computeExternalSignalReliability,
    computeSizeMultiplierFromAlignment,
    evaluateExternalMarketContext,
    ExternalMarketContextService,
    deriveEconomicEventRisk,
    fetchCryptoNewsReading,
    normalizeTnxToYieldPercent,
    normalizeUs10yYieldPointChange,
    resetExternalMarketContextServiceForTests
} from "../engine-v2/external-market-context";
import type { ExternalMarketSnapshot } from "../engine-v2/external-market-context";

function assertTrue(cond: boolean, msg: string): void {
    if (!cond) throw new Error(msg);
}

function assertClose(actual: number, expected: number, eps: number, msg: string): void {
    if (Math.abs(actual - expected) > eps) {
        throw new Error(`${msg}: expected ${expected}, got ${actual}`);
    }
}

function baseFetchConfig() {
    return {
        fetchEnabled: true,
        fetchIntervalMs: 120_000,
        fetchTimeoutMs: 4_000,
        maxAgeMs: 900_000,
        newsMaxAgeHours: 6,
        newsHalfLifeHours: 2,
        newsMaxWeight: 0.15,
        newsApiKey: null as string | null,
        economicCalendarFetchIntervalMs: 3_600_000,
        economicCalendarCacheMaxAgeMs: 14_400_000
    };
}

function fullSnapshot(now: number, partial?: Partial<ExternalMarketSnapshot>): ExternalMarketSnapshot {
    return {
        generatedAt: now,
        maxAgeMs: 900_000,
        unavailableSources: [],
        sources: {
            nq: { value: 18000, signal: 0.6, fetchedAt: now, source: "test:nq" },
            es: { value: 5000, signal: 0.5, fetchedAt: now, source: "test:es" },
            dxy: { value: 104, signal: -0.2, fetchedAt: now, source: "test:dxy" },
            us10y: { value: 0.05, signal: -0.1, fetchedAt: now, source: "test:us10y" },
            news: { value: 0.3, signal: 0.3, fetchedAt: now, source: "test:news", confidence: 0.8 }
        },
        nqMomentum: 1.2,
        esMomentum: 1.0,
        dxyMomentum: -0.4,
        us10yChange: -0.015,
        newsSentiment: 0.3,
        newsEventRisk: 0.1,
        fetchedAt: now,
        status: "ok",
        ...partial
    };
}

async function runFetchLayerCases(): Promise<void> {
    // CASE 1 — partial source failure renormalizes weight
    {
        const now = 1_000_000;
        const snap = fullSnapshot(now, {
            unavailableSources: ["news", "us10y"],
            sources: {
                nq: { value: 18000, signal: 0.8, fetchedAt: now, source: "test:nq" },
                es: { value: 5000, signal: 0.4, fetchedAt: now, source: "test:es" },
                dxy: { value: 104, signal: -0.4, fetchedAt: now, source: "test:dxy" }
            },
            newsSentiment: null,
            us10yChange: null,
            status: "partial"
        });
        const breakdown = buildSignalBreakdown(snap);
        assertTrue(breakdown.availableWeight > 0 && breakdown.availableWeight < 1, "CASE 1 partial weight");
        const score = computeExternalContextScore(breakdown);
        assertTrue(score != null && score > 0, "CASE 1 bullish partial score");
    }

    // CASE 2 — all sources unavailable fail-open
    {
        const r = evaluateExternalMarketContext({
            side: "long",
            now: 2_000_000,
            config: {
                enabled: false,
                shadowMode: true,
                weight: 0.22,
                minSizeMultiplier: 0.8,
                maxSizeMultiplier: 1.1,
                maxAgeMs: 900_000,
                emergencyEventEnabled: false
            },
            snapshot: {
                generatedAt: 1_000_000,
                maxAgeMs: 900_000,
                unavailableSources: ["nq", "es", "dxy", "us10y", "news", "economicEvent"],
                sources: {},
                status: "unavailable",
                fetchedAt: 1_000_000
            }
        });
        assertTrue(r.externalContextApplied === false, "CASE 2 not applied");
        assertClose(r.externalSizeMultiplier, 1, 1e-9, "CASE 2 multiplier=1");
        assertTrue(r.externalContextReason.includes("FAIL_OPEN") || r.externalContextReason.includes("UNAVAILABLE"), "CASE 2 fail-open reason");
    }

    // CASE 3 — stale snapshot fail-open
    {
        const r = evaluateExternalMarketContext({
            side: "long",
            now: 3_000_000,
            config: {
                enabled: false,
                shadowMode: true,
                weight: 0.22,
                minSizeMultiplier: 0.8,
                maxSizeMultiplier: 1.1,
                maxAgeMs: 900_000,
                emergencyEventEnabled: false
            },
            snapshot: fullSnapshot(1_000_000)
        });
        assertTrue(r.externalContextApplied === false, "CASE 3 stale not applied");
        assertTrue(r.failOpen === true, "CASE 3 failOpen");
    }

    // CASE 4 — shadow mode computes preview but no trading impact
    {
        const now = 1_000_000;
        const r = evaluateExternalMarketContext({
            side: "long",
            now,
            config: {
                enabled: false,
                shadowMode: true,
                weight: 0.22,
                minSizeMultiplier: 0.8,
                maxSizeMultiplier: 1.1,
                maxAgeMs: 900_000,
                emergencyEventEnabled: false
            },
            snapshot: fullSnapshot(now)
        });
        assertTrue(r.externalContextApplied === false, "CASE 4 shadow not applied");
        assertTrue(r.shadowPreview === true, "CASE 4 shadow preview");
        assertTrue((r.longPreviewMultiplier ?? 1) > 1, "CASE 4 long preview > 1");
        assertClose(r.externalSizeMultiplier, 1, 1e-9, "CASE 4 trading multiplier neutral");
    }

    // CASE 5 — LONG/SHORT inversion
    {
        const now = 1_000_000;
        const snap = fullSnapshot(now);
        const longR = evaluateExternalMarketContext({
            side: "long",
            now,
            config: {
                enabled: false,
                shadowMode: true,
                weight: 0.22,
                minSizeMultiplier: 0.8,
                maxSizeMultiplier: 1.1,
                maxAgeMs: 900_000,
                emergencyEventEnabled: false
            },
            snapshot: snap
        });
        const shortR = evaluateExternalMarketContext({
            side: "short",
            now,
            config: {
                enabled: false,
                shadowMode: true,
                weight: 0.22,
                minSizeMultiplier: 0.8,
                maxSizeMultiplier: 1.1,
                maxAgeMs: 900_000,
                emergencyEventEnabled: false
            },
            snapshot: snap
        });
        assertTrue(longR.sideAlignedScore > 0, "CASE 5 long aligned positive");
        assertTrue(shortR.sideAlignedScore < 0, "CASE 5 short aligned negative");
        assertTrue((longR.longPreviewMultiplier ?? 1) > (shortR.shortPreviewMultiplier ?? 1), "CASE 5 inversion");
    }

    // CASE 6 — conflicting NQ up / DXY up reduces long score vs pure NQ up
    {
        const now = 1_000_000;
        const conflict = fullSnapshot(now, {
            sources: {
                nq: { value: 18000, signal: 0.9, fetchedAt: now, source: "test:nq" },
                dxy: { value: 105, signal: 0.8, fetchedAt: now, source: "test:dxy" }
            },
            unavailableSources: ["es", "us10y", "news"]
        });
        const pure = fullSnapshot(now, {
            sources: {
                nq: { value: 18000, signal: 0.9, fetchedAt: now, source: "test:nq" }
            },
            unavailableSources: ["es", "dxy", "us10y", "news"]
        });
        const conflictScore = computeExternalContextScore(buildSignalBreakdown(conflict)) ?? 0;
        const pureScore = computeExternalContextScore(buildSignalBreakdown(pure)) ?? 0;
        assertTrue(conflictScore < pureScore, "CASE 6 conflict lowers score");
    }

    // CASE 7 — duplicate news dedupe
    {
        const now = Date.now();
        const seen = new Set<string>();
        const items = [
            { id: "abc", published_on: Math.floor(now / 1000), title: "BTC rally surge approval", categories: "BTC", source_info: { name: "CoinDesk" } },
            { id: "abc", published_on: Math.floor(now / 1000), title: "duplicate", categories: "BTC", source_info: { name: "CoinDesk" } }
        ];
        const first = aggregateCryptoNewsSentiment(items, now, 6, 2, seen);
        const second = aggregateCryptoNewsSentiment(items, now, 6, 2, seen);
        assertTrue(first.dedupedCount === 1, "CASE 7 first dedupe");
        assertTrue(second.dedupedCount === 0, "CASE 7 second all dupes");
        assertTrue((second.reading?.signal ?? 0) === 0 || second.reading?.confidence === 0, "CASE 7 dupes neutral");
    }

    // CASE 8 — economic event risk sizing-only (no hard block)
    {
        const risk = deriveEconomicEventRisk(1);
        assertTrue(risk > 0.5, "CASE 8 imminent event risk");
        const now = 1_000_000;
        const snap = fullSnapshot(now, { newsEventRisk: risk, economicEventImminent: true });
        const r = evaluateExternalMarketContext({
            side: "long",
            now,
            config: {
                enabled: true,
                shadowMode: false,
                weight: 0.22,
                minSizeMultiplier: 0.8,
                maxSizeMultiplier: 1.1,
                maxAgeMs: 900_000,
                emergencyEventEnabled: false
            },
            snapshot: snap
        });
        assertTrue(r.externalContextApplied === true, "CASE 8 still applied");
        assertTrue(r.externalSizeMultiplier >= 0.8, "CASE 8 multiplier within bounds");
    }

    // CASE 9 — service touch triggers background fetch without blocking caller
    {
        resetExternalMarketContextServiceForTests();
        const svc = new ExternalMarketContextService({ ...baseFetchConfig(), fetchEnabled: true });
        const t0 = Date.now();
        const cached = svc.touch(t0);
        const state = svc.getState(t0);
        assertTrue(cached === null, "CASE 9 empty cache initially");
        assertTrue(state.fetchInFlight === true || state.lastFetchStartedAt != null, "CASE 9 background fetch scheduled");
    }

    // CASE 10 — proof log includes raw sources
    {
        const now = 1_000_000;
        const snap = fullSnapshot(now);
        const preview = evaluateExternalMarketContext({
            side: "long",
            now,
            config: {
                enabled: false,
                shadowMode: true,
                weight: 0.22,
                minSizeMultiplier: 0.8,
                maxSizeMultiplier: 1.1,
                maxAgeMs: 900_000,
                emergencyEventEnabled: false
            },
            snapshot: snap
        });
        const proof = buildExternalMarketContextProofLog("BTCUSDT", preview, snap);
        assertTrue(proof.event === "EXTERNAL_MARKET_CONTEXT_PROOF", "CASE 10 proof event");
        assertTrue((proof.raw_sources as any)?.nq != null, "CASE 10 raw nq");
        const shadow = buildExternalMarketContextShadowProofLog(
            { snapshot: snap, lastFetchElapsedMs: 120, lastFetchErrors: {}, fetchInFlight: false },
            preview,
            now
        );
        assertTrue(shadow.trading_impact === "none", "CASE 10 shadow no trading impact");
    }

    // CASE 11 — assemble with mocked fetch modules via partial snapshot builder path
    {
        const now = Date.now();
        const result = await assembleExternalMarketSnapshot({
            config: { ...baseFetchConfig(), fetchTimeoutMs: 1 },
            now
        });
        assertTrue(result.snapshot.generatedAt === now, "CASE 11 generatedAt");
        assertTrue(Array.isArray(result.snapshot.unavailableSources), "CASE 11 unavailable list");
        assertTrue(["ok", "partial", "unavailable"].includes(result.snapshot.status ?? ""), "CASE 11 status set");
    }

    // CASE 12 — event risk × directional multiplier: high risk never sizes up above neutral
    {
        const now = 1_000_000;
        const strongBull = fullSnapshot(now, {
            sources: {
                nq: { value: 20100, signal: 0.95, fetchedAt: now, source: "test:nq" },
                es: { value: 5650, signal: 0.92, fetchedAt: now, source: "test:es" },
                dxy: { value: 103, signal: -0.85, fetchedAt: now, source: "test:dxy" },
                us10y: { value: 4.15, signal: -0.75, fetchedAt: now, source: "test:us10y" },
                news: { value: 0.85, signal: 0.85, fetchedAt: now, source: "test:news", confidence: 0.9 }
            },
            economicEventImminent: true
        });
        const config = {
            enabled: true,
            shadowMode: false,
            weight: 0.22,
            minSizeMultiplier: 0.8,
            maxSizeMultiplier: 1.1,
            maxAgeMs: 900_000,
            emergencyEventEnabled: false
        };
        const risks = [0, 0.25, 0.5, 0.75, 1.0] as const;
        const table: Array<{ risk: number; directional: number; eventRisk: number; final: number; preview: number }> = [];
        for (const risk of risks) {
            const snap = { ...strongBull, newsEventRisk: risk };
            const r = evaluateExternalMarketContext({ side: "long", now, config, snapshot: snap });
            const directional = r.directionalSizeMultiplier ?? 0;
            const eventRiskMult = r.eventRiskMultiplier ?? 1;
            const recombined = combineDirectionalAndEventRiskMultipliers(
                directional,
                eventRiskMult,
                config.minSizeMultiplier,
                config.maxSizeMultiplier,
                risk
            );
            table.push({
                risk,
                directional,
                eventRisk: eventRiskMult,
                final: r.externalSizeMultiplier,
                preview: r.longPreviewMultiplier ?? 0
            });
            assertClose(r.externalSizeMultiplier, recombined, 1e-9, `CASE 12 recombine risk=${risk}`);
            assertTrue(r.externalSizeMultiplier >= config.minSizeMultiplier, `CASE 12 min bound risk=${risk}`);
            assertTrue(r.externalSizeMultiplier > 0, `CASE 12 never zero risk=${risk}`);
            if (risk >= 0.35) {
                assertTrue(r.externalSizeMultiplier <= 1.0, `CASE 12 high risk caps at neutral risk=${risk}`);
                assertTrue((r.longPreviewMultiplier ?? 2) <= 1.0, `CASE 12 preview capped risk=${risk}`);
            }
        }
        assertTrue(table[0].directional > 1.0, "CASE 12 strong bull directional > 1");
        assertTrue(table[0].final > 1.0, "CASE 12 zero event risk allows size up");
        assertTrue(table[4].final < table[0].final, "CASE 12 max event risk reduces vs zero risk");
        assertTrue(table[4].final <= 1.0, "CASE 12 max event risk never sizes up");
        console.log("CASE 12 event-risk matrix:", JSON.stringify(table));
    }

    // CASE 13 — Yahoo ^TNX unit: yield % normalization + bp signal mapping
    {
        assertClose(normalizeTnxToYieldPercent(4.25), 4.25, 1e-9, "CASE 13 direct yield pct");
        assertClose(normalizeTnxToYieldPercent(42.5), 4.25, 1e-9, "CASE 13 legacy 10x scale");
        assertClose(normalizeTnxToYieldPercent(4.2), 4.2, 1e-9, "CASE 13 4.20 pct");
        assertClose(normalizeTnxToYieldPercent(42.0), 4.2, 1e-9, "CASE 13 42.0 → 4.20 pct");

        const bpCases = [
            { bp: 5, point: 0.05 },
            { bp: 10, point: 0.1 },
            { bp: 25, point: 0.25 },
            { bp: -5, point: -0.05 },
            { bp: -10, point: -0.1 }
        ] as const;
        const bpTable: Array<{ bp: number; pointChange: number; signal: number }> = [];
        for (const c of bpCases) {
            const signal = normalizeUs10yYieldPointChange(c.point);
            bpTable.push({ bp: c.bp, pointChange: c.point, signal });
        }
        assertClose(bpTable[0].signal, 0.05 / 0.15, 1e-9, "CASE 13 +5bp signal");
        assertClose(bpTable[1].signal, 0.1 / 0.15, 1e-9, "CASE 13 +10bp signal");
        assertClose(bpTable[2].signal, 1, 1e-9, "CASE 13 +25bp clamp +1");
        assertClose(bpTable[3].signal, -0.05 / 0.15, 1e-9, "CASE 13 -5bp signal");
        assertClose(bpTable[4].signal, -0.1 / 0.15, 1e-9, "CASE 13 -10bp signal");

        const pctStart = 4.2;
        const pctEnd = 4.25;
        const scaledStart = 42.0;
        const scaledEnd = 42.5;
        assertClose(pctEnd - pctStart, scaledEnd / 10 - scaledStart / 10, 1e-9, "CASE 13 pct vs 10x same bp");
        assertClose(
            normalizeUs10yYieldPointChange(pctEnd - pctStart),
            normalizeUs10yYieldPointChange(normalizeTnxToYieldPercent(scaledEnd) - normalizeTnxToYieldPercent(scaledStart)),
            1e-9,
            "CASE 13 same signal from pct and 10x raw series"
        );
        console.log("CASE 13 us10y bp signals:", JSON.stringify(bpTable));
    }

    // CASE 14 — news API key missing: no HTTP, explicit unavailable reason
    {
        const result = await fetchCryptoNewsReading(4_000, Date.now(), 6, 2, new Set(), null);
        assertTrue(result.reading === null, "CASE 14 no reading without key");
        assertTrue(result.error === "NEWS_API_KEY_NOT_CONFIGURED", "CASE 14 explicit reason");
        assertTrue(result.skipped === true, "CASE 14 skipped fetch");
        const assembled = await assembleExternalMarketSnapshot({
            config: { ...baseFetchConfig(), newsApiKey: null, fetchTimeoutMs: 1 },
            now: Date.now()
        });
        assertTrue(assembled.fetchErrors.news === "NEWS_API_KEY_NOT_CONFIGURED", "CASE 14 assemble error");
        assertTrue(assembled.snapshot.unavailableSources.includes("news"), "CASE 14 news unavailable");
    }

    // CASE 15 — signal weight reliability safeguard (not a hard block)
    {
        assertClose(computeExternalSignalReliability(0.2), 0, 1e-9, "CASE 15 reliability below min");
        assertClose(computeExternalSignalReliability(0.35), 0, 1e-9, "CASE 15 reliability at min edge");
        assertClose(computeExternalSignalReliability(0.475), 0.5, 1e-9, "CASE 15 reliability mid band");
        assertClose(computeExternalSignalReliability(0.6), 1, 1e-9, "CASE 15 reliability full");
        assertClose(applySignalReliabilityToMultiplier(1.1, 0), 1, 1e-9, "CASE 15 zero reliability neutral");
        assertClose(applySignalReliabilityToMultiplier(1.1, 0.5), 1.05, 1e-9, "CASE 15 half reliability blend");
        assertClose(applySignalReliabilityToMultiplier(1.1, 1), 1.1, 1e-9, "CASE 15 full reliability raw");

        const now = 1_000_000;
        const lowWeightSnap: ExternalMarketSnapshot = {
            generatedAt: now,
            maxAgeMs: 900_000,
            unavailableSources: ["es", "dxy", "us10y", "news"],
            sources: {
                nq: { value: 20100, signal: 0.95, fetchedAt: now, source: "test:nq" }
            },
            fetchedAt: now,
            status: "partial"
        };
        const lowWeight = evaluateExternalMarketContext({
            side: "long",
            now,
            config: {
                enabled: true,
                shadowMode: false,
                weight: 0.22,
                minSizeMultiplier: 0.8,
                maxSizeMultiplier: 1.1,
                maxAgeMs: 900_000,
                emergencyEventEnabled: false
            },
            snapshot: lowWeightSnap
        });
        assertTrue(lowWeight.signals.availableWeight === 0.25, "CASE 15 low available weight");
        assertClose(lowWeight.externalSignalReliability ?? -1, 0, 1e-9, "CASE 15 zero reliability");
        assertClose(lowWeight.externalSizeMultiplier, 1, 1e-9, "CASE 15 sizing neutral");
        assertTrue(lowWeight.externalContextApplied === false, "CASE 15 not applied");
        assertTrue(
            lowWeight.externalContextReason === "INSUFFICIENT_EXTERNAL_SIGNAL_WEIGHT_FAIL_OPEN",
            "CASE 15 fail-open reason"
        );
        assertTrue((lowWeight.rawLongPreviewMultiplier ?? 1) > 1, "CASE 15 raw preview still computed");
        assertClose(lowWeight.reliabilityAdjustedLongPreviewMultiplier ?? 0, 1, 1e-9, "CASE 15 adjusted preview neutral");

        const midWeightSnap: ExternalMarketSnapshot = {
            generatedAt: now,
            maxAgeMs: 900_000,
            unavailableSources: ["us10y", "news"],
            sources: {
                nq: { value: 20100, signal: 0.7, fetchedAt: now, source: "test:nq" },
                es: { value: 5650, signal: 0.6, fetchedAt: now, source: "test:es" },
                dxy: { value: 103, signal: -0.4, fetchedAt: now, source: "test:dxy" }
            },
            fetchedAt: now,
            status: "partial"
        };
        const midWeight = evaluateExternalMarketContext({
            side: "long",
            now,
            config: {
                enabled: true,
                shadowMode: false,
                weight: 0.22,
                minSizeMultiplier: 0.8,
                maxSizeMultiplier: 1.1,
                maxAgeMs: 900_000,
                emergencyEventEnabled: false
            },
            snapshot: midWeightSnap
        });
        assertTrue(midWeight.signals.availableWeight === 0.65, "CASE 15 mid available weight");
        assertClose(midWeight.externalSignalReliability ?? 0, 1, 1e-9, "CASE 15 full reliability band");
        assertTrue(midWeight.externalContextApplied === true, "CASE 15 mid weight applied");
        assertTrue(
            (midWeight.reliabilityAdjustedLongPreviewMultiplier ?? 0) <= (midWeight.rawLongPreviewMultiplier ?? 2),
            "CASE 15 adjusted <= raw"
        );

        const shadow = evaluateExternalMarketContext({
            side: "long",
            now,
            config: {
                enabled: false,
                shadowMode: true,
                weight: 0.22,
                minSizeMultiplier: 0.8,
                maxSizeMultiplier: 1.1,
                maxAgeMs: 900_000,
                emergencyEventEnabled: false
            },
            snapshot: lowWeightSnap
        });
        const proof = buildExternalMarketContextProofLog("BTCUSDT", shadow, lowWeightSnap, "long");
        assertTrue(proof.external_signal_reliability === 0, "CASE 15 proof reliability");
        assertTrue(proof.raw_preview_multiplier != null, "CASE 15 proof raw preview");
        assertClose(proof.reliability_adjusted_preview_multiplier as number, 1, 1e-9, "CASE 15 proof adjusted preview");
        assertClose(shadow.externalSizeMultiplier, 1, 1e-9, "CASE 15 shadow trading multiplier neutral");
    }

    console.log("external-market-context-fetch-cases: ALL PASS");
}

void runFetchLayerCases().catch((err) => {
    console.error(err);
    process.exit(1);
});
