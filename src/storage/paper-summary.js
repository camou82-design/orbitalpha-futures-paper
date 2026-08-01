"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPaperSummaryFromHistory = buildPaperSummaryFromHistory;
exports.buildPaperSummaryByRegimeFromHistory = buildPaperSummaryByRegimeFromHistory;
exports.buildPaperDailySummaryFromHistory = buildPaperDailySummaryFromHistory;
exports.buildPaperWindowSummaryFromHistory = buildPaperWindowSummaryFromHistory;
exports.attachObservationToReports = attachObservationToReports;
/**
 * [FIX: history-ledger] Guard: partial/defense sub-events must NOT count as final closed positions.
 * If such rows are present in history.json (legacy contamination or future regression), they are
 * excluded from summary aggregation here as a safety net.
 *
 * Excluded closeReason values (intermediate events, not full position closes):
 *   - partial_exit_1, partial_exit_2  → sub-position partial liquidation
 *   - EXIT_LONG_CRASH_REDUCE           → 50% crash defense reduction (not full close)
 *   - EXIT_CRASH_REDUCE                → generic crash partial reduction
 *
 * Excluded exitType/closeSource values (belt-and-suspenders):
 *   - EXIT_PARTIAL_SPLIT_1, EXIT_PARTIAL_SPLIT_2, EXIT_LONG_CRASH_REDUCE, EXIT_CRASH_REDUCE
 *   - closeSource: PARTIAL_SPLIT
 */
