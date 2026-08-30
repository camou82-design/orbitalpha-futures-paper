import type { ExternalMarketContextConfig } from "./types";

function parseBool(v: string | undefined, fallback: boolean): boolean {
    if (v === undefined) return fallback;
    const x = v.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(x)) return true;
    if (["0", "false", "no", "n", "off"].includes(x)) return false;
    return fallback;
}

function parseNumber(v: string | undefined, fallback: number): number {
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, n));
}

export function getExternalMarketContextConfig(
    env: NodeJS.ProcessEnv = process.env
): ExternalMarketContextConfig {
    const enabled = parseBool(env.EXTERNAL_MARKET_CONTEXT_ENABLED, false);
    const shadowMode = parseBool(env.EXTERNAL_MARKET_CONTEXT_SHADOW_MODE, true);
    const weight = clamp(parseNumber(env.EXTERNAL_MARKET_CONTEXT_WEIGHT, 0.22), 0, 0.5);
    const minSizeMultiplier = clamp(parseNumber(env.EXTERNAL_MARKET_MIN_SIZE_MULTIPLIER, 0.8), 0.5, 1);
    const maxSizeMultiplier = clamp(parseNumber(env.EXTERNAL_MARKET_MAX_SIZE_MULTIPLIER, 1.1), 1, 1.5);
    const maxAgeMs = clamp(parseNumber(env.EXTERNAL_MARKET_CONTEXT_MAX_AGE_MS, 900_000), 60_000, 3_600_000);
    const emergencyEventEnabled = parseBool(env.EXTERNAL_MARKET_EMERGENCY_EVENT_ENABLED, false);
    return {
        enabled,
        shadowMode,
        weight,
        minSizeMultiplier,
        maxSizeMultiplier,
        maxAgeMs,
        emergencyEventEnabled
    };
}

export function getExternalMarketFetchConfig(env: NodeJS.ProcessEnv = process.env) {
    const fetchEnabled = parseBool(env.EXTERNAL_MARKET_CONTEXT_FETCH_ENABLED, false);
    const fetchIntervalMs = clamp(parseNumber(env.EXTERNAL_MARKET_CONTEXT_FETCH_INTERVAL_MS, 120_000), 30_000, 900_000);
    const fetchTimeoutMs = clamp(parseNumber(env.EXTERNAL_MARKET_CONTEXT_FETCH_TIMEOUT_MS, 4_000), 500, 15_000);
    const maxAgeMs = clamp(parseNumber(env.EXTERNAL_MARKET_CONTEXT_MAX_AGE_MS, 900_000), 60_000, 3_600_000);
    const newsMaxAgeHours = clamp(parseNumber(env.EXTERNAL_MARKET_CONTEXT_NEWS_MAX_AGE_HOURS, 6), 1, 48);
    const newsHalfLifeHours = clamp(parseNumber(env.EXTERNAL_MARKET_CONTEXT_NEWS_HALF_LIFE_HOURS, 2), 0.5, 24);
    const newsMaxWeight = clamp(parseNumber(env.EXTERNAL_MARKET_CONTEXT_NEWS_MAX_WEIGHT, 0.15), 0.05, 0.15);
    const newsApiKey = String(env.EXTERNAL_MARKET_CONTEXT_NEWS_API_KEY ?? "").trim() || null;
    return {
        fetchEnabled,
        fetchIntervalMs,
        fetchTimeoutMs,
        maxAgeMs,
        newsMaxAgeHours,
        newsHalfLifeHours,
        newsMaxWeight,
        newsApiKey
    };
}

export function mapExternalMarketContextConfigFromEngine(config: {
    externalMarketContextEnabled?: boolean;
    externalMarketContextShadowMode?: boolean;
    externalMarketContextWeight?: number;
    externalMarketMinSizeMultiplier?: number;
    externalMarketMaxSizeMultiplier?: number;
    externalMarketContextMaxAgeMs?: number;
    externalMarketEmergencyEventEnabled?: boolean;
}): ExternalMarketContextConfig {
    return {
        enabled: config.externalMarketContextEnabled === true,
        shadowMode: config.externalMarketContextShadowMode !== false,
        weight: config.externalMarketContextWeight ?? 0.22,
        minSizeMultiplier: config.externalMarketMinSizeMultiplier ?? 0.8,
        maxSizeMultiplier: config.externalMarketMaxSizeMultiplier ?? 1.1,
        maxAgeMs: config.externalMarketContextMaxAgeMs ?? 900_000,
        emergencyEventEnabled: config.externalMarketEmergencyEventEnabled === true
    };
}

export function mapExternalMarketFetchConfigFromEngine(config: {
    externalMarketContextFetchEnabled?: boolean;
    externalMarketContextFetchIntervalMs?: number;
    externalMarketContextFetchTimeoutMs?: number;
    externalMarketContextMaxAgeMs?: number;
    externalMarketContextNewsMaxAgeHours?: number;
    externalMarketContextNewsHalfLifeHours?: number;
    externalMarketContextNewsMaxWeight?: number;
    externalMarketContextNewsApiKey?: string | null;
}): import("./types").ExternalMarketFetchConfig {
    return {
        fetchEnabled: config.externalMarketContextFetchEnabled === true,
        fetchIntervalMs: config.externalMarketContextFetchIntervalMs ?? 120_000,
        fetchTimeoutMs: config.externalMarketContextFetchTimeoutMs ?? 4_000,
        maxAgeMs: config.externalMarketContextMaxAgeMs ?? 900_000,
        newsMaxAgeHours: config.externalMarketContextNewsMaxAgeHours ?? 6,
        newsHalfLifeHours: config.externalMarketContextNewsHalfLifeHours ?? 2,
        newsMaxWeight: config.externalMarketContextNewsMaxWeight ?? 0.15,
        newsApiKey: config.externalMarketContextNewsApiKey ?? null
    };
}
