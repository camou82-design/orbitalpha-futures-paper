import { fetchWithTimeout } from "./http-client";
import { normalizeMomentumSignal } from "../evaluate";
import type { ExternalMarketSourceReading } from "../types";

export type YahooChartFetchResult = Readonly<{
    reading: ExternalMarketSourceReading | null;
    error?: string;
}>;

type YahooMomentumMode = "pct" | "yield_points";

const YAHOO_SYMBOLS = {
    nq: { symbol: "NQ=F", source: "yahoo_finance:NQ=F", mode: "pct" as YahooMomentumMode },
    es: { symbol: "ES=F", source: "yahoo_finance:ES=F", mode: "pct" as YahooMomentumMode },
    dxy: { symbol: "DX-Y.NYB", source: "yahoo_finance:DX-Y.NYB", mode: "pct" as YahooMomentumMode },
    us10y: { symbol: "^TNX", source: "yahoo_finance:^TNX", mode: "yield_points" as YahooMomentumMode }
};

/** Yahoo ^TNX may return yield % directly (~4.2) or CBOE 10x scale (~42). */
export function normalizeTnxToYieldPercent(raw: number): number {
    if (!Number.isFinite(raw)) return raw;
    return raw > 10 ? raw / 10 : raw;
}

/** Normalize absolute yield change in percentage points (e.g. 0.05 = +5bp). */
export function normalizeUs10yYieldPointChange(pointChange: number): number {
    return normalizeMomentumSignal(pointChange, 0.15);
}

function computePctMomentum(closes: number[], lookbackBars: number): number | null {
    if (closes.length < 2) return null;
    const end = closes[closes.length - 1];
    const startIdx = Math.max(0, closes.length - 1 - lookbackBars);
    const start = closes[startIdx];
    if (!(start > 0) || !Number.isFinite(end) || !Number.isFinite(start)) return null;
    return ((end - start) / start) * 100;
}

function computeYieldPointChange(closes: number[], lookbackBars: number): number | null {
    if (closes.length < 2) return null;
    const end = normalizeTnxToYieldPercent(closes[closes.length - 1]);
    const startIdx = Math.max(0, closes.length - 1 - lookbackBars);
    const start = normalizeTnxToYieldPercent(closes[startIdx]);
    if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
    return end - start;
}

export async function fetchYahooChartReading(
    key: keyof typeof YAHOO_SYMBOLS,
    timeoutMs: number,
    lookbackBars = 12
): Promise<YahooChartFetchResult> {
    const meta = YAHOO_SYMBOLS[key];
    const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(meta.symbol)}` +
        `?interval=5m&range=1d&includePrePost=false`;
    const res = await fetchWithTimeout(url, timeoutMs);
    if (!res.ok) {
        return { reading: null, error: res.error ?? `HTTP_${res.status}` };
    }
    try {
        const parsed = JSON.parse(res.body) as {
            chart?: { result?: Array<{ meta?: { regularMarketPrice?: number }; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
        };
        const result = parsed.chart?.result?.[0];
        const closesRaw = result?.indicators?.quote?.[0]?.close ?? [];
        const closes = closesRaw.filter((c): c is number => c != null && Number.isFinite(c));
        const lastPriceRaw = result?.meta?.regularMarketPrice ?? closes[closes.length - 1] ?? null;
        const lastPrice =
            meta.mode === "yield_points" && lastPriceRaw != null
                ? normalizeTnxToYieldPercent(lastPriceRaw)
                : lastPriceRaw;
        const momentum =
            meta.mode === "yield_points"
                ? computeYieldPointChange(closes, lookbackBars)
                : computePctMomentum(closes, lookbackBars);
        if (momentum == null || lastPrice == null || !Number.isFinite(lastPrice)) {
            return { reading: null, error: "PARSE_EMPTY_SERIES" };
        }
        const signal =
            meta.mode === "yield_points"
                ? normalizeUs10yYieldPointChange(momentum)
                : normalizeMomentumSignal(momentum, 2);
        return {
            reading: {
                value: lastPrice,
                signal,
                fetchedAt: Date.now(),
                source: meta.source,
                rawUnit: meta.mode === "yield_points" ? "yield_pct" : "usd",
                confidence: 1
            }
        };
    } catch (err) {
        return { reading: null, error: err instanceof Error ? err.message : String(err) };
    }
}

export async function fetchAllYahooReadings(
    timeoutMs: number
): Promise<Record<keyof typeof YAHOO_SYMBOLS, YahooChartFetchResult>> {
    const keys = Object.keys(YAHOO_SYMBOLS) as Array<keyof typeof YAHOO_SYMBOLS>;
    const results = await Promise.all(
        keys.map(async (key) => [key, await fetchYahooChartReading(key, timeoutMs)] as const)
    );
    return Object.fromEntries(results) as Record<keyof typeof YAHOO_SYMBOLS, YahooChartFetchResult>;
}
