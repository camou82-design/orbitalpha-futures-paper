"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateRegimeExitPolicy = evaluateRegimeExitPolicy;
exports.stopLossPctForRegime = stopLossPctForRegime;
exports.takeProfitPctForRegime = takeProfitPctForRegime;
function thresholds(regime) {
    switch (regime) {
        case "TREND":
            return {
                tp: 0.0105,
                sl: -0.0105,
                maxHoldMs: 6 * 60 * 60 * 1000,
                trailDrawdown: 0.0038,
                trailMinPnl: 0.0042,
                runnerTp: 0.0075
            };
        case "RANGE":
            return {
                tp: 0.0038,
                sl: -0.0026,
                maxHoldMs: 28 * 60 * 1000,
                trailDrawdown: 0.0018,
                trailMinPnl: 0.0016,
                runnerTp: 0.0028
            };
        case "NO_TRADE":
        default:
            return {
                tp: 0.0035,
                sl: -0.0035,
                maxHoldMs: 20 * 60 * 1000,
                trailDrawdown: 0.0018,
                trailMinPnl: 0.0012,
                runnerTp: 0.0025
            };
    }
}
/**
 * Regime-specific exit policy (paper).
 *
 * Key differences:
 * - RANGE: short TP, tighter SL, short max hold (box mean reversion only)
 * - TREND: longer TP, trailing allowed, and can be closed immediately by a trend break (handled by caller)
 */
function evaluateRegimeExitPolicy(input) {
    const t = thresholds(input.regime);
    const runner = input.exitProfile === "runner" || (input.partialExitStage ?? 0) >= 1;
    let extreme = input.trailingExtreme;
    if (input.side === "long")
        extreme = extreme === undefined ? input.mark : Math.max(extreme, input.mark);
    else
        extreme = extreme === undefined ? input.mark : Math.min(extreme, input.mark);
    const tpLevel = runner ? t.runnerTp : t.tp;
    if (input.pnlPctNet >= tpLevel)
        return { action: "close", reason: "take_profit", trailingExtreme: extreme };
    if (input.pnlPctNet <= t.sl)
        return { action: "close", reason: "stop_loss", trailingExtreme: extreme };
    if (input.holdingMs >= t.maxHoldMs)
        return { action: "close", reason: "time_based_exit", trailingExtreme: extreme };
    const allowTrail = input.regime === "TREND" || (runner && input.regime === "RANGE");
    if (allowTrail && extreme !== undefined && input.pnlPctNet >= t.trailMinPnl) {
        if (input.side === "long" && input.mark <= extreme * (1 - t.trailDrawdown)) {
            return { action: "close", reason: "trailing_stop", trailingExtreme: extreme };
        }
        if (input.side === "short" && input.mark >= extreme * (1 + t.trailDrawdown)) {
            return { action: "close", reason: "trailing_stop", trailingExtreme: extreme };
        }
    }
    return { action: "hold", trailingExtreme: extreme };
}
function stopLossPctForRegime(regime) {
    return thresholds(regime).sl;
}
function takeProfitPctForRegime(regime) {
    return thresholds(regime).tp;
}
