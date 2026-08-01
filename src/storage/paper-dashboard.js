"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseHealthHistoryJsonl = parseHealthHistoryJsonl;
exports.buildPaperDashboard = buildPaperDashboard;
function pickWinSlice(s) {
    return {
        totalTrades: s.totalTrades,
        winRate: s.winRate,
        totalPnlUsdNet: s.totalPnlUsdNet
    };
}
function pickFeeSlice(s) {
    return {
        totalTrades: s.totalTrades,
        totalPnlUsdGross: s.totalPnlUsdGross,
        totalFeeUsd: s.totalFeeUsd,
        totalFundingUsd: s.totalFundingUsd,
        totalPnlUsdNet: s.totalPnlUsdNet,
        averageWinPnlUsdNet: s.averageWinPnlUsdNet,
        averageLossPnlUsdNet: s.averageLossPnlUsdNet,
        averageFeeUsdPerTrade: s.averageFeeUsdPerTrade,
        profitFactorNet: s.profitFactorNet,
        avgWinToAvgLossRatio: s.avgWinToAvgLossRatio,
        tradesGrossPositiveNetNegative: s.tradesGrossPositiveNetNegative,
        tradesGrossPositiveNetNegativeRatio: s.tradesGrossPositiveNetNegativeRatio,
        netToGrossRatio: s.netToGrossRatio,
        feeToGrossRatio: s.feeToGrossRatio
    };
}
function buildHeadline(health, window) {
    const st = health.status;
    const w = window.windows;
    const l7 = w.last7d.totalPnlUsdNet;
    if (st === "insufficient-data") {
        return "insufficient-data · 표본 부족";
    }
    if (st === "cold") {
        return "cold · 최근 거래 없음";
    }
    if (st === "weak") {
        const bits = [];
        if (l7 < 0)
            bits.push("최근 7일 손익 음수");
        if (health.reasons.includes("last30d_win_rate_low"))
            bits.push("최근 30일 승률 낮음");
        if (health.reasons.includes("fee_drag_high"))
            bits.push("수수료 부담 큼");
        if (health.reasons.includes("funding_drag_high"))
            bits.push("펀딩 부담 큼");
        if (bits.length === 0)
            bits.push("지표 약세");
        return `weak · ${bits.join(" · ")}`;
    }
    const l7Label = l7 >= 0 ? "최근 7일 손익 플러스" : "최근 7일 손익 음수";
    return `healthy · ${l7Label} · 최근 30일 승률 양호`;
}
function buildRecentTrend(lines) {
    if (lines.length === 0) {
        return {
            latestStatuses: [],
            statusCounts: {},
            changed: false,
            latestGeneratedAt: null,
            previousGeneratedAt: null
        };
    }
    const last10 = lines.slice(-10);
    const latestStatuses = [...last10].reverse().map((r) => r.status);
    const statusCounts = {};
    for (const r of last10) {
        statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
    }
    const latest = lines[lines.length - 1];
    const previous = lines.length >= 2 ? lines[lines.length - 2] : null;
    return {
        latestStatuses,
        statusCounts,
        changed: previous !== null && previous.status !== latest.status,
        latestGeneratedAt: latest.generatedAt,
        previousGeneratedAt: previous !== null ? previous.generatedAt : null
    };
}
/** Parse `health-history.jsonl` content (may be empty). */
function parseHealthHistoryJsonl(raw) {
    const out = [];
    for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t)
            continue;
        try {
            const j = JSON.parse(t);
            if (!j || typeof j !== "object")
                continue;
            const o = j;
            const ga = o.generatedAt;
            const st = o.status;
            if (typeof ga !== "number" || !Number.isFinite(ga))
                continue;
            if (typeof st !== "string")
                continue;
            out.push(j);
        }
        catch {
            /* skip bad line */
        }
    }
    return out;
}
function buildPaperDashboard(input) {
    const { summary, window, health, healthHistoryLines, tradeControl, okx_balance } = input;
    const w = window.windows;
    const snapshot = {
        all: {
            totalTrades: summary.totalTrades,
            winRate: summary.winRate,
            totalPnlUsdNet: summary.totalPnlUsdNet,
            totalFeeUsd: summary.totalFeeUsd,
            totalFundingUsd: summary.totalFundingUsd
        },
        last7d: pickWinSlice(w.last7d),
        last30d: pickWinSlice(w.last30d),
        monthToDate: pickWinSlice(w.monthToDate)
    };
    const feeAnalytics = {
        last7d: pickFeeSlice(w.last7d),
        last30d: pickFeeSlice(w.last30d),
        all: pickFeeSlice(w.all)
    };
    return {
        generatedAt: health.generatedAt,
        status: health.status,
        reasons: [...health.reasons],
        headline: buildHeadline(health, window),
        tradeControl,
        okx_balance,
        snapshot,
        feeAnalytics,
        recentTrend: buildRecentTrend(healthHistoryLines),
        observation: summary.observation
    };
}
