/** Single external data source reading with provenance. */
export type ExternalMarketSourceReading = Readonly<{
    value: number | string | null;
    signal: number;
    fetchedAt: number;
    source: string;
    confidence?: number;
    rawUnit?: string;
}>;

export type ExternalMarketEconomicEventReading = ExternalMarketSourceReading &
    Readonly<{
        label?: string | null;
        imminent?: boolean;
        hoursUntil?: number | null;
    }>;

export type ExternalMarketSnapshotSources = Readonly<{
    nq?: ExternalMarketSourceReading;
    es?: ExternalMarketSourceReading;
    dxy?: ExternalMarketSourceReading;
    us10y?: ExternalMarketSourceReading;
    news?: ExternalMarketSourceReading;
    economicEvent?: ExternalMarketEconomicEventReading;
}>;

/** Assembled external market snapshot — injected via fetch layer or test fixtures. */
export type ExternalMarketSnapshot = Readonly<{
    generatedAt: number;
    maxAgeMs: number;
    unavailableSources: string[];
    sources: ExternalMarketSnapshotSources;
    /** Legacy flat momentum fields (% change style) — derived from sources when present. */
    nqMomentum?: number | null;
    esMomentum?: number | null;
    dxyMomentum?: number | null;
    us10yChange?: number | null;
    newsSentiment?: number | null;
    newsEventRisk?: number | null;
    economicEventImminent?: boolean;
    economicEventLabel?: string | null;
    emergencyEventActive?: boolean;
    /** Overall snapshot timestamp (= generatedAt). */
    fetchedAt?: number | null;
    status?: "ok" | "partial" | "stale" | "error" | "unavailable";
    errorReason?: string | null;
    shadowMode?: boolean;
}>;

export type ExternalMarketSignalBreakdown = Readonly<{
    nqSignal: number;
    esSignal: number;
    dxySignal: number;
    us10ySignal: number;
    newsSignal: number;
    availableWeight: number;
    unavailableSources: string[];
}>;

export type ExternalMarketContextConfig = Readonly<{
    enabled: boolean;
    shadowMode: boolean;
    weight: number;
    minSizeMultiplier: number;
    maxSizeMultiplier: number;
    maxAgeMs: number;
    emergencyEventEnabled: boolean;
}>;

export type ExternalMarketFetchConfig = Readonly<{
    fetchEnabled: boolean;
    fetchIntervalMs: number;
    fetchTimeoutMs: number;
    maxAgeMs: number;
    newsMaxAgeHours: number;
    newsHalfLifeHours: number;
    newsMaxWeight: number;
}>;

export type ExternalMarketContextResult = Readonly<{
    externalContextScore: number;
    sideAlignedScore: number;
    signals: ExternalMarketSignalBreakdown;
    newsEventRisk: number;
    externalSizeMultiplier: number;
    confidenceScoreDelta: number;
    externalContextAgeMs: number | null;
    externalContextApplied: boolean;
    externalContextReason: string;
    failOpen: boolean;
    shadowPreview?: boolean;
    longPreviewMultiplier?: number;
    shortPreviewMultiplier?: number;
    directionalSizeMultiplier?: number;
    eventRiskMultiplier?: number;
}>;

export type EvaluateExternalMarketContextInput = Readonly<{
    side: "long" | "short" | "none";
    now: number;
    config: ExternalMarketContextConfig;
    snapshot?: ExternalMarketSnapshot | null;
}>;