const PARTIAL_EVENT_CLOSE_REASONS = new Set([
    "partial_exit_1",
    "partial_exit_2",
    "EXIT_LONG_CRASH_REDUCE",
    "EXIT_CRASH_REDUCE"
]);
const PARTIAL_EVENT_EXIT_TYPES = new Set([
    "EXIT_PARTIAL_SPLIT_1",
    "EXIT_PARTIAL_SPLIT_2",
    "EXIT_LONG_CRASH_REDUCE",
    "EXIT_CRASH_REDUCE"
]);
function isFinalClosedRow(r) {
    if (!r || typeof r !== "object")
        return true; // parseRow will handle invalid rows
    const o = r;
    // Filter by closeReason
    if (typeof o.closeReason === "string" && PARTIAL_EVENT_CLOSE_REASONS.has(o.closeReason))
        return false;
    // Filter by exitType
    if (typeof o.exitType === "string" && PARTIAL_EVENT_EXIT_TYPES.has(o.exitType))
        return false;
    // Filter by closeSource (PARTIAL_SPLIT is only ever a sub-event, never a final close)
    if (o.closeSource === "PARTIAL_SPLIT")
        return false;
    return true;
}
function parseRow(r) {
    if (!r || typeof r !== "object")
        return null;
    const o = r;
    const pnl = o.pnlUsdNet;
    if (typeof pnl !== "number" || !Number.isFinite(pnl))
        return null;
    const fee = o.feeUsd;
    const fund = o.fundingUsd;
    const feeUsd = typeof fee === "number" && Number.isFinite(fee) ? fee : 0;
    const fundingUsd = typeof fund === "number" && Number.isFinite(fund) ? fund : 0;
    const hm = o.holdingMs;
    const holdingMs = typeof hm === "number" && Number.isFinite(hm) && hm >= 0 ? hm : undefined;
    const ca = o.closedAt;
    const closedAt = typeof ca === "number" && Number.isFinite(ca) ? ca : undefined;
    const sv = o.strategyVersion;
    const strategyVersion = typeof sv === "string" && sv.length > 0 ? sv : undefined;
    const sym = o.symbol;
    const symbol = typeof sym === "string" && sym.length > 0 ? sym : undefined;
    const g = o.pnlUsdGross;
    let pnlUsdGross;
    if (typeof g === "number" && Number.isFinite(g))
        pnlUsdGross = g;
    else
        pnlUsdGross = pnl + feeUsd + fundingUsd;
    return { pnlUsdNet: pnl, pnlUsdGross, feeUsd, fundingUsd, holdingMs, closedAt, strategyVersion, symbol };
}
function pickModeSlice(s) {
    return {
        totalTrades: s.totalTrades,
        totalPnlUsdGross: s.totalPnlUsdGross,
        totalFeeUsd: s.totalFeeUsd,
        totalPnlUsdNet: s.totalPnlUsdNet,
        feeToGrossRatio: s.feeToGrossRatio
    };
}
function pickTrendSlice(s) {
    return {
        totalTrades: s.totalTrades,
        totalPnlUsdGross: s.totalPnlUsdGross,
        totalFeeUsd: s.totalFeeUsd,
        totalPnlUsdNet: s.totalPnlUsdNet,
        averagePnlUsdNet: s.averagePnlUsdNet
    };
}
function emptyExitMix() {
    return {
        EXIT_TP: 0,
        EXIT_SL: 0,
        EXIT_REGIME: 0,
        EXIT_TREND_BREAK: 0,
        total: 0,
        r_EXIT_TP: 0,
        r_EXIT_SL: 0,
        r_EXIT_REGIME: 0,
        r_EXIT_TREND_BREAK: 0
    };
}
function finishExitMix(m) {
    const total = m.total > 0 ? m.total : m.EXIT_TP + m.EXIT_SL + m.EXIT_REGIME + m.EXIT_TREND_BREAK;
    const denom = total > 0 ? total : 0;
    return {
        ...m,
        total,
        r_EXIT_TP: denom > 0 ? m.EXIT_TP / denom : 0,
        r_EXIT_SL: denom > 0 ? m.EXIT_SL / denom : 0,
        r_EXIT_REGIME: denom > 0 ? m.EXIT_REGIME / denom : 0,
        r_EXIT_TREND_BREAK: denom > 0 ? m.EXIT_TREND_BREAK / denom : 0
    };
}
function emptyEntryBlockMix() {
    return { entryBlocked: 0, entryAllowed: 0, entryOpened: 0, entryBlockedRatio: null };
}
function finishEntryBlockMix(m) {
    const denom = m.entryBlocked + m.entryOpened;
    return { ...m, entryBlockedRatio: denom > 0 ? m.entryBlocked / denom : null };
}
function parseEventTs(e) {
    if (!e || typeof e !== "object")
        return null;
    const o = e;
    const t = o.ts;
    return typeof t === "number" && Number.isFinite(t) ? t : null;
}
function parseEventType(e) {
    if (!e || typeof e !== "object")
        return null;
    const o = e;
    const t = o.type;
    return typeof t === "string" ? t : null;
}
function aggregateObservation(byRegime, events, aiEvalMap, criteria = null) {
    let exit = { EXIT_TP: 0, EXIT_SL: 0, EXIT_REGIME: 0, EXIT_TREND_BREAK: 0, total: 0 };
    let entry = { entryBlocked: 0, entryAllowed: 0, entryOpened: 0 };
    let executorAllowed = 0;
    let aiApproved = 0;
    let aiBlocked = 0;
    const blockedReasonCounts = {};
    let aiGood = 0;
    let aiMissed = 0;
    let aiNeutral = 0;
    for (const ev of events) {
        const ty = parseEventType(ev);
        if (!ty)
            continue;
        if (ty === "EXIT_TP" || ty === "EXIT_SL" || ty === "EXIT_REGIME" || ty === "EXIT_TREND_BREAK") {
            exit[ty] = (exit[ty] ?? 0) + 1;
            exit.total += 1;
        }
        else if (ty === "ENTRY_BLOCKED") {
            entry.entryBlocked += 1;
            const r = ev && typeof ev === "object" ? ev.reason : undefined;
            const rs = typeof r === "string" ? r : "unknown";
            blockedReasonCounts[rs] = (blockedReasonCounts[rs] ?? 0) + 1;
            if (rs === "AI_FILTER" || rs === "AI_REJECT" || rs === "AI_DIRECTION_MISMATCH")
                aiBlocked += 1;
        }
        else if (ty === "ENTRY_ALLOWED") {
            entry.entryAllowed += 1;
            executorAllowed += 1;
        }
        else if (ty === "ENTRY_OPENED") {
            entry.entryOpened += 1;
        }
        else if (ty === "AI_APPROVED") {
            aiApproved += 1;
        }
    }
    if (aiEvalMap) {
        for (const v of Object.values(aiEvalMap)) {
            if (!v || typeof v !== "object")
                continue;
            const hint = v.hypothetical_outcome_hint;
            if (hint === "good_block")
                aiGood += 1;
            else if (hint === "missed_opportunity")
                aiMissed += 1;
            else if (hint === "neutral")
                aiNeutral += 1;
        }
    }
    const aiTotal = aiGood + aiMissed + aiNeutral;
    const aiQualityRate = aiTotal > 0 ? aiGood / aiTotal : null;
    const aiApprovalRate = executorAllowed > 0 ? aiApproved / executorAllowed : null;
    return {
        range: pickModeSlice(byRegime.range),
        trend: pickTrendSlice(byRegime.trend),
        exitMix: finishExitMix(exit),
        entryBlockMix: finishEntryBlockMix(entry),
        aiApproval: {
            executor_allowed_count: executorAllowed,
            ai_approved_count: aiApproved,
            ai_blocked_count: aiBlocked,
            ai_approval_rate: aiApprovalRate,
            blocked_reason_counts: blockedReasonCounts
        },
        aiBlockQuality: {
            ai_block_good_count: aiGood,
            ai_block_missed_count: aiMissed,
            ai_block_neutral_count: aiNeutral,
            ai_block_quality_rate: aiQualityRate,
            criteria
        }
    };
}
function utcDayKeyFromMs(ms) {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}
function utcMonthStartMs(now) {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}
const MS_PER_DAY = 24 * 60 * 60 * 1000;
function aggregateRows(rows) {
    const totalTrades = rows.length;
    let winTrades = 0;
    let lossTrades = 0;
    let totalPnlUsdNet = 0;
    let totalPnlUsdGross = 0;
    let totalFeeUsd = 0;
    let totalFundingUsd = 0;
    let totalHoldingMs = 0;
    let holdingCount = 0;
    let best = null;
    let worst = null;
    let latestClosedAt = null;
    const versionSet = new Set();
    const symbolsTraded = {};
    let sumWinNet = 0;
    let sumLossNet = 0;
    let tradesGrossPositiveNetNegative = 0;
    for (const row of rows) {
        const p = row.pnlUsdNet;
        totalPnlUsdNet += p;
        totalPnlUsdGross += row.pnlUsdGross;
        totalFeeUsd += row.feeUsd;
        totalFundingUsd += row.fundingUsd;
        if (p > 0) {
            winTrades += 1;
            sumWinNet += p;
        }
        else if (p < 0) {
            lossTrades += 1;
            sumLossNet += p;
        }
        if (row.pnlUsdGross > 0 && row.pnlUsdNet < 0)
            tradesGrossPositiveNetNegative += 1;
        if (best === null || p > best)
            best = p;
        if (worst === null || p < worst)
            worst = p;
        if (row.holdingMs !== undefined) {
            totalHoldingMs += row.holdingMs;
            holdingCount += 1;
        }
        if (row.closedAt !== undefined) {
            if (latestClosedAt === null || row.closedAt > latestClosedAt)
                latestClosedAt = row.closedAt;
        }
        if (row.strategyVersion)
            versionSet.add(row.strategyVersion);
        if (row.symbol) {
            const k = row.symbol;
            symbolsTraded[k] = (symbolsTraded[k] ?? 0) + 1;
        }
    }
    const winRate = totalTrades > 0 ? winTrades / totalTrades : 0;
    const averagePnlUsdNet = totalTrades > 0 ? totalPnlUsdNet / totalTrades : 0;
    const averageHoldingMs = holdingCount > 0 ? totalHoldingMs / holdingCount : 0;
    const strategyVersions = [...versionSet].sort();
    const averageWinPnlUsdNet = winTrades > 0 ? sumWinNet / winTrades : null;
    const averageLossPnlUsdNet = lossTrades > 0 ? sumLossNet / lossTrades : null;
    const averageFeeUsdPerTrade = totalTrades > 0 ? totalFeeUsd / totalTrades : 0;
    const lossAbs = sumLossNet < 0 ? Math.abs(sumLossNet) : 0;
    const profitFactorNet = lossAbs > 0 && sumWinNet > 0 ? sumWinNet / lossAbs : null;
    const avgWinToAvgLossRatio = averageWinPnlUsdNet !== null &&
        averageLossPnlUsdNet !== null &&
        averageLossPnlUsdNet !== 0
        ? Math.abs(averageWinPnlUsdNet / averageLossPnlUsdNet)
        : null;
    const tradesGrossPositiveNetNegativeRatio = totalTrades > 0 ? tradesGrossPositiveNetNegative / totalTrades : 0;
    const netToGrossRatio = totalPnlUsdGross !== 0 && Number.isFinite(totalPnlUsdGross) ? totalPnlUsdNet / totalPnlUsdGross : null;
    const feeToGrossRatio = totalPnlUsdGross !== 0 && Number.isFinite(totalPnlUsdGross) ? totalFeeUsd / totalPnlUsdGross : null;
    return {
        totalTrades,
        winTrades,
        lossTrades,
        winRate,
        totalPnlUsdNet,
        averagePnlUsdNet,
        bestTradePnlUsdNet: totalTrades > 0 ? best : null,
        worstTradePnlUsdNet: totalTrades > 0 ? worst : null,
        totalFeeUsd,
        totalFundingUsd,
        averageHoldingMs,
        latestClosedAt,
        strategyVersions,
        symbolsTraded,
        totalPnlUsdGross,
        averageWinPnlUsdNet,
        averageLossPnlUsdNet,
        averageFeeUsdPerTrade,
        profitFactorNet,
        avgWinToAvgLossRatio,
        tradesGrossPositiveNetNegative,
        tradesGrossPositiveNetNegativeRatio,
        netToGrossRatio,
        feeToGrossRatio
    };
}
/** Aggregate closed-position rows from `history.json` (unknown[]). Skips invalid entries. */
function buildPaperSummaryFromHistory(history, generatedAt = Date.now()) {
    const rows = [];
    for (const r of history) {
        // [FIX: history-ledger] Exclude partial/defense sub-events from final-position statistics.
        if (!isFinalClosedRow(r))
            continue;
        const row = parseRow(r);
        if (row)
            rows.push(row);
    }
    // NOTE: observation is filled by JsonStore where events are available.
    const emptyObs = {
        range: pickModeSlice(aggregateRows([])),
        trend: pickTrendSlice(aggregateRows([])),
        exitMix: emptyExitMix(),
        entryBlockMix: emptyEntryBlockMix(),
        aiApproval: {
            executor_allowed_count: 0,
            ai_approved_count: 0,
            ai_blocked_count: 0,
            ai_approval_rate: null,
            blocked_reason_counts: {}
        },
        aiBlockQuality: {
            ai_block_good_count: 0,
            ai_block_missed_count: 0,
            ai_block_neutral_count: 0,
            ai_block_quality_rate: null,
            criteria: null
        }
    };
    return { generatedAt, ...aggregateRows(rows), observation: emptyObs };
}
function isRegime(x) {
    return x === "RANGE" || x === "TREND" || x === "NO_TRADE";
}
/** Aggregate by regimeAtEntry (RANGE/TREND). NO_TRADE entries are ignored. */
function buildPaperSummaryByRegimeFromHistory(history, generatedAt = Date.now()) {
    const rangeRows = [];
    const trendRows = [];
    for (const r of history) {
        // [FIX: history-ledger] Exclude partial/defense sub-events from regime-slice statistics.
        if (!isFinalClosedRow(r))
            continue;
        const row = parseRow(r);
        if (!row)
            continue;
        const regimeAtEntry = r && typeof r === "object" ? r.regimeAtEntry : undefined;
        if (!isRegime(regimeAtEntry))
            continue;
        if (regimeAtEntry === "RANGE")
            rangeRows.push(row);
        else if (regimeAtEntry === "TREND")
            trendRows.push(row);
    }
    return { generatedAt, range: aggregateRows(rangeRows), trend: aggregateRows(trendRows) };
}
/**
 * Per UTC calendar day (`closedAt`), same win/loss/PnL rules as `buildPaperSummaryFromHistory`.
 * Rows without a finite `closedAt` are omitted from `days` (not counted in any bucket).
 */
