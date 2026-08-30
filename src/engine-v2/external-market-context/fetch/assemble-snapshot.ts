import { fetchAllYahooReadings } from "./yahoo-chart";
import { fetchCryptoNewsReading } from "./crypto-news";
import type { EconomicCalendarResolved } from "./economic-calendar-manager";
import type { ExternalMarketFetchConfig, ExternalMarketSnapshot } from "../types";

export type AssembleSnapshotInput = Readonly<{
    config: ExternalMarketFetchConfig;
    now?: number;
    seenNewsIds?: Set<string>;
    calendarResolved?: EconomicCalendarResolved;
}>;

export type AssembleSnapshotResult = Readonly<{
    snapshot: ExternalMarketSnapshot;
    fetchErrors: Record<string, string | undefined>;
    elapsedMs: number;
}>;

function legacyMomentumFromReading(
    reading: { value: number | string | null; signal: number; rawUnit?: string } | undefined,
    mode: "pct" | "yield"
): number | null {
    if (!reading) return null;
    if (mode === "yield") {
        return reading.signal * 0.15;
    }
    if (typeof reading.value !== "number" || !(reading.value > 0)) return null;
    return reading.signal * 2;
}

export async function assembleExternalMarketSnapshot(
    input: AssembleSnapshotInput
): Promise<AssembleSnapshotResult> {
    const now = input.now ?? Date.now();
    const startedAt = Date.now();
    const timeoutMs = input.config.fetchTimeoutMs;
    const unavailableSources: string[] = [];
    const fetchErrors: Record<string, string | undefined> = {};

    const [yahoo, news] = await Promise.all([
        fetchAllYahooReadings(timeoutMs),
        fetchCryptoNewsReading(
            timeoutMs,
            now,
            input.config.newsMaxAgeHours,
            input.config.newsHalfLifeHours,
            input.seenNewsIds ?? new Set(),
            input.config.newsApiKey ?? null
        )
    ]);
    const calendar =
        input.calendarResolved ??
        ({
            reading: null,
            newsEventRisk: 0,
            sourceStatus: "unavailable",
            fetchError: "CALENDAR_NOT_RESOLVED"
        } satisfies EconomicCalendarResolved);

    for (const [key, result] of Object.entries(yahoo) as Array<
        [keyof typeof yahoo, (typeof yahoo)[keyof typeof yahoo]]
    >) {
        if (!result.reading) {
            unavailableSources.push(key);
            fetchErrors[key] = result.error ?? "UNAVAILABLE";
        }
    }
    if (!calendar.reading) {
        unavailableSources.push("economicEvent");
        fetchErrors.economicEvent = calendar.fetchError ?? "UNAVAILABLE";
    } else if (calendar.fetchError) {
        fetchErrors.economicEvent = calendar.fetchError;
    }
    if (!news.reading) {
        unavailableSources.push("news");
        fetchErrors.news = news.error ?? "UNAVAILABLE";
    }

    const availableCount = 6 - unavailableSources.length;
    let status: ExternalMarketSnapshot["status"] = "unavailable";
    if (availableCount >= 6) status = "ok";
    else if (availableCount > 0) status = "partial";
    else status = "unavailable";

    const nq = yahoo.nq.reading ?? undefined;
    const es = yahoo.es.reading ?? undefined;
    const dxy = yahoo.dxy.reading ?? undefined;
    const us10y = yahoo.us10y.reading ?? undefined;
    const newsReading = news.reading ?? undefined;
    const economicEvent = calendar.reading ?? undefined;

    const newsEventRisk = Math.max(0, Math.min(1, calendar.newsEventRisk ?? 0));

    const snapshot: ExternalMarketSnapshot = {
        generatedAt: now,
        maxAgeMs: input.config.maxAgeMs,
        unavailableSources,
        sources: {
            nq,
            es,
            dxy,
            us10y,
            news: newsReading,
            economicEvent
        },
        nqMomentum: legacyMomentumFromReading(nq, "pct"),
        esMomentum: legacyMomentumFromReading(es, "pct"),
        dxyMomentum: legacyMomentumFromReading(dxy, "pct"),
        us10yChange: legacyMomentumFromReading(us10y, "yield"),
        newsSentiment: newsReading?.signal ?? null,
        newsEventRisk,
        economicEventImminent: economicEvent?.imminent === true,
        economicEventLabel: economicEvent?.label ?? null,
        economicEventSourceStatus: calendar.sourceStatus,
        economicEventCacheAgeMs: calendar.cacheAgeMs ?? null,
        economicEventNextFetchAt: calendar.nextFetchAt ?? null,
        economicEventFetchError: calendar.fetchError ?? null,
        fetchedAt: now,
        status,
        errorReason: availableCount === 0 ? "ALL_SOURCES_UNAVAILABLE" : undefined
    };

    return {
        snapshot,
        fetchErrors,
        elapsedMs: Date.now() - startedAt
    };
}
