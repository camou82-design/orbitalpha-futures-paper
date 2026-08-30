import { fetchWithTimeout } from "./http-client";
import type { ExternalMarketEconomicEventReading } from "../types";

const HIGH_IMPACT_KEYWORDS = [
    "cpi",
    "pce",
    "fomc",
    "fed",
    "nfp",
    "non-farm",
    "nonfarm",
    "gdp",
    "ppi",
    "interest rate"
];

type FfCalendarEvent = {
    title?: string;
    country?: string;
    date?: string;
    impact?: string;
    forecast?: string;
    previous?: string;
};

export type EconomicCalendarFetchResult = Readonly<{
    reading: ExternalMarketEconomicEventReading | null;
    newsEventRisk: number;
    error?: string;
}>;

function parseEventTs(dateRaw: string | undefined, now: number): number | null {
    if (!dateRaw) return null;
    const ts = Date.parse(dateRaw);
    return Number.isFinite(ts) ? ts : null;
}

function isHighImpactUsEvent(ev: FfCalendarEvent): boolean {
    const country = String(ev.country ?? "").toUpperCase();
    if (country !== "USD" && country !== "US") return false;
    const impact = String(ev.impact ?? "").toLowerCase();
    if (impact.includes("high") || impact.includes("holiday")) {
        const title = String(ev.title ?? "").toLowerCase();
        return HIGH_IMPACT_KEYWORDS.some((k) => title.includes(k));
    }
    const title = String(ev.title ?? "").toLowerCase();
    return HIGH_IMPACT_KEYWORDS.some((k) => title.includes(k));
}

export function deriveEconomicEventRisk(hoursUntil: number | null): number {
    if (hoursUntil == null || !Number.isFinite(hoursUntil)) return 0;
    const abs = Math.abs(hoursUntil);
    if (abs <= 0.5) return 0.85;
    if (abs <= 2) return 0.65;
    if (abs <= 6) return 0.45;
    if (abs <= 24) return 0.25;
    return 0;
}

export async function fetchEconomicCalendarReading(
    timeoutMs: number,
    now = Date.now()
): Promise<EconomicCalendarFetchResult> {
    const url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
    const res = await fetchWithTimeout(url, timeoutMs);
    if (!res.ok) {
        return { reading: null, newsEventRisk: 0, error: res.error ?? `HTTP_${res.status}` };
    }
    try {
        const events = JSON.parse(res.body) as FfCalendarEvent[];
        if (!Array.isArray(events)) {
            return { reading: null, newsEventRisk: 0, error: "PARSE_NOT_ARRAY" };
        }
        let nearest: { ev: FfCalendarEvent; ts: number; hoursUntil: number } | null = null;
        for (const ev of events) {
            if (!isHighImpactUsEvent(ev)) continue;
            const ts = parseEventTs(ev.date, now);
            if (ts == null) continue;
            const hoursUntil = (ts - now) / 3_600_000;
            if (Math.abs(hoursUntil) > 48) continue;
            if (nearest == null || Math.abs(hoursUntil) < Math.abs(nearest.hoursUntil)) {
                nearest = { ev, ts, hoursUntil };
            }
        }
        if (nearest == null) {
            return {
                reading: {
                    value: "none_imminent",
                    signal: 0,
                    fetchedAt: now,
                    source: "forex_factory_calendar",
                    label: null,
                    imminent: false,
                    hoursUntil: null,
                    confidence: 1
                },
                newsEventRisk: 0
            };
        }
        const risk = deriveEconomicEventRisk(nearest.hoursUntil);
        const imminent = Math.abs(nearest.hoursUntil) <= 6;
        return {
            reading: {
                value: nearest.ev.title ?? "economic_event",
                signal: 0,
                fetchedAt: now,
                source: "forex_factory_calendar",
                label: nearest.ev.title ?? null,
                imminent,
                hoursUntil: nearest.hoursUntil,
                confidence: 1
            },
            newsEventRisk: risk
        };
    } catch (err) {
        return {
            reading: null,
            newsEventRisk: 0,
            error: err instanceof Error ? err.message : String(err)
        };
    }
}