function buildPaperDailySummaryFromHistory(history, generatedAt = Date.now()) {
    const rows = [];
    for (const r of history) {
        // [FIX: history-ledger] Exclude partial/defense sub-events from daily statistics.
        if (!isFinalClosedRow(r))
            continue;
        const row = parseRow(r);
        if (row)
            rows.push(row);
    }
    const byDay = new Map();
    for (const row of rows) {
        if (row.closedAt === undefined)
            continue;
        const key = utcDayKeyFromMs(row.closedAt);
        const list = byDay.get(key);
        if (list)
            list.push(row);
        else
            byDay.set(key, [row]);
    }
    const days = {};
    const sortedKeys = [...byDay.keys()].sort();
    for (const key of sortedKeys) {
        const dayRows = byDay.get(key);
        const emptyObs = {
            range: pickModeSlice(aggregateRows([])),
            trend: pickTrendSlice(aggregateRows([])),
            exitMix: emptyExitMix(),
            entryBlockMix: emptyEntryBlockMix(),
            aiApproval: {
                executor_allowed_count: 0,
                ai_approved_count: 0,
                ai_blocked_count: 0,
                ai_approval_rate: null,
                blocked_reason_counts: {}
            },
            aiBlockQuality: {
                ai_block_good_count: 0,
                ai_block_missed_count: 0,
                ai_block_neutral_count: 0,
                ai_block_quality_rate: null,
                criteria: null
            }
        };
        days[key] = { date: key, ...aggregateRows(dayRows), observation: emptyObs };
    }
    return { generatedAt, bucketType: "daily", days };
}
/**
 * Time-window stats from `history.json` using `closedAt` (UTC) for last7d / last30d / monthToDate.
 * Rows without `closedAt` are excluded from those windows only; `all` matches overall `summary.json`.
 */
