import { fetchWithTimeout } from "./http-client";
import type { ExternalMarketSourceReading } from "../types";

const TRUSTED_NEWS_SOURCES = new Set([
    "coindesk",
    "cointelegraph",
    "decrypt",
    "theblock",
    "cryptoslate",
    "bitcoinmagazine",
    "cryptocompare",
    "reuters",
    "bloomberg"
]);

const BULLISH_WORDS = ["surge", "rally", "approval", "etf inflow", "breakout", "record high", "upgrade", "bullish"];
const BEARISH_WORDS = ["hack", "exploit", "ban", "lawsuit", "sec sue", "crash", "liquidation", "outflow", "bearish", "delist"];

type CryptoCompareNewsItem = {
    id?: string;
    guid?: string;
    published_on?: number;
    title?: string;
    body?: string;
    source_info?: { name?: string };
    categories?: string;
};

export type CryptoNewsFetchResult = Readonly<{
    reading: ExternalMarketSourceReading | null;
    error?: string;
    dedupedCount?: number;
}>;

function sourceConfidence(sourceName: string | undefined): number {
    const normalized = String(sourceName ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "");
    if (!normalized) return 0.2;
    for (const trusted of TRUSTED_NEWS_SOURCES) {
        if (normalized.includes(trusted)) return 0.9;
    }
    return 0.35;
}

function keywordSentiment(text: string): number {
    const lower = text.toLowerCase();
    let score = 0;
    for (const w of BULLISH_WORDS) if (lower.includes(w)) score += 1;
    for (const w of BEARISH_WORDS) if (lower.includes(w)) score -= 1;
    if (score === 0) return 0;
    return Math.max(-1, Math.min(1, score / 3));
}

function decayWeight(ageHours: number, halfLifeHours: number): number {
    if (ageHours <= 0) return 1;
    return Math.pow(0.5, ageHours / Math.max(0.25, halfLifeHours));
}

export function aggregateCryptoNewsSentiment(
    items: CryptoCompareNewsItem[],
    now: number,
    maxAgeHours: number,
    halfLifeHours: number,
    seenIds: Set<string>
): CryptoNewsFetchResult {
    const deduped: CryptoCompareNewsItem[] = [];
    for (const item of items) {
        const id = String(item.id ?? item.guid ?? `${item.published_on}:${item.title}`);
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        deduped.push(item);
    }

    let weighted = 0;
    let totalWeight = 0;
    let topTitle: string | null = null;
    let topWeight = 0;

    for (const item of deduped) {
        const publishedOnSec = item.published_on ?? 0;
        if (!(publishedOnSec > 0)) continue;
        const ageHours = Math.max(0, (now - publishedOnSec * 1000) / 3_600_000);
        if (ageHours > maxAgeHours) continue;
        const categories = String(item.categories ?? "").toUpperCase();
        if (!categories.includes("BTC") && !categories.includes("ETH") && !categories.includes("TRADING") && !categories.includes("REGULATION") && !categories.includes("BLOCKCHAIN")) {
            continue;
        }
        const text = `${item.title ?? ""} ${item.body ?? ""}`;
        const sentiment = keywordSentiment(text);
        if (sentiment === 0) continue;
        const conf = sourceConfidence(item.source_info?.name);
        const w = decayWeight(ageHours, halfLifeHours) * conf;
        weighted += sentiment * w;
        totalWeight += w;
        if (w > topWeight) {
            topWeight = w;
            topTitle = item.title ?? null;
        }
    }

    if (totalWeight <= 0) {
        return {
            reading: {
                value: 0,
                signal: 0,
                fetchedAt: now,
                source: "cryptocompare_news",
                confidence: 0
            },
            dedupedCount: deduped.length
        };
    }

    const signal = Math.max(-1, Math.min(1, weighted / totalWeight));
    return {
        reading: {
            value: signal,
            signal,
            fetchedAt: now,
            source: "cryptocompare_news",
            confidence: Math.min(1, totalWeight / 2)
        },
        dedupedCount: deduped.length
    };
}

export async function fetchCryptoNewsReading(
    timeoutMs: number,
    now = Date.now(),
    maxAgeHours = 6,
    halfLifeHours = 2,
    seenIds: Set<string> = new Set()
): Promise<CryptoNewsFetchResult> {
    const url =
        "https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=BTC,ETH,Trading,Blockchain,Regulation";
    const res = await fetchWithTimeout(url, timeoutMs);
    if (!res.ok) {
        return { reading: null, error: res.error ?? `HTTP_${res.status}` };
    }
    try {
        const parsed = JSON.parse(res.body) as { Data?: CryptoCompareNewsItem[] };
        const items = Array.isArray(parsed.Data) ? parsed.Data : [];
        return aggregateCryptoNewsSentiment(items, now, maxAgeHours, halfLifeHours, seenIds);
    } catch (err) {
        return { reading: null, error: err instanceof Error ? err.message : String(err) };
    }
}
