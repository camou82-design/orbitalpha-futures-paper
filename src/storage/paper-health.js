"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PAPER_HEALTH_LOG_RATIO_MISSING = exports.DEFAULT_HEALTH_THRESHOLDS = void 0;
exports.buildPaperHealthReport = buildPaperHealthReport;
exports.paperHealthStatusLogPayload = paperHealthStatusLogPayload;
exports.paperHealthHistoryJsonlLine = paperHealthHistoryJsonlLine;
/** Default gates for health status (mirrored in `summary-health.json` → `thresholds`). */
exports.DEFAULT_HEALTH_THRESHOLDS = {
    minRecentTrades: 3,
    weakLast30dWinRate: 0.45,
    weakLast7dPnlUsdNet: 0,
    highFeeToPnlRatio: 0.5,
    highFundingToPnlRatio: 0.3
};
const EPS = 1e-9;
function safeRatio(numerator, absPnl) {
    if (!Number.isFinite(numerator) || !Number.isFinite(absPnl) || absPnl <= EPS)
        return null;
    const r = numerator / absPnl;
    return Number.isFinite(r) ? r : null;
}
/** Operational health from `summary-window` (same `generatedAt` as other reports). */
function buildPaperHealthReport(window) {
    const thresholds = { ...exports.DEFAULT_HEALTH_THRESHOLDS };
    const { last7d, last30d, monthToDate, all } = window.windows;
    const absPnlAll = Math.abs(all.totalPnlUsdNet);
    const feeToPnlRatioAll = safeRatio(all.totalFeeUsd, absPnlAll);
    const fundingToPnlRatioAll = safeRatio(Math.abs(all.totalFundingUsd), absPnlAll);
    const metrics = {
        last7dTotalTrades: last7d.totalTrades,
        last7dTotalPnlUsdNet: last7d.totalPnlUsdNet,
        last30dTotalTrades: last30d.totalTrades,
        last30dWinRate: last30d.winRate,
        monthToDateTotalPnlUsdNet: monthToDate.totalPnlUsdNet,
        totalTradesAll: all.totalTrades,
        totalFeeUsdAll: all.totalFeeUsd,
        totalFundingUsdAll: all.totalFundingUsd,
        feeToPnlRatioAll,
        fundingToPnlRatioAll
    };
    const reasons = [];
    // 1. No history
    if (all.totalTrades === 0) {
        reasons.push("trade_count_too_small");
        return {
            generatedAt: window.generatedAt,
            status: "insufficient-data",
            reasons,
            metrics,
            thresholds
        };
    }
    // 2. No trades in both rolling windows (stale activity)
    if (last7d.totalTrades === 0 && last30d.totalTrades === 0) {
        reasons.push("no_recent_trades");
        return {
            generatedAt: window.generatedAt,
            status: "cold",
            reasons,
            metrics,
            thresholds
        };
    }
    // 3. Sample too small in last 30d
    if (last30d.totalTrades < thresholds.minRecentTrades) {
        reasons.push("trade_count_too_small");
        return {
            generatedAt: window.generatedAt,
            status: "insufficient-data",
            reasons,
            metrics,
            thresholds
        };
    }
    // 4. Weak signals
    if (last7d.totalPnlUsdNet < thresholds.weakLast7dPnlUsdNet) {
        reasons.push("last7d_pnl_negative");
    }
    if (last30d.winRate < thresholds.weakLast30dWinRate) {
        reasons.push("last30d_win_rate_low");
    }
    if (feeToPnlRatioAll !== null && feeToPnlRatioAll > thresholds.highFeeToPnlRatio) {
        reasons.push("fee_drag_high");
    }
    if (fundingToPnlRatioAll !== null && fundingToPnlRatioAll > thresholds.highFundingToPnlRatio) {
        reasons.push("funding_drag_high");
    }
    if (reasons.length > 0) {
        return {
            generatedAt: window.generatedAt,
            status: "weak",
            reasons,
            metrics,
            thresholds
        };
    }
    return {
        generatedAt: window.generatedAt,
        status: "healthy",
        reasons: [],
        metrics,
        thresholds
    };
}
/** Sentinel when `feeToPnlRatioAll` / `fundingToPnlRatioAll` are not defined (avoids null in console JSON). */
exports.PAPER_HEALTH_LOG_RATIO_MISSING = -1;
function toFiniteOr(n, fallback) {
    return Number.isFinite(n) ? n : fallback;
}
function paperHealthStatusLogPayload(health) {
    const m = health.metrics;
    const ratio = (v) => v === null || !Number.isFinite(v) ? exports.PAPER_HEALTH_LOG_RATIO_MISSING : v;
    return {
        status: health.status,
        reasons: [...health.reasons],
        last7dTotalTrades: toFiniteOr(m.last7dTotalTrades, 0),
        last7dTotalPnlUsdNet: toFiniteOr(m.last7dTotalPnlUsdNet, 0),
        last30dTotalTrades: toFiniteOr(m.last30dTotalTrades, 0),
        last30dWinRate: toFiniteOr(m.last30dWinRate, 0),
        monthToDateTotalPnlUsdNet: toFiniteOr(m.monthToDateTotalPnlUsdNet, 0),
        totalTradesAll: toFiniteOr(m.totalTradesAll, 0),
        feeToPnlRatioAll: ratio(m.feeToPnlRatioAll),
        fundingToPnlRatioAll: ratio(m.fundingToPnlRatioAll)
    };
}
function paperHealthHistoryJsonlLine(health) {
    return {
        generatedAt: health.generatedAt,
        ...paperHealthStatusLogPayload(health)
    };
}