function buildPaperWindowSummaryFromHistory(history, generatedAt = Date.now()) {
    const rows = [];
    for (const r of history) {
        // [FIX: history-ledger] Exclude partial/defense sub-events from window statistics.
        if (!isFinalClosedRow(r))
            continue;
        const row = parseRow(r);
        if (row)
            rows.push(row);
    }
    const inClosedRange = (row, fromInclusive) => row.closedAt !== undefined && row.closedAt >= fromInclusive && row.closedAt <= generatedAt;
    const last7d = rows.filter((r) => inClosedRange(r, generatedAt - 7 * MS_PER_DAY));
    const last30d = rows.filter((r) => inClosedRange(r, generatedAt - 30 * MS_PER_DAY));
    const monthStart = utcMonthStartMs(generatedAt);
    const monthToDate = rows.filter((r) => inClosedRange(r, monthStart));
    return {
        generatedAt,
        windows: {
            last7d: aggregateRows(last7d),
            last30d: aggregateRows(last30d),
            monthToDate: aggregateRows(monthToDate),
            all: aggregateRows(rows)
        }
    };
}
/**
 * Attach observation metrics (mode pnl slices + exit mix + entry blocked mix) to summary and daily reports.
 * This is pure and does not read disk; pass parsed `events` from `events.jsonl`.
 */
