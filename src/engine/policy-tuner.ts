import {
    TradeEpisode,
    PolicyTuningReport,
    TuningSuggestion,
    EpisodeResultLabel
} from "./episode-report-schema";

export interface PolicyTunerConfig {
    minEpisodeCountForAnalysis: number;
}

/**
 * PolicyTuner
 * 
 * TradeEpisode[] => PolicyTuningReport
 */
export class PolicyTuner {
    constructor(private config: PolicyTunerConfig) { }

    generateReport(episodes: TradeEpisode[]): PolicyTuningReport {
        const report: PolicyTuningReport = {
            generatedAt: Date.now(),
            periodStart: Math.min(...episodes.map(e => e.entryTime)),
            periodEnd: Math.max(...episodes.map(e => e.entryTime || e.exitTime || 0)),
            totalEpisodes: episodes.length,
            winRate: this.calculateWinRate(episodes),
            suggestions: [],
            metrics: {
                probeConversionRate: this.calculateConversionRate(episodes, "probe", "standard"),
                avgPnlByRegime: this.calculateAvgPnlByRegime(episodes),
                rejectionRateByGate: this.calculateRejectionRate(episodes)
            }
        };

        report.suggestions = this.generateSuggestions(episodes, report.metrics);

        return report;
    }

    private calculateWinRate(episodes: TradeEpisode[]): number {
        const finished = episodes.filter(e => e.exitTime && e.pnlUsd !== undefined);
        if (finished.length === 0) return 0;
        const wins = finished.filter(e => e.pnlUsd! > 0).length;
        return wins / finished.length;
    }

    private calculateConversionRate(episodes: TradeEpisode[], from: string, to: string): number {
        const fromCount = episodes.filter(e => e.initialContext?.entryIntentType === from).length;
        if (fromCount === 0) return 0;
        // In current engine, "conversion" is implicit if a position stays open and reaches next ladder level
        // For now, we compare counts of different intents as a proxy of engine activity
        const toCount = episodes.filter(e => e.initialContext?.entryIntentType === to).length;
        return toCount / fromCount; // This is a heuristic proxy
    }

    private calculateAvgPnlByRegime(episodes: TradeEpisode[]): Record<string, number> {
        const regimes = ["RANGE", "TREND"];
        const result: Record<string, number> = {};
        for (const r of regimes) {
            const filtered = episodes.filter(e => e.regime === r && e.pnlUsd !== undefined);
            if (filtered.length === 0) {
                result[r] = 0;
                continue;
            }
            const sum = filtered.reduce((acc, e) => acc + (e.pnlUsd || 0), 0);
            result[r] = sum / filtered.length;
        }
        return result;
    }

    private calculateRejectionRate(episodes: TradeEpisode[]): Record<string, number> {
        const rejections = episodes.filter(e => e.resultLabel === "REJECTED_BY_GATE" || e.resultLabel === "REJECTED_BEFORE_GATE");
        if (episodes.length === 0) return {};
        return {
            total: rejections.length / episodes.length
        };
    }

    private generateSuggestions(episodes: TradeEpisode[], metrics: any): TuningSuggestion[] {
        const suggestions: TuningSuggestion[] = [];

        // 1. Probe Strategy Check (Original Highway Pullback)
        const probeEpisodes = episodes.filter(e => e.initialContext?.entryIntentType === "probe");
        const probeWinRate = this.calculateWinRate(probeEpisodes);
        if (probeEpisodes.length > 5 && probeWinRate < 0.35) {
            suggestions.push({
                parameter: "highwayValidityScore / pullbackQualityScore",
                currentValue: "unknown",
                suggestedValue: "Tighten (+0.1~0.2)",
                reason: `Probe win rate is too low (${(probeWinRate * 100).toFixed(1)}%). Likely entering weak pullbacks against the EMA trend.`,
                confidence: 0.7
            });
        }

        // 2. Structural Failure Check (Original Highway Exhaustion)
        const falseRangeEntries = episodes.filter(e => e.resultLabel === "LATE_SCALE" || e.resultLabel === "STRUCTURAL_LOSS");
        if (falseRangeEntries.length > episodes.length * 0.2) {
            suggestions.push({
                parameter: "trendExhaustionScore",
                currentValue: "current",
                suggestedValue: "Increase sensitivity for scaling",
                reason: "Too many scale entries ended in trend exhaustion or structural loss. Reduce scale magnitude when trendExhaustionScore is high.",
                confidence: 0.8
            });
        }

        // 3. Under-trading Check
        if (episodes.length < 5 && metrics.metrics?.avgPnlByRegime?.RANGE > 0) {
            suggestions.push({
                parameter: "ENTRY_MIN_SCORE",
                currentValue: "35 (current stage 1)",
                suggestedValue: "Maintain or slightly lower for BTC only",
                reason: "Profitable RANGE performance but low sample size. Explore higher frequency for discovery.",
                confidence: 0.6
            });
        }

        return suggestions;
    }
}
