import type {
    EvaluateExternalMarketContextInput,
    ExternalMarketContextResult,
    ExternalMarketSignalBreakdown,
    ExternalMarketSnapshot
} from "./types";

const SIGNAL_WEIGHTS = {
    nq: 0.25,
    es: 0.2,
    dxy: 0.2,
    us10y: 0.2,
    news: 0.15
} as const;

type SignalKey = keyof typeof SIGNAL_WEIGHTS;

/** Map raw momentum / pct-change style inputs to [-1, +1]. */
export function normalizeMomentumSignal(raw: number | null | undefined, scalePct = 2): number {
    if (raw == null || !Number.isFinite(raw)) return 0;
    return Math.max(-1, Math.min(1, raw / scalePct));
}

/** Map pre-normalized sentiment to [-1, +1]. */
export function normalizeSentimentSignal(raw: number | null | undefined): number {
    if (raw == null || !Number.isFinite(raw)) return 0;
    return Math.max(-1, Math.min(1, raw));
}

function readingSignal(
    snapshot: ExternalMarketSnapshot,
    key: SignalKey
): number | null {
    const fromSource = snapshot.sources?.[key]?.signal;
    if (fromSource != null && Number.isFinite(fromSource)) return fromSource;
    switch (key) {
        case "nq":
            return snapshot.nqMomentum != null ? normalizeMomentumSignal(snapshot.nqMomentum) : null;
        case "es":
            return snapshot.esMomentum != null ? normalizeMomentumSignal(snapshot.esMomentum) : null;
        case "dxy":
            return snapshot.dxyMomentum != null ? normalizeMomentumSignal(snapshot.dxyMomentum) : null;
        case "us10y":
            return snapshot.us10yChange != null ? normalizeMomentumSignal(snapshot.us10yChange, 0.15) : null;
        case "news":
            return snapshot.newsSentiment != null ? normalizeSentimentSignal(snapshot.newsSentiment) : null;
        default:
            return null;
    }
}

export function buildSignalBreakdown(snapshot: ExternalMarketSnapshot): ExternalMarketSignalBreakdown {
    const unavailableSources = [...(snapshot.unavailableSources ?? [])];
    let nqSignal = 0;
    let esSignal = 0;
    let dxySignal = 0;
    let us10ySignal = 0;
    let newsSignal = 0;
    let availableWeight = 0;
    (Object.keys(SIGNAL_WEIGHTS) as SignalKey[]).forEach((key) => {
        const sig = readingSignal(snapshot, key);
        if (sig == null || !Number.isFinite(sig)) {
            if (!unavailableSources.includes(key)) unavailableSources.push(key);
            return;
        }
        availableWeight += SIGNAL_WEIGHTS[key];
        switch (key) {
            case "nq":
                nqSignal = sig;
                break;
            case "es":
                esSignal = sig;
                break;
            case "dxy":
                dxySignal = sig;
                break;
            case "us10y":
                us10ySignal = sig;
                break;
            case "news":
                newsSignal = sig;
                break;
        }
    });

    return { nqSignal, esSignal, dxySignal, us10ySignal, newsSignal, availableWeight, unavailableSources };
}

/**
 * LONG-positive interpretation with weight renormalization for missing sources.
 */
export function computeExternalContextScore(signals: ExternalMarketSignalBreakdown): number | null {
    if (!(signals.availableWeight > 0)) return null;
    const longBias =
        (signals.nqSignal * SIGNAL_WEIGHTS.nq +
            signals.esSignal * SIGNAL_WEIGHTS.es +
            -signals.dxySignal * SIGNAL_WEIGHTS.dxy +
            -signals.us10ySignal * SIGNAL_WEIGHTS.us10y +
            signals.newsSignal * SIGNAL_WEIGHTS.news) /
        signals.availableWeight;
    return Math.max(-1, Math.min(1, longBias));
}

/** Event-risk sizing factor — never zero; scales toward minSizeMultiplier at risk=1. */
export function computeEventRiskMultiplier(
    newsEventRisk: number,
    economicEventImminent: boolean | undefined,
    minSizeMultiplier: number
): number {
    const risk = Math.max(0, Math.min(1, newsEventRisk));
    if (risk <= 0) return 1;
    if (!(economicEventImminent === true || risk >= 0.25)) return 1;
    const reduction = risk * (1 - minSizeMultiplier);
    return Math.max(minSizeMultiplier, 1 - reduction);
}