function attachObservationToReports(input) {
    const { summary, daily, byRegimeAll, events, history } = input;
    const evalObj = input.aiBlockEval && typeof input.aiBlockEval === "object" ? input.aiBlockEval : null;
    const evalsAll = evalObj && evalObj.evals && typeof evalObj.evals === "object" ? evalObj.evals : null;
    const criteriaAll = evalObj && evalObj.criteria && typeof evalObj.criteria === "object"
        ? {
            good_block_threshold_pct: Number(evalObj.criteria.good_block_threshold_pct),
            missed_opportunity_threshold_pct: Number(evalObj.criteria.missed_opportunity_threshold_pct),
            evaluation_horizon_priority: Array.isArray(evalObj.criteria.evaluation_horizon_priority)
                ? evalObj.criteria.evaluation_horizon_priority.filter((x) => x === 5 || x === 15 || x === 30)
                : []
        }
        : null;
    const obsAll = aggregateObservation(byRegimeAll, events, evalsAll, criteriaAll);
    // Build per-day observation from (history+events) keyed by UTC day.
    const byDayHistory = {};
    for (const r of history) {
        const row = parseRow(r);
        if (!row || row.closedAt === undefined)
            continue;
        const k = utcDayKeyFromMs(row.closedAt);
        (byDayHistory[k] ??= []).push(r);
    }
    const byDayEvents = {};
    for (const ev of events) {
        const ts = parseEventTs(ev);
        if (ts === null)
            continue;
        const k = utcDayKeyFromMs(ts);
        (byDayEvents[k] ??= []).push(ev);
    }
    const byDayEvals = {};
    if (evalsAll) {
        for (const [k, v] of Object.entries(evalsAll)) {
            const parts = k.split(":");
            const tsRaw = parts.length > 0 ? Number(parts[0]) : NaN;
            if (!Number.isFinite(tsRaw))
                continue;
            const day = utcDayKeyFromMs(tsRaw);
            (byDayEvals[day] ??= {})[k] = v;
        }
    }
    const nextDays = {};
    for (const [k, bucket] of Object.entries(daily.days)) {
        const h = byDayHistory[k] ?? [];
        const byReg = buildPaperSummaryByRegimeFromHistory(h, daily.generatedAt);
        const ev = byDayEvents[k] ?? [];
        const evl = byDayEvals[k] ?? null;
        nextDays[k] = {
            ...bucket,
            observation: aggregateObservation({ range: byReg.range, trend: byReg.trend }, ev, evl, criteriaAll)
        };
    }
    return {
        summary: { ...summary, observation: obsAll },
        daily: { ...daily, days: nextDays }
    };
}
