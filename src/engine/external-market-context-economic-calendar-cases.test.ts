import {
    assembleExternalMarketSnapshot,
    EconomicCalendarManager,
    ExternalMarketContextService,
    resetExternalMarketContextServiceForTests
} from "../engine-v2/external-market-context";
import type { EconomicCalendarFetchResult } from "../engine-v2/external-market-context/fetch/economic-calendar";

function assertTrue(cond: boolean, msg: string): void {
    if (!cond) throw new Error(msg);
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
    if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

const HOUR = 3_600_000;

function managerConfig(overrides?: Partial<{ fetchIntervalMs: number; cacheMaxAgeMs: number }>) {
    return {
        fetchTimeoutMs: 4_000,
        fetchIntervalMs: overrides?.fetchIntervalMs ?? HOUR,
        cacheMaxAgeMs: overrides?.cacheMaxAgeMs ?? 4 * HOUR
    };
}

function successResult(title: string, now: number, risk = 0.25): EconomicCalendarFetchResult {
    return {
        reading: {
            value: title,
            signal: 0,
            fetchedAt: now,
            source: "forex_factory_calendar",
            label: title,
            imminent: false,
            hoursUntil: 12,
            confidence: 1
        },
        newsEventRisk: risk
    };
}

async function runEconomicCalendarCases(): Promise<void> {
    // CASE A — normal calendar fetch
    {
        const now = 1_000_000;
        let calls = 0;
        const mgr = new EconomicCalendarManager(managerConfig(), async () => {
            calls += 1;
            return successResult("US CPI", now, 0.45);
        });
        const resolved = await mgr.resolve(now);
        assertEq(resolved.sourceStatus, "live", "CASE A live status");
        assertTrue(resolved.reading != null, "CASE A reading");
        assertEq(resolved.newsEventRisk, 0.45, "CASE A risk");
        assertEq(calls, 1, "CASE A one fetch");
    }

    // CASE B — HTTP_429 with valid cache continues using cached data
    {
        const now = 2_000_000;
        let calls = 0;
        const mgr = new EconomicCalendarManager(managerConfig(), async () => {
            calls += 1;
            if (calls === 1) return successResult("FOMC", now - 30 * 60_000, 0.65);
            return { reading: null, newsEventRisk: 0, error: "HTTP_429" };
        });
        const first = await mgr.resolve(now - HOUR);
        assertEq(first.sourceStatus, "live", "CASE B seed live");
        const second = await mgr.resolve(now);
        assertEq(second.sourceStatus, "cached", "CASE B cached after 429");
        assertEq(second.fetchError, "HTTP_429", "CASE B 429 error recorded");
        assertTrue(second.reading != null, "CASE B cached reading kept");
        assertTrue((second.cacheAgeMs ?? 0) > 0, "CASE B cache age");
    }

    // CASE C — HTTP_429 without cache → unavailable
    {
        const now = 3_000_000;
        const mgr = new EconomicCalendarManager(managerConfig(), async () => ({
            reading: null,
            newsEventRisk: 0,
            error: "HTTP_429"
        }));
        const resolved = await mgr.resolve(now);
        assertEq(resolved.sourceStatus, "unavailable", "CASE C unavailable");
        assertTrue(resolved.reading == null, "CASE C no reading");
        assertEq(resolved.fetchError, "HTTP_429", "CASE C error");
    }

    // CASE D — stale cache fail-open
    {
        const now = 10_000_000;
        const cacheMaxAgeMs = 2 * HOUR;
        let calls = 0;
        const mgr = new EconomicCalendarManager(
            managerConfig({ cacheMaxAgeMs, fetchIntervalMs: HOUR }),
            async () => {
                calls += 1;
                if (calls === 1) return successResult("NFP", now - 5 * HOUR, 0.25);
                return { reading: null, newsEventRisk: 0, error: "HTTP_429" };
            }
        );
        await mgr.resolve(now - 5 * HOUR);
        const resolved = await mgr.resolve(now);
        assertEq(resolved.sourceStatus, "unavailable", "CASE D stale unavailable");
        assertTrue(resolved.reading == null, "CASE D no stale reading used");
    }

    // CASE E — exponential backoff increases 1h → 2h → 4h
    {
        const now = 20_000_000;
        let calls = 0;
        const mgr = new EconomicCalendarManager(managerConfig(), async () => {
            calls += 1;
            if (calls === 1) return successResult("PCE", now, 0.35);
            return { reading: null, newsEventRisk: 0, error: "HTTP_429" };
        });
        await mgr.resolve(now);
        await mgr.resolve(now + HOUR);
        assertEq(mgr.getBackoffLevel(), 1, "CASE E backoff level 1");
        assertEq(mgr.getNextFetchAt(), now + HOUR + 2 * HOUR, "CASE E 2h backoff");
        await mgr.resolve(now + 3 * HOUR);
        assertEq(mgr.getBackoffLevel(), 2, "CASE E backoff level 2");
        assertEq(mgr.getNextFetchAt(), now + 3 * HOUR + 4 * HOUR, "CASE E 4h backoff");
    }

    // CASE F — successful recovery resets backoff
    {
        const now = 30_000_000;
        let calls = 0;
        const mgr = new EconomicCalendarManager(managerConfig(), async () => {
            calls += 1;
            if (calls === 1) return successResult("CPI", now, 0.5);
            if (calls === 2) return { reading: null, newsEventRisk: 0, error: "HTTP_429" };
            return successResult("CPI", now + 2 * HOUR, 0.5);
        });
        await mgr.resolve(now);
        await mgr.resolve(now + HOUR);
        assertEq(mgr.getBackoffLevel(), 1, "CASE F backoff after 429");
        const recovered = await mgr.resolve(now + 3 * HOUR);
        assertEq(recovered.sourceStatus, "live", "CASE F recovery live");
        assertEq(mgr.getBackoffLevel(), 0, "CASE F backoff reset");
        assertEq(mgr.getNextFetchAt(), now + 3 * HOUR + HOUR, "CASE F base interval restored");
    }

    // CASE G — assemble integrates cached calendar metadata
    {
        const now = 40_000_000;
        const assembled = await assembleExternalMarketSnapshot({
            config: {
                fetchEnabled: true,
                fetchIntervalMs: 120_000,
                fetchTimeoutMs: 1,
                maxAgeMs: 900_000,
                newsMaxAgeHours: 6,
                newsHalfLifeHours: 2,
                newsMaxWeight: 0.15,
                newsApiKey: null,
                economicCalendarFetchIntervalMs: HOUR,
                economicCalendarCacheMaxAgeMs: 4 * HOUR
            },
            now,
            calendarResolved: {
                reading: successResult("FOMC", now).reading,
                newsEventRisk: 0.65,
                sourceStatus: "cached",
                fetchError: "HTTP_429",
                cacheAgeMs: 1_800_000,
                nextFetchAt: now + HOUR
            }
        });
        assertTrue(!assembled.snapshot.unavailableSources.includes("economicEvent"), "CASE G event available");
        assertEq(assembled.snapshot.economicEventSourceStatus, "cached", "CASE G cached status");
        assertEq(assembled.fetchErrors.economicEvent, "HTTP_429", "CASE G fetch error preserved");
        assertEq(assembled.snapshot.economicEventCacheAgeMs, 1_800_000, "CASE G cache age");
    }

    // CASE H — service touch remains non-blocking
    {
        resetExternalMarketContextServiceForTests();
        const svc = new ExternalMarketContextService({
            fetchEnabled: true,
            fetchIntervalMs: 120_000,
            fetchTimeoutMs: 4_000,
            maxAgeMs: 900_000,
            newsMaxAgeHours: 6,
            newsHalfLifeHours: 2,
            newsMaxWeight: 0.15,
            newsApiKey: null,
            economicCalendarFetchIntervalMs: HOUR,
            economicCalendarCacheMaxAgeMs: 4 * HOUR
        });
        const t0 = Date.now();
        const cached = svc.touch(t0);
        const state = svc.getState(t0);
        assertTrue(cached === null, "CASE H empty cache initially");
        assertTrue(state.fetchInFlight === true || state.lastFetchStartedAt != null, "CASE H background fetch");
    }

    console.log("external-market-context-economic-calendar-cases: ALL PASS");
}

void runEconomicCalendarCases().catch((err) => {
    console.error(err);
    process.exit(1);
});
