"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonStore = exports.RUNS_INDEX_MAX_ITEMS = void 0;
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const file_utils_1 = require("../lib/file-utils");
const futuresPaperBundleCore_1 = require("../lib/futuresPaperBundleCore");
const executor_normalize_1 = require("../strategy/executors/executor-normalize");
const paper_dashboard_1 = require("./paper-dashboard");
const paper_health_1 = require("./paper-health");
const ai_block_evaluator_1 = require("./ai-block-evaluator");
const paper_summary_1 = require("./paper-summary");
exports.RUNS_INDEX_MAX_ITEMS = 50;
function isPaperOpenRecord(x) {
    if (!x || typeof x !== "object")
        return false;
    const o = x;
    return o.status === "open" && typeof o.symbol === "string";
}
/** 심볼+방향 단위 유일(양방향 RANGE: 동일 심볼 롱/숏 동시 보유). */
function dedupeOpensBySymbol(list) {
    const seen = new Set();
    const out = [];
    for (const r of list) {
        const sym = String(r.symbol);
        const side = r.side === "short" ? "short" : "long";
        const key = `${sym}:${side}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(r);
    }
    return out;
}
class JsonStore {
    baseDir;
    constructor(baseDir) {
        this.baseDir = baseDir;
    }
    async readTradeControlForDashboard() {
        const defaults = {
            serverTradeEnabled: false,
            closeOnlyMode: false,
            killSwitch: false,
            updatedAt: 0,
            reason: "control_file_missing_default_off",
            source: "server_state"
        };
        const rel = "control/trade-control.json";
        const fullPath = path.resolve(this.baseDir, rel);
        try {
            const raw = await fs.readFile(fullPath, "utf8");
            const parsed = JSON.parse(raw);
            const serverTradeEnabled = (parsed.serverTradeEnabled === true) || (parsed.server_trade_enabled === true);
            const closeOnlyMode = (parsed.closeOnlyMode === true) || (parsed.close_only_mode === true);
            const killSwitch = (parsed.killSwitch === true) || (parsed.kill_switch_active === true) || (parsed.kill_switch === true);
            const updatedAt = typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
                ? parsed.updatedAt
                : typeof parsed.updated_at === "number" && Number.isFinite(parsed.updated_at)
                    ? parsed.updated_at
                    : 0;
            const reason = typeof parsed.reason === "string" ? parsed.reason :
                parsed.reason === null ? null :
                    defaults.reason;
            const source = typeof parsed.source === "string"
                ? parsed.source
                : typeof parsed.authority_source === "string"
                    ? parsed.authority_source
                    : defaults.source;
            return { serverTradeEnabled, closeOnlyMode, killSwitch, updatedAt, reason, source };
        }
        catch {
            return defaults;
        }
    }
    async writeJson(relativePath, data) {
        const fullPath = path.resolve(this.baseDir, relativePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, JSON.stringify(data, null, 2), "utf8");
        return fullPath;
    }
    /** Append one JSON Lines row (`\n`-terminated). Creates parent dirs and file if missing. */
    async appendJsonlLine(relativePath, data) {
        const fullPath = path.resolve(this.baseDir, relativePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        const line = `${JSON.stringify(data)}\n`;
        await fs.appendFile(fullPath, line, "utf8");
        return fullPath;
    }
    /**
     * Persist latest `V2_NO_ENTRY_REASON_AUDIT_PROOF` rows for ops monitor (`data/runtime/latest-no-entry-audit.json`).
     * Per-symbol merge only; does not alter trading logic.
     */
    async mergeNoEntryAuditSnapshot(symbol, row) {
        const rel = "runtime/latest-no-entry-audit.json";
        const fullPath = path.resolve(this.baseDir, rel);
        const now = Date.now();
        let bySymbol = {};
        try {
            const raw = await fs.readFile(fullPath, "utf8");
            const parsed = JSON.parse(raw);
            const prior = parsed.bySymbol;
            if (prior && typeof prior === "object" && !Array.isArray(prior)) {
                bySymbol = { ...prior };
            }
        }
        catch {
            /* start fresh */
        }
        const symKey = String(symbol).trim().toUpperCase() || symbol;
        bySymbol[symKey] = { ...row, symbol: symKey, ts: now };
        const doc = { updatedAt: now, bySymbol };
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, JSON.stringify(doc, null, 2), "utf8");
    }
    /** Read `reports/health-history.jsonl` (empty if missing). Tails last 2000 lines. */
    async readHealthHistoryJsonlFile() {
        const fullPath = path.resolve(this.baseDir, "reports/health-history.jsonl");
        try {
            const lines = await (0, file_utils_1.readLastLines)(fullPath, 2000);
            return (0, paper_dashboard_1.parseHealthHistoryJsonl)(lines.join("\n"));
        }
        catch {
            return [];
        }
    }
    /** Tails last 50,000 events to prevent memory exhaustion in summary reporting. */
    async readEventsJsonlFile() {
        const fullPath = path.resolve(this.baseDir, "reports/events.jsonl");
        try {
            const lines = await (0, file_utils_1.readLastLines)(fullPath, 2000);
            const out = [];
            for (const line of lines) {
                const t = line.trim();
                if (!t)
                    continue;
                try {
                    out.push(JSON.parse(t));
                }
                catch {
                    /* skip */
                }
            }
            return out;
        }
        catch {
            return [];
        }
    }
    async readAiBlockEvalJson() {
        const fullPath = path.resolve(this.baseDir, "reports/ai-block-eval.json");
        try {
            const raw = await fs.readFile(fullPath, "utf8");
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    async writeAiBlockEvalJson(data) {
        return await this.writeJson("reports/ai-block-eval.json", data);
    }
    lastAiEvalMs = 0;
    /**
     * Update AI-block evaluation store using current prices.
     * Frequency gated (every 2 mins) to avoid 13MB reads choking the CPU.
     */
    async updateAiBlockEvaluations(input, force = false) {
        const minInterval = 120_000;
        if (!force && input.now - this.lastAiEvalMs < minInterval)
            return null;
        this.lastAiEvalMs = input.now;
        const criteria = {
            good_block_threshold_pct: input.criteria?.good_block_threshold_pct ?? -0.25,
            missed_opportunity_threshold_pct: input.criteria?.missed_opportunity_threshold_pct ?? 0.35,
            evaluation_horizon_priority: input.criteria?.evaluation_horizon_priority ?? [30, 15, 5]
        };
        const priceMap = (0, ai_block_evaluator_1.buildSymbolPriceMap)(input.symbolRows);
        const priorRaw = await this.readAiBlockEvalJson();
        const prior = priorRaw && typeof priorRaw === "object" ? priorRaw : {};
        const evals = prior.evals && typeof prior.evals === "object" ? { ...prior.evals } : {};
        for (const ev of input.events) {
            if (!(0, ai_block_evaluator_1.isAiBlockedEventNeedingEval)(ev))
                continue;
            const parsed = (0, ai_block_evaluator_1.toAiBlockedEvalFromEvent)(ev);
            if (!parsed)
                continue;
            const key = `${parsed.ts}:${parsed.symbol}:${parsed.reason}`;
            const existing = evals[key];
            const base = existing && typeof existing === "object" ? existing : parsed;
            const merged = { ...parsed, ...base };
            const pNow = priceMap.get(parsed.symbol) ?? null;
            const updated = (0, ai_block_evaluator_1.tryUpdateAiBlockedEventEval)({ now: input.now, ev: merged, symbolPriceNow: pNow, criteria });
            evals[key] = updated;
        }
        // If nothing changed, still write (small file) for simplicity.
        return await this.writeAiBlockEvalJson({ updatedAt: input.now, criteria, evals });
    }
    async writeSnapshotLatest(data) {
        return await this.writeJson("snapshots/latest.json", data);
    }
    async writeSnapshotLatestMeta(data) {
        return await this.writeJson("snapshots/latest-meta.json", data);
    }
    async writeLightweightStatus(data) {
        return await this.writeJson("runtime/status.json", data);
    }
    /** Only call when at least one snapshot is a long or short candidate; writes `runs/{timestamp}.json`. */
    async writePaperCandidateRun(timestamp, payload) {
        return await this.writeJson(`runs/${timestamp}.json`, payload);
    }
    /**
     * Merge `newItem` into `runs/index.json`: newest first, dedupe by `fetchedAt`, cap at RUNS_INDEX_MAX_ITEMS.
     */
    async updateRunsIndex(newItem) {
        const indexRel = "runs/index.json";
        let prior = null;
        try {
            const fullPath = path.resolve(this.baseDir, indexRel);
            const raw = await fs.readFile(fullPath, "utf8");
            prior = JSON.parse(raw);
        }
        catch (e) {
            const err = e;
            if (err.code !== "ENOENT")
                throw e;
        }
        const oldItems = Array.isArray(prior?.items) ? prior.items : [];
        const withoutDup = oldItems.filter((it) => it.fetchedAt !== newItem.fetchedAt);
        const merged = [newItem, ...withoutDup];
        const items = merged
            .sort((a, b) => b.fetchedAt - a.fetchedAt)
            .slice(0, exports.RUNS_INDEX_MAX_ITEMS);
        const next = {
            updatedAt: Date.now(),
            total: items.length,
            items
        };
        return await this.writeJson(indexRel, next);
    }
    /**
     * `positions/open.json`: JSON array of open records (v2), or legacy single object `{ status:"open", ... }`.
     */
    async readPositionsOpenAll() {
        const rel = "positions/open.json";
        const fullPath = path.resolve(this.baseDir, rel);
        try {
            const raw = await fs.readFile(fullPath, "utf8");
            const j = JSON.parse(raw);
            if (Array.isArray(j)) {
                return j
                    .filter((x) => isPaperOpenRecord(x))
                    .map(executor_normalize_1.migrateLegacyExecutorAtEntry);
            }
            if (j && typeof j === "object" && isPaperOpenRecord(j)) {
                return [(0, executor_normalize_1.migrateLegacyExecutorAtEntry)(j)];
            }
            return [];
        }
        catch (e) {
            const err = e;
            if (err.code === "ENOENT")
                return [];
            throw e;
        }
    }
    async writePositionsOpenAll(list) {
        const dedup = dedupeOpensBySymbol(list);
        return await this.writeJson("positions/open.json", dedup);
    }
    // --- PENDING ENTRY REGISTRY ---
    async readPendingEntryOrders() {
        const rel = "runtime/pending-entry-orders.json";
        const fullPath = path.resolve(this.baseDir, rel);
        try {
            const raw = await fs.readFile(fullPath, "utf8");
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        }
        catch (e) {
            return [];
        }
    }
    async writePendingEntryOrders(list) {
        return await this.writeJson("runtime/pending-entry-orders.json", list);
    }
    /** Ensure `positions/history.json` exists as an empty array. */
    async ensurePositionsHistoryEmpty() {
        const rel = "positions/history.json";
        const fullPath = path.resolve(this.baseDir, rel);
        try {
            await fs.access(fullPath);
        }
        catch {
            await this.writeJson(rel, []);
        }
    }
    async appendPositionsHistory(record) {
        await this.ensurePositionsHistoryEmpty();
        const rel = "positions/history.json";
        const fullPath = path.resolve(this.baseDir, rel);
        const raw = await fs.readFile(fullPath, "utf8");
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? [...parsed] : [];
        list.push(record);
        await fs.writeFile(fullPath, JSON.stringify(list, null, 2), "utf8");
    }
    async deletePositionsOpen() {
        await this.writePositionsOpenAll([]);
    }
    /** Full `positions/history.json` array (ensures file exists). */
    async readPositionsHistory() {
        await this.ensurePositionsHistoryEmpty();
        const rel = "positions/history.json";
        const fullPath = path.resolve(this.baseDir, rel);
        const raw = await fs.readFile(fullPath, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    /** Regenerate summary reports from current history (shared `generatedAt`). */
    async writePaperSummaryReport(okxBalance) {
        const history = await this.readPositionsHistory();
        const generatedAt = Date.now();
        const events = await this.readEventsJsonlFile();
        const aiBlockEval = await this.readAiBlockEvalJson();
        const summaryBase = (0, paper_summary_1.buildPaperSummaryFromHistory)(history, generatedAt);
        const byRegime = (0, paper_summary_1.buildPaperSummaryByRegimeFromHistory)(history, generatedAt);
        const dailyBase = (0, paper_summary_1.buildPaperDailySummaryFromHistory)(history, generatedAt);
        const { summary, daily } = (0, paper_summary_1.attachObservationToReports)({
            summary: summaryBase,
            daily: dailyBase,
            byRegimeAll: { range: byRegime.range, trend: byRegime.trend },
            history,
            events,
            aiBlockEval
        });
        const window = (0, paper_summary_1.buildPaperWindowSummaryFromHistory)(history, generatedAt);
        const health = (0, paper_health_1.buildPaperHealthReport)(window);
        const summaryPath = await this.writeJson("reports/summary.json", summary);
        await this.writeJson("reports/summary-range.json", { generatedAt, ...byRegime.range });
        await this.writeJson("reports/summary-trend.json", { generatedAt, ...byRegime.trend });
        const dailyPath = await this.writeJson("reports/summary-daily.json", daily);
        const windowPath = await this.writeJson("reports/summary-window.json", window);
        const healthPath = await this.writeJson("reports/summary-health.json", health);
        await this.appendJsonlLine("reports/health-history.jsonl", (0, paper_health_1.paperHealthHistoryJsonlLine)(health));
        const healthHistoryLines = await this.readHealthHistoryJsonlFile();
        const tradeControl = await this.readTradeControlForDashboard();
        const dashboard = (0, paper_dashboard_1.buildPaperDashboard)({ summary, window, health, healthHistoryLines, tradeControl, okx_balance: okxBalance });
        await this.writeJson("reports/dashboard.json", dashboard);
        const projectRoot = path.resolve(this.baseDir, "..");
        const publicBundleRel = "reports/public-futures-paper-bundle.json";
        const publicBundleAbs = path.resolve(this.baseDir, publicBundleRel);
        console.log(JSON.stringify({
            event: "PUBLIC_BUNDLE_WRITE_START",
            path: publicBundleAbs,
            at: Date.now()
        }));
        try {
            const publicBundle = await (0, futuresPaperBundleCore_1.composePublicFuturesPaperBundleForWrite)({
                projectRoot,
                summary,
                summaryRange: { generatedAt, ...byRegime.range },
                summaryTrend: { generatedAt, ...byRegime.trend },
                summaryDaily: daily,
                summaryWindow: window,
                summaryHealth: health,
                dashboard,
                positionsHistoryRaw: history,
                eventsParsed: events,
                healthHistoryParsed: healthHistoryLines
            });
            const publicBundlePath = await this.writeJson(publicBundleRel, publicBundle);
            const st = await fs.stat(publicBundlePath);
            const openPositionsCount = Array.isArray(publicBundle.openPositions) ? publicBundle.openPositions.length : -1;
            const positionsHistoryCount = Array.isArray(publicBundle.positionsHistory) ? publicBundle.positionsHistory.length : -1;
            const symbolRowsCount = Array.isArray(publicBundle.symbolRows) ? publicBundle.symbolRows.length : -1;
            const hasDashboard = publicBundle.dashboard != null;
            const hasEngineState = publicBundle.engineState != null;
            console.log(JSON.stringify({
                event: "PUBLIC_BUNDLE_WRITE_SUCCESS",
                path: publicBundlePath,
                bytes: st.size,
                generatedAt: publicBundle.generatedAt,
                openPositionsCount,
                positionsHistoryCount,
                symbolRowsCount,
                hasDashboard,
                hasEngineState
            }));
            return { summaryPath, dailyPath, windowPath, healthPath, publicBundlePath, health };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            const reason = e instanceof Error ? e.name : "unknown";
            const stackSlice = e instanceof Error && e.stack ? e.stack.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 400) : undefined;
            console.error(JSON.stringify({
                event: "PUBLIC_BUNDLE_WRITE_FAIL",
                path: publicBundleAbs,
                reason,
                message,
                stackSlice
            }));
            throw e;
        }
    }
}
exports.JsonStore = JsonStore;