export function combineDirectionalAndEventRiskMultipliers(
    directionalMultiplier: number,
    eventRiskMultiplier: number,
    minSizeMultiplier: number,
    maxSizeMultiplier: number,
    newsEventRisk: number
): number {
    let combined = directionalMultiplier * eventRiskMultiplier;
    if (newsEventRisk >= 0.35) {
        combined = Math.min(combined, 1.0);
    }
    return Math.max(minSizeMultiplier, Math.min(maxSizeMultiplier, combined));
}

export function computeSizeMultiplierFromAlignment(
    sideAlignedScore: number,
    minMultiplier: number,
    maxMultiplier: number
): number {
    const s = Math.max(-1, Math.min(1, sideAlignedScore));
    let mult: number;
    if (s >= 0.5) {
        const t = (s - 0.5) / 0.5;
        mult = 1.05 + t * (maxMultiplier - 1.05);
    } else if (s >= 0.15) {
        const t = (s - 0.15) / 0.35;
        mult = 1.0 + t * (maxMultiplier - 1.0);
    } else if (s > -0.15) {
        mult = 1.0;
    } else if (s > -0.5) {
        const t = (s + 0.15) / -0.35;
        mult = 1.0 - t * (1.0 - Math.max(minMultiplier, 0.95));
    } else {
        const t = (s + 0.5) / -0.5;
        const floor = Math.max(minMultiplier, 0.85 - (0.85 - minMultiplier));
        mult = Math.max(minMultiplier, 0.85 - t * (0.85 - floor));
    }
    return Math.max(minMultiplier, Math.min(maxMultiplier, mult));
}

function neutralResult(reason: string, failOpen: boolean): ExternalMarketContextResult {
    return {
        externalContextScore: 0,
        sideAlignedScore: 0,
        signals: {
            nqSignal: 0,
            esSignal: 0,
            dxySignal: 0,
            us10ySignal: 0,
            newsSignal: 0,
            availableWeight: 0,
            unavailableSources: []
        },
        newsEventRisk: 0,
        externalSizeMultiplier: 1,
        confidenceScoreDelta: 0,
        externalContextAgeMs: null,
        externalContextApplied: false,
        externalContextReason: reason,
        failOpen
    };
}

function computePreviewMultipliers(
    sideAlignedScore: number,
    config: EvaluateExternalMarketContextInput["config"],
    newsEventRisk: number,
    economicEventImminent: boolean | undefined
): {
    longPreviewMultiplier: number;
    shortPreviewMultiplier: number;
    directionalLongMultiplier: number;
    directionalShortMultiplier: number;
    eventRiskMultiplier: number;
} {
    const directionalLongMultiplier = computeSizeMultiplierFromAlignment(
        sideAlignedScore,
        config.minSizeMultiplier,
        config.maxSizeMultiplier
    );
    const directionalShortMultiplier = computeSizeMultiplierFromAlignment(
        -sideAlignedScore,
        config.minSizeMultiplier,
        config.maxSizeMultiplier
    );
    const eventRiskMultiplier = computeEventRiskMultiplier(
        newsEventRisk,
        economicEventImminent,
        config.minSizeMultiplier
    );
    return {
        directionalLongMultiplier,
        directionalShortMultiplier,
        eventRiskMultiplier,
        longPreviewMultiplier: combineDirectionalAndEventRiskMultipliers(
            directionalLongMultiplier,
            eventRiskMultiplier,
            config.minSizeMultiplier,
            config.maxSizeMultiplier,
            newsEventRisk
        ),
        shortPreviewMultiplier: combineDirectionalAndEventRiskMultipliers(
            directionalShortMultiplier,
            eventRiskMultiplier,
            config.minSizeMultiplier,
            config.maxSizeMultiplier,
            newsEventRisk
        )
    };
}

