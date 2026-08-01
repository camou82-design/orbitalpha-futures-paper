"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.regimeForSl = regimeForSl;
exports.engineMirrorStopPrice = engineMirrorStopPrice;
exports.engineMirrorTpPrice = engineMirrorTpPrice;
exports.orderLooksReduceOnlyProtective = orderLooksReduceOnlyProtective;
exports.findProtectiveHintsForInst = findProtectiveHintsForInst;
exports.buildPositionOpsSurface = buildPositionOpsSurface;
const regime_exit_1 = require("../strategy/regime-exit");
const okx_position_sync_1 = require("../exchange/okx-position-sync");
function toFinite(raw) {
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
}
function regimeForSl(raw) {
    return raw === "RANGE" || raw === "TREND" || raw === "NO_TRADE" ? raw : "NO_TRADE";
}
function engineMirrorStopPrice(entryPx, side, regime) {
    if (!(entryPx > 0))
        return null;
    const slPct = (0, regime_exit_1.stopLossPctForRegime)(regime);
    return side === "long" ? entryPx * (1 + slPct) : entryPx * (1 - slPct);
}
function engineMirrorTpPrice(entryPx, side, regime) {
    if (!(entryPx > 0))
        return null;
    const tpPct = (0, regime_exit_1.takeProfitPctForRegime)(regime);
    return side === "long" ? entryPx * (1 + tpPct) : entryPx * (1 - tpPct);
}
function instIdMatchesRow(instId, rowInst) {
    return String(rowInst) === instId;
}
function stringifyHints(o) {
    const id = o.algoId ?? o.ordId ?? "?";
    const typ = o.ordType ?? o.orderType ?? "?";
    const ro = o.reduceOnly;
    const trig = o.slTriggerPx ?? o.tpTriggerPx ?? o.triggerPx ?? o.stopPx ?? o.trigPx ?? "";
    return `${String(id)}|${String(typ)}|ro=${String(ro)}|tr=${String(trig)}`;
}
function orderLooksReduceOnlyProtective(o) {
    const ro = o.reduceOnly;
    const roOk = ro === true || String(ro).toLowerCase() === "true";
    if (!roOk)
        return false;
    const typ = String(o.ordType ?? o.orderType ?? "").toLowerCase();
    if (typ.includes("conditional") ||
        typ === "trigger" ||
        typ === "stop" ||
        typ.includes("oco") ||
        typ.includes("move_order_stop")) {
        return true;
    }
    if (o.slTriggerPx != null ||
        o.tpTriggerPx != null ||
        o.triggerPx != null ||
        o.stopPx != null ||
        o.trigPx != null)
        return true;
    return false;
}
function orderMatchesPositionSide(o, positionSide) {
    const ps = String(o.posSide ?? "").trim().toLowerCase();
    if (!ps || ps === "net")
        return true;
    return ps === positionSide;
}
function findProtectiveHintsForInst(instId, positionSide, pending, algos, tpRequired) {
    const hints = [];
    let foundSlPrice = null;
    let foundTpPrice = null;
    let matchingProtectiveOrderCount = 0;
    let protectionSatisfied = false;
    const extractSlPx = (o) => {
        const val = o.slTriggerPx ?? o.triggerPx ?? o.stopPx ?? o.trigPx;
        const n = typeof val === "number" ? val : typeof val === "string" ? Number(val) : NaN;
        return Number.isFinite(n) && n > 0 ? n : null;
    };
    const extractTpPx = (o) => {
        const val = o.tpTriggerPx;
        const n = typeof val === "number" ? val : typeof val === "string" ? Number(val) : NaN;
        return Number.isFinite(n) && n > 0 ? n : null;
    };
    const consider = (o, prefix) => {
        if (!instIdMatchesRow(instId, String(o.instId ?? "")))
            return;
        if (!orderMatchesPositionSide(o, positionSide))
            return;
        if (!orderLooksReduceOnlyProtective(o))
            return;
        hints.push(`${prefix}:${stringifyHints(o)}`);
        matchingProtectiveOrderCount += 1;
        const slPx = extractSlPx(o);
        const tpPx = extractTpPx(o);
        const slOk = slPx != null;
        const tpOk = !tpRequired || (tpPx != null && tpPx > 0);
        if (slOk && tpOk) {
            protectionSatisfied = true;
            if (foundSlPrice == null && slPx != null)
                foundSlPrice = slPx;
            if (foundTpPrice == null && tpPx != null)
                foundTpPrice = tpPx;
        }
        else {
            if (foundSlPrice == null && slPx != null)
                foundSlPrice = slPx;
            if (foundTpPrice == null && tpPx != null)
                foundTpPrice = tpPx;
        }
    };
    for (const o of algos)
        consider(o, "algo");
    for (const o of pending)
        consider(o, "pend");
    return {
        protectionSatisfied,
        hints,
        slPrice: foundSlPrice,
        tpPrice: foundTpPrice,
        matchingProtectiveOrderCount
    };
}
function matchLedgerRow(opens, symbol, side) {
    for (const p of opens) {
        if ((p.status ?? "open") !== "open")
            continue;
        if (p.lifecycleState === "FAILED")
            continue;
        if (String(p.symbol) !== symbol)
            continue;
        const ps = String(p.side).toLowerCase() === "short" ? "short" : "long";
        if (ps !== side)
            continue;
        return p;
    }
    return null;
}
function bannerKo(b) {
    switch (b) {
        case "NO_POSITION":
            return "열린 스왑 포지션 없음";
        case "REMOTE_UNAVAILABLE":
            return "OKX 포지션 스냅샷 없음 · 감시 제한";
        case "RECONCILE_MISMATCH":
            return "실거래소 포지션 / 장부 불일치 / 자동관리 제한";
        case "MONITORING_NO_PROTECT_WARNING":
            return "감시 중 · 보호(reduce-only) 주문 없음";
        case "MONITORING_RISK_PLAN_MISSING_WARNING":
            return "보호값 없음 / 조치 필요";
        case "MONITORING_PROTECT_DETECTED":
            return "감시 중 · 보호 주문 확인됨";
        case "MONITORING_SCAN_PENDING":
            return "감시 중 · 보호 주문 스캔 대기";
        default:
            return b;
    }
}
function buildPositionOpsSurface(input) {
    const instMap = input.instrumentByInstId && input.instrumentByInstId.size > 0
        ? new Map(input.instrumentByInstId)
        : undefined;
    const sync = (0, okx_position_sync_1.buildLedgerOkxPositionSyncSnapshot)(input.paperOpens, input.okxPayload, instMap);
    const pending = input.pendingOrders ?? [];
    const algos = input.algoOrders ?? [];
    const rows = [];
    const payload = input.okxPayload;
    if (payload && Array.isArray(payload)) {
        for (const raw of payload) {
            const hit = (0, okx_position_sync_1.okxSwapRowToLedgerKey)(raw);
            if (!hit)
                continue;
            const avgPx = toFinite(raw.avgPx);
            const ledger = matchLedgerRow(input.paperOpens, hit.symbol, hit.side);
            const refPx = ledger?.entryPrice && ledger.entryPrice > 0 ? ledger.entryPrice : avgPx;
            const refSrc = ledger ? "paper_ledger" : avgPx != null ? "okx_avgPx" : "none";
            const regime = regimeForSl(ledger?.regimeAtEntry);
            const slNet = (0, regime_exit_1.stopLossPctForRegime)(regime);
            const stopPx = refPx != null && refPx > 0 ? engineMirrorStopPrice(refPx, hit.side, regime) : null;
            const tpPx = refPx != null && refPx > 0 ? engineMirrorTpPrice(refPx, hit.side, regime) : null;
            const ledgerStop = typeof ledger?.stopPrice === "number" && Number.isFinite(ledger.stopPrice) ? ledger.stopPrice : null;
            const ledgerTp = typeof ledger?.targetPrice1 === "number" && Number.isFinite(ledger.targetPrice1) ? ledger.targetPrice1 : null;
            const tpRequired = (ledgerTp != null && ledgerTp > 0) || (tpPx != null && tpPx > 0 && Number.isFinite(tpPx));
            const { protectionSatisfied, hints, slPrice: exchStopPx, tpPrice: exchTpPx, matchingProtectiveOrderCount } = findProtectiveHintsForInst(hit.instId, hit.side, pending, algos, tpRequired);
            let pxSource = "none";
            if (exchStopPx != null)
                pxSource = "exchange_order";
            else if (ledgerStop != null)
                pxSource = "ledger_stored";
            else if (stopPx != null)
                pxSource = "engine_calculated";
            let tpSource = "none";
            if (exchTpPx != null)
                tpSource = "exchange_order";
            else if (ledgerTp != null)
                tpSource = "ledger_stored";
            else if (tpPx != null)
                tpSource = "engine_calculated";
            rows.push({
                symbol: hit.symbol,
                side: hit.side,
                inst_id: hit.instId,
                okx_avg_px: avgPx,
                reference_entry_px: refPx,
                reference_source: refSrc,
                regime_for_sl: regime,
                policy_sl_net_frac: slNet,
                initial_stop_px_engine_mirror: stopPx,
                initial_tp_px_engine_mirror: tpPx,
                ledger_stop_px: ledgerStop,
                exchange_stop_px: exchStopPx,
                stop_px_source: pxSource,
                ledger_tp_px: ledgerTp,
                exchange_tp_px: exchTpPx,
                tp_px_source: tpSource,
                okx_pos_signed: hit.posSigned,
                matching_protective_pending_count: matchingProtectiveOrderCount,
                tp_required_for_exchange_protection: tpRequired,
                reduce_only_protective_found: protectionSatisfied,
                protective_match_hints: hints,
                reconcile_state: ledger?.reconcileState ?? "NONE",
                sync_status: ledger ? (sync.sync_status === "ALIGNED" ? "ALIGNED" : sync.sync_status) : "OKX_GHOST",
                can_adopt: ledger?.reconcileState === "RECONCILE_MISMATCH"
            });
        }
    }
    let surface_banner;
    if (sync.sync_status === "REMOTE_UNAVAILABLE") {
        if (sync.paper_open_position_count === 0 && sync.okx_nonzero_position_count === 0) {
            surface_banner = "NO_POSITION";
        }
        else {
            surface_banner = "REMOTE_UNAVAILABLE";
        }
    }
    else if (sync.sync_status !== "ALIGNED") {
        surface_banner = "RECONCILE_MISMATCH";
    }
    else if (rows.length === 0) {
        surface_banner = "NO_POSITION";
    }
    else if (!input.ordersScanPerformed) {
        surface_banner = "MONITORING_SCAN_PENDING";
    }
    else {
        const anyRiskMissing = rows.some(r => r.ledger_stop_px == null || !Number.isFinite(r.ledger_stop_px));
        if (anyRiskMissing) {
            surface_banner = "MONITORING_RISK_PLAN_MISSING_WARNING";
        }
        else {
            const anyMissingProtect = rows.some((r) => !r.reduce_only_protective_found);
            surface_banner = anyMissingProtect ? "MONITORING_NO_PROTECT_WARNING" : "MONITORING_PROTECT_DETECTED";
        }
    }
    return {
        generated_at: input.now,
        orders_scan_performed: input.ordersScanPerformed,
        orders_scan_errors: [...input.ordersScanErrors],
        reconcile_sync_status: sync.sync_status,
        surface_banner,
        surface_banner_ko: bannerKo(surface_banner),
        rows
    };
}
