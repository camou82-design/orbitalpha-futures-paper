export type {
    ExternalMarketContextConfig,
    ExternalMarketContextResult,
    ExternalMarketEconomicEventReading,
    ExternalMarketFetchConfig,
    ExternalMarketSignalBreakdown,
    ExternalMarketSnapshot,
    ExternalMarketSnapshotSources,
    ExternalMarketSourceReading,
    EvaluateExternalMarketContextInput
} from "./types";
export { getExternalMarketContextConfig, getExternalMarketFetchConfig, mapExternalMarketContextConfigFromEngine, mapExternalMarketFetchConfigFromEngine } from "./config";
export {
    applyExternalContextToConfidenceScore,
    buildExternalMarketContextProofLog,
    buildExternalMarketContextShadowProofLog,
    buildSignalBreakdown,
    combineDirectionalAndEventRiskMultipliers,
    computeEventRiskMultiplier,
    computeExternalContextScore,
    computeSizeMultiplierFromAlignment,
    evaluateExternalMarketContext,
    normalizeMomentumSignal,
    normalizeSentimentSignal
} from "./evaluate";
export {
    ExternalMarketContextService,
    getExternalMarketContextService,
    resetExternalMarketContextServiceForTests
} from "./service";
export { assembleExternalMarketSnapshot } from "./fetch/assemble-snapshot";
export { aggregateCryptoNewsSentiment, fetchCryptoNewsReading } from "./fetch/crypto-news";
export { deriveEconomicEventRisk, fetchEconomicCalendarReading } from "./fetch/economic-calendar";
export { fetchWithTimeout } from "./fetch/http-client";
export { fetchAllYahooReadings, fetchYahooChartReading, normalizeTnxToYieldPercent, normalizeUs10yYieldPointChange } from "./fetch/yahoo-chart";