function evaluateCore(
    input: EvaluateExternalMarketContextInput,
    applyToTrading: boolean
): ExternalMarketContextResult {
    const { config, snapshot, side, now } = input;
    if (!snapshot) {
        return neutralResult("SNAPSHOT_UNAVAILABLE_FAIL_OPEN", true);
    }

    if (snapshot.status === "error" || snapshot.status === "unavailable") {
        return neutralResult(snapshot.errorReason ?? `STATUS_${snapshot.status ?? "unknown"}_FAIL_OPEN`, true);
    }

    const ageMs = Math.max(0, now - (snapshot.generatedAt ?? snapshot.fetchedAt ?? now));
    if (ageMs > (snapshot.maxAgeMs ?? config.maxAgeMs)) {
        return neutralResult("SNAPSHOT_STALE_FAIL_OPEN", true);
    }
    if (snapshot.status === "stale") {
        return neutralResult("SNAPSHOT_MARKED_STALE_FAIL_OPEN", true);
    }

    const signalBreakdown = buildSignalBreakdown(snapshot);
    const externalContextScore = computeExternalContextScore(signalBreakdown);
    if (externalContextScore == null) {
        return neutralResult("ALL_SIGNALS_UNAVAILABLE_FAIL_OPEN", true);
    }

    const sideAlignedScore =
        side === "short" ? -externalContextScore : side === "long" ? externalContextScore : 0;

    const newsEventRisk = Math.max(0, Math.min(1, snapshot.newsEventRisk ?? 0));
    const economicEventImminent = snapshot.economicEventImminent === true;
    const directionalMultiplier = computeSizeMultiplierFromAlignment(
        sideAlignedScore,
        config.minSizeMultiplier,
        config.maxSizeMultiplier
    );
    const eventRiskMultiplier = computeEventRiskMultiplier(
        newsEventRisk,
        economicEventImminent,
        config.minSizeMultiplier
    );
    let externalSizeMultiplier = combineDirectionalAndEventRiskMultipliers(
        directionalMultiplier,
        eventRiskMultiplier,
        config.minSizeMultiplier,
        config.maxSizeMultiplier,
        newsEventRisk
    );

    if (config.emergencyEventEnabled && snapshot.emergencyEventActive === true) {
        externalSizeMultiplier *= 0.85;
        externalSizeMultiplier = Math.max(config.minSizeMultiplier, externalSizeMultiplier);
    }

    const externalAsConfidence = ((sideAlignedScore + 1) / 2) * 100;
    const confidenceScoreDelta = externalAsConfidence * config.weight - 50 * config.weight;
    const previews = computePreviewMultipliers(
        externalContextScore,
        config,
        newsEventRisk,
        economicEventImminent
    );

    const shadowPreview = !applyToTrading && config.shadowMode === true;
    if (!applyToTrading) {
        return {
            externalContextScore,
            sideAlignedScore,
            signals: signalBreakdown,
            newsEventRisk,
            externalSizeMultiplier: 1,
            confidenceScoreDelta: shadowPreview ? confidenceScoreDelta : 0,
            externalContextAgeMs: ageMs,
            externalContextApplied: false,
            externalContextReason: shadowPreview ? "SHADOW_OBSERVE_ONLY" : config.enabled ? "NEUTRAL_NO_SIDE" : "FEATURE_DISABLED",
            failOpen: true,
            shadowPreview,
            longPreviewMultiplier: previews.longPreviewMultiplier,
            shortPreviewMultiplier: previews.shortPreviewMultiplier,
            directionalSizeMultiplier: directionalMultiplier,
            eventRiskMultiplier: previews.eventRiskMultiplier
        };
    }

    return {
        externalContextScore,
        sideAlignedScore,
        signals: signalBreakdown,
        newsEventRisk,
        externalSizeMultiplier,
        confidenceScoreDelta,
        externalContextAgeMs: ageMs,
        externalContextApplied: true,
        externalContextReason: side === "none" ? "NEUTRAL_NO_SIDE" : "APPLIED",
        failOpen: false,
        longPreviewMultiplier: previews.longPreviewMultiplier,
        shortPreviewMultiplier: previews.shortPreviewMultiplier,
        directionalSizeMultiplier: directionalMultiplier,
        eventRiskMultiplier: previews.eventRiskMultiplier
    };
}

export function evaluateExternalMarketContext(
    input: EvaluateExternalMarketContextInput
): ExternalMarketContextResult {
    const applyToTrading = input.config.enabled === true && input.config.shadowMode !== true;
    if (!input.config.enabled && input.config.shadowMode !== true) {
        return neutralResult("FEATURE_DISABLED", true);
    }
    return evaluateCore(input, applyToTrading);
}

