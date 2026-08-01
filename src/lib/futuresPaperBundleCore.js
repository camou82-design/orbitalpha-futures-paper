"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.displayFieldsForClosedRow = exports.normalizeClosedHistoryRow = exports.normalizePositionsHistoryArray = void 0;
exports.paperOperationalFromEngineState = paperOperationalFromEngineState;
exports.deriveCurrentPositionsForDisplay = deriveCurrentPositionsForDisplay;
exports.composePublicFuturesPaperBundleForWrite = composePublicFuturesPaperBundleForWrite;
exports.loadFuturesPaperBundleFromDiskRoot = loadFuturesPaperBundleFromDiskRoot;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const futuresPaperLedgerStats_1 = require("./futuresPaperLedgerStats");
const paperClosedHistoryNormalize_1 = require("./paperClosedHistoryNormalize");
var paperClosedHistoryNormalize_2 = require("./paperClosedHistoryNormalize");
Object.defineProperty(exports, "normalizePositionsHistoryArray", { enumerable: true, get: function () { return paperClosedHistoryNormalize_2.normalizePositionsHistoryArray; } });
Object.defineProperty(exports, "normalizeClosedHistoryRow", { enumerable: true, get: function () { return paperClosedHistoryNormalize_2.normalizeClosedHistoryRow; } });
Object.defineProperty(exports, "displayFieldsForClosedRow", { enumerable: true, get: function () { return paperClosedHistoryNormalize_2.displayFieldsForClosedRow; } });
const file_utils_1 = require("./file-utils");
function isRoutingKind(x) {
    return x === "RANGE" || x === "TREND" || x === "IDLE";
}
function isNewEntryPolicy(x) {
    return x === "full" || x === "reduced" || x === "paused";
}
/** `engine-state.json`에서 대시보드 상단용 운영 스냅샷을 만든다. */
function paperOperationalFromEngineState(engineState) {
    if (!engineState || typeof engineState !== "object")
        return null;
    const o = engineState;
    const expl = o.explanation;
    let modeReasonLabel = "";
    let engineReasonLabel = "";
    let riskReasonLabel = "";
    let activeEngine = "IDLE";
    let newEntryPolicy = "paused";
    if (expl && typeof expl === "object") {
        const e = expl;
        if (typeof e.modeReasonLabel === "string")
            modeReasonLabel = e.modeReasonLabel;
        if (typeof e.engineReasonLabel === "string")
            engineReasonLabel = e.engineReasonLabel;
        if (typeof e.riskReasonLabel === "string")
            riskReasonLabel = e.riskReasonLabel;
        if (isRoutingKind(e.activeEngine))
            activeEngine = e.activeEngine;
        if (isNewEntryPolicy(e.newEntryPolicy))
            newEntryPolicy = e.newEntryPolicy;
    }
    const mm = o.market_mode_selector;
    if ((!modeReasonLabel || !engineReasonLabel) && mm && typeof mm === "object") {
        const m = mm;
        if (!modeReasonLabel && typeof m.modeReasonLabel === "string")
            modeReasonLabel = m.modeReasonLabel;
        const r = m.routing;
        if (r && typeof r === "object") {
            const rr = r;
            if (!engineReasonLabel && typeof rr.routingReasonLabel === "string") {
                engineReasonLabel = `라우팅: ${rr.routingReasonLabel}`;
            }
            if (isRoutingKind(rr.activeEngine))
                activeEngine = rr.activeEngine;
            if (isNewEntryPolicy(rr.newEntryPolicy))
                newEntryPolicy = rr.newEntryPolicy;
        }
    }
    const risk = o.risk_exposure;
    let riskStanceLabel = "";
    if (risk && typeof risk === "object") {
        const rx = risk;
        if (!riskReasonLabel && typeof rx.riskReasonLabel === "string")
            riskReasonLabel = rx.riskReasonLabel;
        if (typeof rx.riskStanceLabel === "string")
            riskStanceLabel = rx.riskStanceLabel;
    }
    let lastExitReasonLabel = "";
    let lastSwitchReasonLabel = "";
    if (typeof o.last_exit_reason === "string")
        lastExitReasonLabel = o.last_exit_reason;
    if (typeof o.last_switch_reason === "string")
        lastSwitchReasonLabel = o.last_switch_reason;
    if (expl && typeof expl === "object") {
        const e = expl;
        if (!lastExitReasonLabel && typeof e.exitReasonLabel === "string")
            lastExitReasonLabel = e.exitReasonLabel;
        if (!lastSwitchReasonLabel && typeof e.switchReasonLabel === "string")
            lastSwitchReasonLabel = e.switchReasonLabel;
    }
    if (!modeReasonLabel)
        modeReasonLabel = "시장 모드 정보 없음";
    if (!engineReasonLabel)
        engineReasonLabel = "엔진 라우팅 정보 없음";
    if (!riskReasonLabel)
        riskReasonLabel = "리스크 정보 없음";
    if (!lastExitReasonLabel)
        lastExitReasonLabel = "직전 청산 없음";
    if (!lastSwitchReasonLabel)
        lastSwitchReasonLabel = "직전 스위칭 없음";
    const symbolDecisionsRaw = o.symbol_decisions ?? {};
    const symbolDecisionRows = Object.values(symbolDecisionsRaw);
    const selectedDecisionMeta = symbolDecisionRows.find((d) => d?.v2_decision === "ENTER") ??
        symbolDecisionRows[0] ??
        null;
    const policyLine = newEntryPolicy === "full"
        ? "진입 정책: 전량"
        : newEntryPolicy === "reduced"
            ? "진입 정책: 축소"
            : "진입 정책: 보류";
    const engineLineShort = activeEngine === "RANGE"
        ? "운용: RANGE 양방향"
        : activeEngine === "TREND"
            ? "운용: TREND 돌파"
            : "운용: 대기";
    const stanceLine = riskStanceLabel.trim().length > 0
        ? `공격/보수: ${riskStanceLabel}`
        : `공격/보수: ${riskReasonLabel.includes("정상") ? "보통" : "주의"}`;
    const dashboardLines = {
        currentMarketJudgment: `시장 판단: ${modeReasonLabel}`,
        currentActiveEngine: engineLineShort,
        newEntryPolicyLine: policyLine,
        currentRiskState: riskReasonLabel.startsWith("리스크:") ? riskReasonLabel : `리스크: ${riskReasonLabel}`,
        stanceLine,
        lastExitReasonLine: `직전 종료: ${lastExitReasonLabel}`,
        lastSwitchReasonLine: `직전 전환: ${lastSwitchReasonLabel}`
    };
    return {
        modeReasonLabel,
        engineReasonLabel,
        riskReasonLabel,
        activeEngine,
        newEntryPolicy,
        lastExitReasonLabel,
        lastSwitchReasonLabel,
        dashboardLines,
        exchange: o.exchange || "okx",
        okx_demo_enabled: !!o.okx_demo_enabled,
        okx_demo_keys_loaded: !!o.okx_demo_keys_loaded,
        okx_signed_rest_ready: !!o.okx_signed_rest_ready,
        okx_account_config_ok: !!o.okx_account_config_ok,
        okx_balance_ok: !!o.okx_balance_ok,
        okx_positions_ok: !!o.okx_positions_ok,
        okx_order_submit_ok: !!o.okx_order_submit_ok,
        paper_execution_ready: !!o.paper_execution_ready,
        signed_execution_ready: !!o.signed_execution_ready,
        signed_submit_mode: o.signed_submit_mode === "enabled" || o.signed_submit_mode === "skipped_not_ready" || o.signed_submit_mode === "paper_only"
            ? o.signed_submit_mode
            : "paper_only",
        signed_submit_block_reason: typeof o.signed_submit_block_reason === "string" ? o.signed_submit_block_reason : null,
        strategy_executor: o.strategy_executor || activeEngine,
        current_regime: o.current_regime || (activeEngine === "IDLE" ? "NO_TRADE" : activeEngine),
        entryAllowedLong: !!o.entryAllowedLong,
        entryAllowedShort: !!o.entryAllowedShort,
        directional_shock_state: String(o.directional_shock_state ?? "NONE"),
        long_allow: !!o.long_allow,
        short_allow: !!o.short_allow,
        server_trade_enabled: !!o.server_trade_enabled,
        close_only_mode: !!o.close_only_mode,
        close_only_mode_effective: !!o.close_only_mode_effective,
        serverTradeEnabled: !!(o.serverTradeEnabled ?? o.server_trade_enabled),
        closeOnlyMode: !!(o.closeOnlyMode ?? o.close_only_mode),
        closeOnlyModeEffective: !!(o.closeOnlyModeEffective ?? o.close_only_mode_effective),
        killSwitch: !!(o.killSwitch ?? o.kill_switch_active),
        reconcileSafeMode: !!(o.reconcileSafeMode ?? o.reconcile_safe_mode_active),
        entry_quality_grade: selectedDecisionMeta && typeof selectedDecisionMeta.entry_quality_grade === "string"
            ? selectedDecisionMeta.entry_quality_grade
            : null,
        leverage_profile: selectedDecisionMeta && typeof selectedDecisionMeta.leverage_profile === "string"
            ? selectedDecisionMeta.leverage_profile
            : null,
        applied_leverage: selectedDecisionMeta && typeof selectedDecisionMeta.applied_leverage === "number"
            ? selectedDecisionMeta.applied_leverage
            : null,
        leverage_reason: selectedDecisionMeta && typeof selectedDecisionMeta.leverage_reason === "string"
            ? selectedDecisionMeta.leverage_reason
            : null,
        leverage_block_reason: selectedDecisionMeta && typeof selectedDecisionMeta.leverage_block_reason === "string"
            ? selectedDecisionMeta.leverage_block_reason
            : null,
        exposure_notional_krw: selectedDecisionMeta && typeof selectedDecisionMeta.exposure_notional_krw === "number"
            ? selectedDecisionMeta.exposure_notional_krw
            : null,
        equity_multiple: selectedDecisionMeta && typeof selectedDecisionMeta.equity_multiple === "number"
            ? selectedDecisionMeta.equity_multiple
            : null,
        authority_source: typeof o.authority_source === "string" ? o.authority_source : undefined,
        fresh_tick_age_ms: typeof o.fresh_tick_age_ms === "number" ? o.fresh_tick_age_ms : null,
        snapshot_age_ms: typeof o.snapshot_age_ms === "number" ? o.snapshot_age_ms : null,
        position_tracking_alive: !!o.position_tracking_alive,
        entry_pipeline_ready: !!o.entry_pipeline_ready,
        exit_pipeline_ready: !!o.exit_pipeline_ready,
        reconcile_safe_mode_active: !!o.reconcile_safe_mode_active,
        reconcile_last_mismatch_reason: typeof o.reconcile_last_mismatch_reason === "string" ? o.reconcile_last_mismatch_reason : null,
        symbol_decisions: o.symbol_decisions || {},
        // OKX Real-time Balance Fields Mapping
        okx_wallet_balance_usdt: typeof o.okx_wallet_balance_usdt === "number" ? o.okx_wallet_balance_usdt : null,
        okx_available_balance_usdt: typeof o.okx_available_balance_usdt === "number" ? o.okx_available_balance_usdt : null,
        okx_used_margin_usdt: typeof o.okx_used_margin_usdt === "number" ? o.okx_used_margin_usdt : null,
        okx_total_position_notional_usdt: typeof o.okx_total_position_notional_usdt === "number" ? o.okx_total_position_notional_usdt : null,
        okx_unrealized_pnl_usdt: typeof o.okx_unrealized_pnl_usdt === "number" ? o.okx_unrealized_pnl_usdt : null,
        okx_total_equity_usdt: typeof o.okx_total_equity_usdt === "number" ? o.okx_total_equity_usdt : null,
        usdt_frozen_bal: typeof o.usdt_frozen_bal === "number" ? o.usdt_frozen_bal : null,
        okx_balance_updated_at: typeof o.okx_balance_updated_at === "number" ? o.okx_balance_updated_at : undefined
    };
}
function isPaperLedgerPositionOpen(x) {
    if (!x || typeof x !== "object")
        return false;
    const st = x.status;
    return st === undefined || st === "open";
}
/**
 * UI `/futures-paper` current-positions path: ledger `open.json` first; if empty,
 * read-only rows from `engineState.ledger_okx_position_sync` + `position_ops_surface`
 * (OKX-only / mismatch diagnostics — does not submit orders).
 */
