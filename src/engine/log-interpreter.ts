import fs from "fs";
import readline from "readline";
import path from "path";
import {
    TradeEpisode,
    EpisodeResultLabel,
    EpisodeRecord,
    SymbolSnapshot
} from "./episode-report-schema";
import { MarketSymbol } from "../models/types";

export interface LogInterpreterConfig {
    logDir: string;
    outputDir: string;
}

/**
 * LogInterpreter
 * 
 * raw logs (PAPER_ENTRY_LINE, symbol_snapshot, PAPER_ORDER_FILLED, PAPER_POSITION_CLOSED)
 * => TradeEpisode[]
 */
export class LogInterpreter {
    constructor(private config: LogInterpreterConfig) { }

    /**
     * Parse log files and reconstruct episodes
     */
    async run(logFiles: string[]): Promise<TradeEpisode[]> {
        const episodesByPid = new Map<string, Partial<TradeEpisode>>();
        const orphanedEntries: any[] = [];

        // 1-pass: Accumulate all relevant lines
        for (const file of logFiles) {
            const fullPath = path.resolve(this.config.logDir, file);
            if (!fs.existsSync(fullPath)) continue;

            const fileStream = fs.createReadStream(fullPath);
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });

            for await (const line of rl) {
                try {
                    const parsed = JSON.parse(line);
                    const msg = parsed.msg;
                    const data = parsed; // Assuming pino/winston style or raw JSON

                    if (msg === "PAPER_ENTRY_LINE") {
                        // New potential episode start
                        const ep: Partial<TradeEpisode> = {
                            episodeId: `ep_${data.symbol}_${new Date(parsed.time).getTime()}`,
                            symbol: data.symbol as MarketSymbol,
                            entryTime: new Date(parsed.time).getTime(),
                            regime: data.range_confidence > 0.5 ? "RANGE" : "TREND", // Heuristic if not explicit
                            initialContext: {
                                qualityScore: data.quality_score,
                                signalStrength: data.signal_strength,
                                rangeConfidence: data.range_confidence,
                                boxCohesion: data.box_cohesion,
                                rangeLadderLevel: data.range_ladder_level,
                                entryIntentType: data.entry_intent_type || "standard",
                                probeOnlyMode: data.probe_only_mode
                            },
                            resultLabel: "REJECTED_BEFORE_GATE"
                        };

                        if (data.entry_blocked) {
                            ep.resultLabel = "REJECTED_BY_GATE";
                            // We could still save these as "rejected episodes" for tuner analysis
                            orphanedEntries.push(ep);
                        } else if (data.final_signal !== "none") {
                            // Potential fill coming up
                            // We need a way to link this to a future PID. 
                            // Usually, the next PAPER_ORDER_FILLED for this symbol within a tiny window is the one.
                            orphanedEntries.push({ ...ep, tempKey: `${data.symbol}_${ep.entryTime}` });
                        }
                    }

                    if (msg === "PAPER_ORDER_FILLED") {
                        const pid = data.pid || data.positionId;
                        const symbol = data.symbol;
                        const fillTime = new Date(parsed.time).getTime();

                        // Find closest orphaned entry for this symbol
                        const matchIndex = orphanedEntries.findIndex(o => o.symbol === symbol && Math.abs(o.entryTime - fillTime) < 5000);
                        if (matchIndex !== -1) {
                            const matched = orphanedEntries.splice(matchIndex, 1)[0];
                            episodesByPid.set(pid, {
                                ...matched,
                                positionId: pid,
                                entryPrice: data.price,
                                sizeUsd: data.sizeUsd,
                                resultLabel: "PENDING_EXIT"
                            });
                        }
                    }

                    if (msg === "PAPER_POSITION_CLOSED") {
                        const pid = data.pid || data.positionId;
                        const ep = episodesByPid.get(pid);
                        if (ep) {
                            ep.exitTime = new Date(parsed.time).getTime();
                            ep.exitPrice = data.price;
                            ep.pnlUsd = data.pnlUsd;
                            ep.pnlPct = data.pnlPct;

                            // Classify Result Label
                            ep.resultLabel = this.classifyResult(ep as TradeEpisode, data.closeReason);
                        }
                    }

                } catch (e) {
                    // Skip malformed lines
                }
            }
        }

        // Convert Map to Array + Add orphans (rejections) as they are valuable for Tuner
        const results: TradeEpisode[] = [];
        episodesByPid.forEach((ep) => {
            results.push(ep as TradeEpisode);
        });
        for (const orphan of orphanedEntries) {
            results.push(orphan as TradeEpisode);
        }

        return results;
    }

    private classifyResult(ep: TradeEpisode, closeReason: string): EpisodeResultLabel {
        const isWin = (ep.pnlUsd || 0) > 0;

        if (closeReason === "TAKE_PROFIT" || closeReason === "TP") {
            return isWin ? "GOOD_PROBE" : "EARLY_EXIT"; // TP should be win usually
        }

        if (closeReason === "STOP_LOSS" || closeReason === "SL") {
            return "STOP_LOSS_HIT";
        }

        if (closeReason === "STRUCTURAL_EXIT" || closeReason === "RANGE_EXIT") {
            return isWin ? "STRUCTURAL_WIN" : "STRUCTURAL_LOSS";
        }

        if (closeReason === "BOX_BREAKOUT" || closeReason === "REGIME_ESCAPE") {
            return "FALSE_RANGE_ENTRY";
        }

        return "OTHER_EXIT";
    }
}