/** Blend strategy confidence with external context — never blocks entry by itself. */
export function applyExternalContextToConfidenceScore(
    strategyScore: number,
    external: ExternalMarketContextResult,
    weight: number
): number {
    if (!external.externalContextApplied) {
        return strategyScore;
    }
    const strategyWeight = 1 - weight;
    const externalAsScore = ((external.sideAlignedScore + 1) / 2) * 100;
    const blended = strategyScore * strategyWeight + externalAsScore * weight;
    return Math.max(0, Math.min(100, blended));
}

function sourceProofField(
    snapshot: ExternalMarketSnapshot | null | undefined,
    key: keyof ExternalMarketSnapshot["sources"]
): Record<string, unknown> | null {
    const reading = snapshot?.sources?.[key];
    if (!reading) return null;
    return {
        value: reading.value,
        signal: reading.signal,
        fetchedAt: reading.fetchedAt,
        source: reading.source,
        confidence: reading.confidence ?? null
    };
}

export function buildExternalMarketContextProofLog(
    symbol: string,
    external: ExternalMarketContextResult,
    snapshot?: ExternalMarketSnapshot | null
): Record<string, unknown> {
    return {
        event: "EXTERNAL_MARKET_CONTEXT_PROOF",
        symbol,
        external_context_score: external.externalContextScore,
        nq_signal: external.signals.nqSignal,
        es_signal: external.signals.esSignal,
        dxy_signal: external.signals.dxySignal,
        us10y_signal: external.signals.us10ySignal,
        news_signal: external.signals.newsSignal,
        news_event_risk: external.newsEventRisk,
        external_size_multiplier: external.externalSizeMultiplier,
        external_context_age_ms: external.externalContextAgeMs,
        external_context_applied: external.externalContextApplied,
        external_context_reason: external.externalContextReason,
        side_aligned_score: external.sideAlignedScore,
        confidence_score_delta: external.confidenceScoreDelta,
        fail_open: external.failOpen,
        shadow_preview: external.shadowPreview === true,
        long_preview_multiplier: external.longPreviewMultiplier ?? null,
        short_preview_multiplier: external.shortPreviewMultiplier ?? null,
        directional_size_multiplier: external.directionalSizeMultiplier ?? null,
        event_risk_multiplier: external.eventRiskMultiplier ?? null,
        available_signal_weight: external.signals.availableWeight,
        unavailable_sources: external.signals.unavailableSources,
        snapshot_status: snapshot?.status ?? null,
        snapshot_generated_at: snapshot?.generatedAt ?? null,
        raw_sources: snapshot
            ? {
                  nq: sourceProofField(snapshot, "nq"),
                  es: sourceProofField(snapshot, "es"),
                  dxy: sourceProofField(snapshot, "dxy"),
                  us10y: sourceProofField(snapshot, "us10y"),
                  news: sourceProofField(snapshot, "news"),
                  economicEvent: sourceProofField(snapshot, "economicEvent")
              }
            : null
    };
}

export function buildExternalMarketContextShadowProofLog(
    serviceState: {
        snapshot: ExternalMarketSnapshot | null;
        lastFetchElapsedMs: number | null;
        lastFetchErrors: Record<string, string | undefined>;
        fetchInFlight: boolean;
    },
    preview: ExternalMarketContextResult,
    now: number
): Record<string, unknown> {
    return {
        event: "EXTERNAL_MARKET_CONTEXT_SHADOW_PROOF",
        ts: now,
        fetch_in_flight: serviceState.fetchInFlight,
        last_fetch_elapsed_ms: serviceState.lastFetchElapsedMs,
        last_fetch_errors: serviceState.lastFetchErrors,
        snapshot_status: serviceState.snapshot?.status ?? null,
        snapshot_generated_at: serviceState.snapshot?.generatedAt ?? null,
        snapshot_age_ms:
            serviceState.snapshot?.generatedAt != null ? now - serviceState.snapshot.generatedAt : null,
        unavailable_sources: serviceState.snapshot?.unavailableSources ?? [],
        external_context_score: preview.externalContextScore,
        long_preview_multiplier: preview.longPreviewMultiplier ?? null,
        short_preview_multiplier: preview.shortPreviewMultiplier ?? null,
        news_event_risk: preview.newsEventRisk,
        external_context_applied: false,
        trading_impact: "none"
    };
}
