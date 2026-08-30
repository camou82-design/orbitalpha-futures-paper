import { fetchEconomicCalendarReading, type EconomicCalendarFetchResult } from "./economic-calendar";
import type { ExternalMarketEconomicEventReading } from "../types";

export type EconomicEventSourceStatus = "live" | "cached" | "unavailable";

export type EconomicCalendarResolved = Readonly<{
    reading: ExternalMarketEconomicEventReading | null;
    newsEventRisk: number;
    sourceStatus: EconomicEventSourceStatus;
    fetchError?: string;
    cacheAgeMs?: number | null;
    nextFetchAt?: number | null;
}>;

export type EconomicCalendarManagerConfig = Readonly<{
    fetchTimeoutMs: number;
    fetchIntervalMs: number;
    cacheMaxAgeMs: number;
}>;

export type EconomicCalendarFetchFn = (
    timeoutMs: number,
    now: number
) => Promise<EconomicCalendarFetchResult>;

type CalendarCacheEntry = Readonly<{
    reading: ExternalMarketEconomicEventReading;
    newsEventRisk: number;
    fetchedAt: number;
}>;

const MAX_BACKOFF_LEVEL = 2;

function isTemporaryFetchFailure(error: string | undefined): boolean {
    if (!error) return false;
    if (error.includes("429")) return true;
    if (error.includes("TIMEOUT") || error.includes("timeout") || error.includes("AbortError")) return true;
    if (/HTTP_5\d\d/.test(error)) return true;
    return error === "FETCH_FAILED" || error.startsWith("HTTP_0");
}

export class EconomicCalendarManager {
    private cache: CalendarCacheEntry | null = null;
    private backoffLevel = 0;
    private lastFetchError: string | undefined;
    private lastFetchAttemptAt: number | null = null;
    private lastSuccessAt: number | null = null;
    private nextFetchAt: number | null = null;
    private readonly fetchFn: EconomicCalendarFetchFn;

    constructor(
        private readonly config: EconomicCalendarManagerConfig,
        fetchFn: EconomicCalendarFetchFn = fetchEconomicCalendarReading
    ) {
        this.fetchFn = fetchFn;
    }

    getBackoffLevel(): number {
        return this.backoffLevel;
    }

    getNextFetchAt(): number | null {
        return this.nextFetchAt;
    }

    getLastFetchError(): string | undefined {
        return this.lastFetchError;
    }

    getCacheAgeMs(now: number): number | null {
        if (this.cache == null) return null;
        return Math.max(0, now - this.cache.fetchedAt);
    }

    private backoffIntervalMs(): number {
        return this.config.fetchIntervalMs * Math.pow(2, this.backoffLevel);
    }

    private isCacheValid(now: number): boolean {
        if (this.cache == null) return false;
        return now - this.cache.fetchedAt <= this.config.cacheMaxAgeMs;
    }

    shouldAttemptFetch(now: number): boolean {
        if (this.nextFetchAt != null && now < this.nextFetchAt) return false;
        if (this.lastSuccessAt == null && this.cache == null) return true;
        const anchor = this.lastSuccessAt ?? this.lastFetchAttemptAt ?? 0;
        return now - anchor >= this.config.fetchIntervalMs;
    }

    private fromCache(now: number, fetchError?: string): EconomicCalendarResolved {
        const cacheAgeMs = this.getCacheAgeMs(now);
        return {
            reading: this.cache!.reading,
            newsEventRisk: this.cache!.newsEventRisk,
            sourceStatus: "cached",
            fetchError,
            cacheAgeMs,
            nextFetchAt: this.nextFetchAt
        };
    }

    private scheduleAfterFailure(now: number, error: string | undefined): void {
        if (error?.includes("429")) {
            this.backoffLevel = Math.min(MAX_BACKOFF_LEVEL, this.backoffLevel + 1);
            this.nextFetchAt = now + this.backoffIntervalMs();
            return;
        }
        this.nextFetchAt = now + this.config.fetchIntervalMs;
    }

    async resolve(now: number): Promise<EconomicCalendarResolved> {
        if (this.shouldAttemptFetch(now)) {
            this.lastFetchAttemptAt = now;
            const result = await this.fetchFn(this.config.fetchTimeoutMs, now);
            if (result.reading != null && !result.error) {
                this.cache = {
                    reading: result.reading,
                    newsEventRisk: result.newsEventRisk,
                    fetchedAt: now
                };
                this.lastSuccessAt = now;
                this.backoffLevel = 0;
                this.lastFetchError = undefined;
                this.nextFetchAt = now + this.config.fetchIntervalMs;
                return {
                    reading: result.reading,
                    newsEventRisk: result.newsEventRisk,
                    sourceStatus: "live",
                    cacheAgeMs: 0,
                    nextFetchAt: this.nextFetchAt
                };
            }

            this.lastFetchError = result.error ?? "UNAVAILABLE";
            if (isTemporaryFetchFailure(this.lastFetchError) && this.isCacheValid(now)) {
                this.scheduleAfterFailure(now, this.lastFetchError);
                return this.fromCache(now, this.lastFetchError);
            }

            this.scheduleAfterFailure(now, this.lastFetchError);
            if (this.isCacheValid(now)) {
                return this.fromCache(now, this.lastFetchError);
            }

            return {
                reading: null,
                newsEventRisk: 0,
                sourceStatus: "unavailable",
                fetchError: this.lastFetchError,
                cacheAgeMs: null,
                nextFetchAt: this.nextFetchAt
            };
        }

        if (this.isCacheValid(now) && this.cache != null) {
            return {
                reading: this.cache.reading,
                newsEventRisk: this.cache.newsEventRisk,
                sourceStatus: "cached",
                fetchError: this.lastFetchError,
                cacheAgeMs: this.getCacheAgeMs(now),
                nextFetchAt: this.nextFetchAt
            };
        }

        return {
            reading: null,
            newsEventRisk: 0,
            sourceStatus: "unavailable",
            fetchError: this.lastFetchError ?? (this.cache != null ? "CACHE_STALE" : undefined),
            cacheAgeMs: this.getCacheAgeMs(now),
            nextFetchAt: this.nextFetchAt
        };
    }
}

export function resetEconomicCalendarManagerForTests(): void {
    /* tests construct fresh managers */
}
