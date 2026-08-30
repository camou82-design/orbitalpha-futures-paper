import { assembleExternalMarketSnapshot } from "./fetch/assemble-snapshot";
import { EconomicCalendarManager } from "./fetch/economic-calendar-manager";
import { getExternalMarketFetchConfig } from "./config";
import type { ExternalMarketFetchConfig, ExternalMarketSnapshot } from "./types";

export type ExternalMarketContextServiceState = Readonly<{
    snapshot: ExternalMarketSnapshot | null;
    lastFetchStartedAt: number | null;
    lastFetchCompletedAt: number | null;
    lastFetchElapsedMs: number | null;
    lastFetchErrors: Record<string, string | undefined>;
    fetchInFlight: boolean;
    economicEventSourceStatus?: string | null;
    economicEventCacheAgeMs?: number | null;
    economicEventNextFetchAt?: number | null;
    economicEventFetchError?: string | null;
}>;

export class ExternalMarketContextService {
    private snapshot: ExternalMarketSnapshot | null = null;
    private lastFetchStartedAt: number | null = null;
    private lastFetchCompletedAt: number | null = null;
    private lastFetchElapsedMs: number | null = null;
    private lastFetchErrors: Record<string, string | undefined> = {};
    private fetchInFlight: Promise<void> | null = null;
    private readonly seenNewsIds = new Set<string>();
    private readonly config: ExternalMarketFetchConfig;
    private readonly calendarManager: EconomicCalendarManager;

    constructor(config?: ExternalMarketFetchConfig) {
        this.config = config ?? getExternalMarketFetchConfig();
        this.calendarManager = new EconomicCalendarManager({
            fetchTimeoutMs: this.config.fetchTimeoutMs,
            fetchIntervalMs: this.config.economicCalendarFetchIntervalMs,
            cacheMaxAgeMs: this.config.economicCalendarCacheMaxAgeMs
        });
    }

    getState(now = Date.now()): ExternalMarketContextServiceState {
        const snap = this.getCachedSnapshot(now);
        return {
            snapshot: snap,
            lastFetchStartedAt: this.lastFetchStartedAt,
            lastFetchCompletedAt: this.lastFetchCompletedAt,
            lastFetchElapsedMs: this.lastFetchElapsedMs,
            lastFetchErrors: { ...this.lastFetchErrors },
            fetchInFlight: this.fetchInFlight != null,
            economicEventSourceStatus: snap?.economicEventSourceStatus ?? null,
            economicEventCacheAgeMs: snap?.economicEventCacheAgeMs ?? null,
            economicEventNextFetchAt: snap?.economicEventNextFetchAt ?? null,
            economicEventFetchError: snap?.economicEventFetchError ?? null
        };
    }

    /** Non-blocking: returns cached snapshot; may trigger background refresh. */
    touch(now = Date.now()): ExternalMarketSnapshot | null {
        if (!this.config.fetchEnabled) return null;
        const cached = this.getCachedSnapshot(now);
        const stale =
            this.lastFetchCompletedAt == null ||
            now - this.lastFetchCompletedAt >= this.config.fetchIntervalMs;
        if (stale && this.fetchInFlight == null) {
            void this.refreshInBackground(now);
        }
        return cached;
    }

    getCachedSnapshot(now = Date.now()): ExternalMarketSnapshot | null {
        if (!this.config.fetchEnabled || this.snapshot == null) return null;
        const ageMs = now - this.snapshot.generatedAt;
        if (ageMs > this.config.maxAgeMs) {
            return {
                ...this.snapshot,
                status: "stale",
                errorReason: "CACHE_STALE"
            };
        }
        return this.snapshot;
    }

    /** Fire-and-forget refresh — never throws to caller. */
    refreshInBackground(now = Date.now()): Promise<void> {
        if (!this.config.fetchEnabled) return Promise.resolve();
        if (this.fetchInFlight != null) return this.fetchInFlight;
        this.lastFetchStartedAt = now;
        this.fetchInFlight = this.runFetch(now)
            .catch(() => {
                /* swallow — observability via lastFetchErrors */
            })
            .finally(() => {
                this.fetchInFlight = null;
            });
        return this.fetchInFlight;
    }

    private async runFetch(now: number): Promise<void> {
        const calendarResolved = await this.calendarManager.resolve(now);
        const result = await assembleExternalMarketSnapshot({
            config: this.config,
            now,
            seenNewsIds: this.seenNewsIds,
            calendarResolved
        });
        this.snapshot = result.snapshot;
        this.lastFetchCompletedAt = now;
        this.lastFetchElapsedMs = result.elapsedMs;
        this.lastFetchErrors = result.fetchErrors;
    }
}

let defaultService: ExternalMarketContextService | null = null;

export function getExternalMarketContextService(
    config?: ExternalMarketFetchConfig
): ExternalMarketContextService {
    if (defaultService == null) {
        defaultService = new ExternalMarketContextService(config);
    }
    return defaultService;
}

export function resetExternalMarketContextServiceForTests(): void {
    defaultService = null;
}