function deriveCurrentPositionsForDisplay(engineState, openPositions) {
    const ledgerOpen = Array.isArray(openPositions) ? openPositions.filter(isPaperLedgerPositionOpen) : [];
    if (ledgerOpen.length > 0)
        return ledgerOpen;
    if (!engineState || typeof engineState !== "object")
        return [];
    const es = engineState;
    const sync = es.ledger_okx_position_sync;
    const ops = es.position_ops_surface;
    const previews = sync && typeof sync === "object" && Array.isArray(sync.okx_positions_preview)
        ? sync.okx_positions_preview
        : [];
    const opRows = ops && typeof ops === "object" && Array.isArray(ops.rows)
        ? ops.rows
        : [];
    const tsFallback = typeof es.generatedAt === "number" && Number.isFinite(es.generatedAt) ? es.generatedAt : Date.now();
    function surfaceRowFor(sym, side) {
        return opRows.find((r) => String(r.symbol ?? "") === sym && String(r.side ?? "") === side);
    }
    function rowDisplayPayload(match) {
        if (!match)
            return { entryPrice: null };
        const ref = match.reference_entry_px;
        const avg = match.okx_avg_px;
        const entryPrice = typeof ref === "number" && Number.isFinite(ref)
            ? ref
            : typeof avg === "number" && Number.isFinite(avg)
                ? avg
                : null;
        return { entryPrice };
    }
    if (previews.length > 0) {
        return previews.map((p) => {
            const sym = String(p.symbol ?? "");
            const side = p.side === "short" ? "short" : "long";
            const match = surfaceRowFor(sym, side);
            const { entryPrice } = rowDisplayPayload(match);
            const ledgerSl = match && typeof match.ledger_stop_px === "number" && Number.isFinite(match.ledger_stop_px)
                ? match.ledger_stop_px
                : null;
            const mirrorSl = match &&
                typeof match.initial_stop_px_engine_mirror === "number" &&
                Number.isFinite(match.initial_stop_px_engine_mirror)
                ? match.initial_stop_px_engine_mirror
                : null;
            const ledgerTp = match && typeof match.ledger_tp_px === "number" && Number.isFinite(match.ledger_tp_px) ? match.ledger_tp_px : null;
            const mirrorTp = match &&
                typeof match.initial_tp_px_engine_mirror === "number" &&
                Number.isFinite(match.initial_tp_px_engine_mirror)
                ? match.initial_tp_px_engine_mirror
                : null;
            return {
                symbol: sym,
                side,
                status: "open",
                entryPrice,
                openedAt: tsFallback,
                displaySource: "ledger_okx_sync_preview",
                okxPositionContracts: typeof p.pos === "number" && Number.isFinite(p.pos) ? p.pos : null,
                instId: typeof p.instId === "string" ? p.instId : null,
                stopPrice: ledgerSl ?? undefined,
                takeProfit: ledgerTp ?? undefined,
                policy_mirror_stop_px_fallback: ledgerSl == null && mirrorSl != null ? mirrorSl : undefined,
                policy_mirror_tp_px_fallback: ledgerTp == null && mirrorTp != null ? mirrorTp : undefined,
                reduce_only_protective_found: typeof match?.reduce_only_protective_found === "boolean" ? match.reduce_only_protective_found : undefined
            };
        });
    }
    if (opRows.length > 0) {
        return opRows.map((row) => {
            const sym = String(row.symbol ?? "");
            const side = row.side === "short" ? "short" : "long";
            const { entryPrice } = rowDisplayPayload(row);
            const ledgerSl = typeof row.ledger_stop_px === "number" && Number.isFinite(row.ledger_stop_px) ? row.ledger_stop_px : null;
            const mirrorSl = typeof row.initial_stop_px_engine_mirror === "number" && Number.isFinite(row.initial_stop_px_engine_mirror)
                ? row.initial_stop_px_engine_mirror
                : null;
            const ledgerTp = typeof row.ledger_tp_px === "number" && Number.isFinite(row.ledger_tp_px) ? row.ledger_tp_px : null;
            const mirrorTp = typeof row.initial_tp_px_engine_mirror === "number" && Number.isFinite(row.initial_tp_px_engine_mirror)
                ? row.initial_tp_px_engine_mirror
                : null;
            return {
                symbol: sym,
                side,
                status: "open",
                entryPrice,
                openedAt: tsFallback,
                displaySource: "position_ops_surface",
                inst_id: typeof row.inst_id === "string" ? row.inst_id : null,
                stopPrice: ledgerSl ?? undefined,
                takeProfit: ledgerTp ?? undefined,
                policy_mirror_stop_px_fallback: ledgerSl == null && mirrorSl != null ? mirrorSl : undefined,
                policy_mirror_tp_px_fallback: ledgerTp == null && mirrorTp != null ? mirrorTp : undefined,
                reduce_only_protective_found: typeof row.reduce_only_protective_found === "boolean" ? row.reduce_only_protective_found : undefined
            };
        });
    }
    return [];
}
async function readJsonFile(filePath) {
    try {
        const raw = await promises_1.default.readFile(filePath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
async function readNoEntryAuditFromDataDir(dataDir) {
    const parsed = await readJsonFile(node_path_1.default.join(dataDir, "runtime", "latest-no-entry-audit.json"));
    if (!parsed || typeof parsed !== "object")
        return null;
    const o = parsed;
    const updatedAt = typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt) ? o.updatedAt : 0;
    const rawBy = o.bySymbol;
    const bySymbol = {};
    if (rawBy && typeof rawBy === "object" && !Array.isArray(rawBy)) {
        for (const [k, v] of Object.entries(rawBy)) {
            if (!v || typeof v !== "object" || Array.isArray(v))
                continue;
            bySymbol[k] = v;
        }
    }
    return { updatedAt, bySymbol };
}
function bundleNoEntryAuditFields(doc) {
    if (!doc)
        return { noEntryAudit: null, noEntryAuditBySymbol: null };
    return { noEntryAudit: doc, noEntryAuditBySymbol: doc.bySymbol };
}
function pickSymbolRows(latest) {
    if (!latest || typeof latest !== "object")
        return [];
    const o = latest;
    const snaps = o.snapshots;
    if (!Array.isArray(snaps))
        return [];
    const want = new Set(["BTCUSDT", "ETHUSDT"]);
    const out = [];
    for (const s of snaps) {
        if (!s || typeof s !== "object")
            continue;
        const r = s;
        const sym = String(r.symbol ?? "");
        if (!want.has(sym))
            continue;
        const strength = r.candidateStrength === "strong" || r.candidateStrength === "weak" ? r.candidateStrength : undefined;
        out.push({
            symbol: sym,
            signal: typeof r.signal === "string" ? r.signal : undefined,
            trendOk: typeof r.trendOk === "boolean" ? r.trendOk : undefined,
            candidateStrength: strength,
            sidewaysMode: typeof r.sidewaysMode === "boolean" ? r.sidewaysMode : undefined,
            entryCandidate: typeof r.entryCandidate === "boolean" ? r.entryCandidate : undefined,
            qualityScore: typeof r.qualityScore === "number" ? r.qualityScore : undefined,
            emaGap: typeof r.emaGap === "number" ? r.emaGap : undefined,
            volumeRatioProxy: typeof r.volumeRatioProxy === "number" ? r.volumeRatioProxy : undefined,
            boxHigh: typeof r.boxHigh === "number" ? r.boxHigh : undefined,
            boxLow: typeof r.boxLow === "number" ? r.boxLow : undefined,
            boxPos: typeof r.boxPos === "number" ? r.boxPos : undefined,
            boxRel: typeof r.boxRel === "number" ? r.boxRel : undefined,
            gateExpectedMove: typeof r.gateExpectedMove === "number" ? r.gateExpectedMove : undefined,
            gateRequiredMove: typeof r.gateRequiredMove === "number" ? r.gateRequiredMove : undefined,
            lastPrice: typeof r.lastPrice === "number" ? r.lastPrice : undefined,
            fundingRate: typeof r.fundingRate === "number" ? r.fundingRate : undefined,
            fetchedAt: typeof r.fetchedAt === "number" ? r.fetchedAt : undefined
        });
    }
    return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
async function readPositionsHistoryArray(dataDir) {
    const p = node_path_1.default.join(dataDir, "positions", "history.json");
    try {
        const raw = await promises_1.default.readFile(p, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
async function readPositionsOpenArray(dataDir) {
    const p = node_path_1.default.join(dataDir, "positions", "open.json");
    try {
        const raw = await promises_1.default.readFile(p, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
async function readHealthHistoryTail(dataDir, maxLines) {
    const p = node_path_1.default.join(dataDir, "reports", "health-history.jsonl");
    const tail = await (0, file_utils_1.readLastLines)(p, maxLines);
    const out = [];
    for (const line of tail) {
        try {
            const j = JSON.parse(line);
            out.push({
                generatedAt: typeof j.generatedAt === "number" ? j.generatedAt : undefined,
                status: typeof j.status === "string" ? j.status : undefined,
                reasons: Array.isArray(j.reasons) ? j.reasons.filter((x) => typeof x === "string") : undefined
            });
        }
        catch {
            /* skip bad line */
        }
    }
    return out;
}
async function readEventsTail(dataDir, maxLines) {
    const p = node_path_1.default.join(dataDir, "reports", "events.jsonl");
    const tail = await (0, file_utils_1.readLastLines)(p, maxLines);
    const out = [];
    for (const line of tail) {
        try {
            out.push(JSON.parse(line));
        }
        catch {
            /* skip bad line */
        }
    }
    return out;
}
const PUBLIC_BUNDLE_REL_PARTS = ["data", "reports", "public-futures-paper-bundle.json"];
function publishedBundlePath(projectRoot) {
    return node_path_1.default.join(node_path_1.default.resolve(projectRoot.trim()), ...PUBLIC_BUNDLE_REL_PARTS);
}
function isFiniteRecordBundle(x) {
    if (!x || typeof x !== "object")
        return false;
    const o = x;
    if (o.configured !== true)
        return false;
    if (typeof o.generatedAt !== "number" || !Number.isFinite(o.generatedAt))
        return false;
    if (!Array.isArray(o.openPositions))
        return false;
    if (!Array.isArray(o.positionsHistory))
        return false;
    if (!Array.isArray(o.eventsRecent))
        return false;
    if (!Array.isArray(o.symbolRows))
        return false;
    return true;
}
/** Prefer the prebuilt public bundle (single-file read) when present and valid. */
async function tryReadPublishedPublicBundle(projectRoot) {
    try {
        const raw = await promises_1.default.readFile(publishedBundlePath(projectRoot), "utf8");
        const parsed = JSON.parse(raw);
        if (!isFiniteRecordBundle(parsed))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function mapHealthHistorySlice(lines) {
    const out = [];
    for (const line of lines) {
        if (!line || typeof line !== "object")
            continue;
        const j = line;
        out.push({
            generatedAt: typeof j.generatedAt === "number" ? j.generatedAt : undefined,
            status: typeof j.status === "string" ? j.status : undefined,
            reasons: Array.isArray(j.reasons) ? j.reasons.filter((x) => typeof x === "string") : undefined
        });
    }
    return out;
}
async function composePublicFuturesPaperBundleForWrite(input) {
    const root = node_path_1.default.resolve(input.projectRoot.trim());
    const dataDir = node_path_1.default.join(root, "data");
    const [engineState, latestSnapshot, latestMeta, openPositions] = await Promise.all([
        readJsonFile(node_path_1.default.join(dataDir, "reports", "engine-state.json")),
        readJsonFile(node_path_1.default.join(dataDir, "snapshots", "latest.json")),
        readJsonFile(node_path_1.default.join(dataDir, "snapshots", "latest-meta.json")),
        readPositionsOpenArray(dataDir)
    ]);
    const symbolRows = pickSymbolRows(latestSnapshot);
    const eventsRecent = input.eventsParsed.slice(-20);
    const healthHistoryRecent = mapHealthHistorySlice(input.healthHistoryParsed.slice(-10));
    const positionsHistory = (0, paperClosedHistoryNormalize_1.normalizePositionsHistoryArray)(input.positionsHistoryRaw);
    const generatedAt = Date.now();
    const ledgerPerformance = (0, futuresPaperLedgerStats_1.buildLedgerPerformanceFromHistory)(positionsHistory, generatedAt);
    const paperOperational = paperOperationalFromEngineState(engineState);
    const currentPositions = deriveCurrentPositionsForDisplay(engineState, openPositions);
    const noEntryAuditDoc = await readNoEntryAuditFromDataDir(dataDir);
    const { noEntryAudit, noEntryAuditBySymbol } = bundleNoEntryAuditFields(noEntryAuditDoc);
    return {
        configured: true,
        configHint: null,
        summary: input.summary,
        summaryRange: input.summaryRange,
        summaryTrend: input.summaryTrend,
        summaryDaily: input.summaryDaily,
        summaryWindow: input.summaryWindow,
        summaryHealth: input.summaryHealth,
        dashboard: input.dashboard,
        engineState,
        paperOperational,
        latestSnapshot,
        latestMeta,
        symbolRows,
        healthHistoryRecent,
        ledgerPerformance,
        openPositions,
        currentPositions,
        positionsHistory,
        eventsRecent,
        generatedAt,
        noEntryAudit,
        noEntryAuditBySymbol
    };
}
/**
 * Full disk assembly (bootstrap / missing public bundle). Avoid on hot request paths.
 */
async function assembleFuturesPaperBundleFromDiskSources(projectRoot) {
    const root = node_path_1.default.resolve(projectRoot.trim());
    const dataDir = node_path_1.default.join(root, "data");
    const reports = node_path_1.default.join(dataDir, "reports");
    const snaps = node_path_1.default.join(dataDir, "snapshots");
    const [summary, summaryRange, summaryTrend, summaryDaily, summaryWindow, summaryHealth, dashboard, engineState, latestSnapshot, latestMeta] = await Promise.all([
        readJsonFile(node_path_1.default.join(reports, "summary.json")),
        readJsonFile(node_path_1.default.join(reports, "summary-range.json")),
        readJsonFile(node_path_1.default.join(reports, "summary-trend.json")),
        readJsonFile(node_path_1.default.join(reports, "summary-daily.json")),
        readJsonFile(node_path_1.default.join(reports, "summary-window.json")),
        readJsonFile(node_path_1.default.join(reports, "summary-health.json")),
        readJsonFile(node_path_1.default.join(reports, "dashboard.json")),
        readJsonFile(node_path_1.default.join(reports, "engine-state.json")),
        readJsonFile(node_path_1.default.join(snaps, "latest.json")),
        readJsonFile(node_path_1.default.join(snaps, "latest-meta.json"))
    ]);
    const [symbolRows, healthHistoryRecent, positionsHistoryRaw, openPositions, eventsRecent] = await Promise.all([
        Promise.resolve(pickSymbolRows(latestSnapshot)),
        readHealthHistoryTail(dataDir, 10),
        readPositionsHistoryArray(dataDir),
        readPositionsOpenArray(dataDir),
        readEventsTail(dataDir, 20)
    ]);
    const positionsHistory = (0, paperClosedHistoryNormalize_1.normalizePositionsHistoryArray)(positionsHistoryRaw);
    const generatedAt = Date.now();
    const ledgerPerformance = (0, futuresPaperLedgerStats_1.buildLedgerPerformanceFromHistory)(positionsHistory, generatedAt);
    const paperOperational = paperOperationalFromEngineState(engineState);
    const currentPositions = deriveCurrentPositionsForDisplay(engineState, openPositions);
    const noEntryAuditDoc = await readNoEntryAuditFromDataDir(dataDir);
    const { noEntryAudit, noEntryAuditBySymbol } = bundleNoEntryAuditFields(noEntryAuditDoc);
    return {
        configured: true,
        configHint: null,
        summary,
        summaryRange,
        summaryTrend,
        summaryDaily,
        summaryWindow,
        summaryHealth,
        dashboard,
        engineState,
        paperOperational,
        latestSnapshot,
        latestMeta,
        symbolRows,
        healthHistoryRecent,
        ledgerPerformance,
        openPositions,
        currentPositions,
        positionsHistory,
        eventsRecent,
        generatedAt,
        noEntryAudit,
        noEntryAuditBySymbol
    };
}
/**
 * Read orbitalpha-futures-paper `data/` from a local project root (Lightsail or dev).
 * When `data/reports/public-futures-paper-bundle.json` exists, returns it with a single read.
 */
async function loadFuturesPaperBundleFromDiskRoot(projectRoot) {
    const root = node_path_1.default.resolve(projectRoot.trim());
    const dataDir = node_path_1.default.join(root, "data");
    const published = await tryReadPublishedPublicBundle(projectRoot);
    const noEntryAuditDoc = await readNoEntryAuditFromDataDir(dataDir);
    const { noEntryAudit, noEntryAuditBySymbol } = bundleNoEntryAuditFields(noEntryAuditDoc);
    if (published) {
        const openPositions = Array.isArray(published.openPositions) ? published.openPositions : [];
        return {
            ...published,
            openPositions,
            currentPositions: deriveCurrentPositionsForDisplay(published.engineState, openPositions),
            noEntryAudit,
            noEntryAuditBySymbol
        };
    }
    return assembleFuturesPaperBundleFromDiskSources(projectRoot);
}
