"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateAiBlockedOutcomeHint = evaluateAiBlockedOutcomeHint;
exports.tryUpdateAiBlockedEventEval = tryUpdateAiBlockedEventEval;
exports.isAiBlockedEventNeedingEval = isAiBlockedEventNeedingEval;
exports.toAiBlockedEvalFromEvent = toAiBlockedEvalFromEvent;
exports.buildSymbolPriceMap = buildSymbolPriceMap;
function isFiniteNum(x) {
    return typeof x === "number" && Number.isFinite(x);
}
function pctMoveForDirection(dir, from, to) {
    if (from <= 0)
        return 0;
    const raw = (to - from) / from;
    return dir === "long" ? raw : -raw;
}
function chooseBestHorizon(ev, priority) {
    for (const mins of priority) {
        if (mins === 30 && isFiniteNum(ev.price_after_30m))
            return { mins: 30, price: ev.price_after_30m };
        if (mins === 15 && isFiniteNum(ev.price_after_15m))
            return { mins: 15, price: ev.price_after_15m };
        if (mins === 5 && isFiniteNum(ev.price_after_5m))
            return { mins: 5, price: ev.price_after_5m };
    }
    return null;
}
function evaluateAiBlockedOutcomeHint(ev, criteria) {
    const best = chooseBestHorizon(ev, criteria.evaluation_horizon_priority);
    if (!best)
        return null;
    const move = pctMoveForDirection(ev.executor_direction, ev.blocked_at_price, best.price);
    const goodThresh = (criteria.good_block_threshold_pct ?? -0.25) / 100;
    const missThresh = (criteria.missed_opportunity_threshold_pct ?? 0.35) / 100;
    // If entering would have moved against us => good block.
    if (move <= goodThresh)
        return "good_block";
    // If entering would have moved strongly in our favor => missed opportunity.
    if (move >= missThresh)
        return "missed_opportunity";
    return "neutral";
}
function tryUpdateAiBlockedEventEval(input) {
    const { now } = input;
    const out = { ...input.ev };
    const p = input.symbolPriceNow;
    if (!isFiniteNum(p) || p <= 0) {
        out.hypothetical_outcome_hint = evaluateAiBlockedOutcomeHint(out, input.criteria);
        return out;
    }
    const t = input.ev.ts;
    if (out.price_after_5m === null && now >= t + 5 * 60_000)
        out.price_after_5m = p;
    if (out.price_after_15m === null && now >= t + 15 * 60_000)
        out.price_after_15m = p;
    if (out.price_after_30m === null && now >= t + 30 * 60_000)
        out.price_after_30m = p;
    out.hypothetical_outcome_hint = evaluateAiBlockedOutcomeHint(out, input.criteria);
    return out;
}
function isAiBlockedEventNeedingEval(e) {
    if (!e || typeof e !== "object")
        return false;
    const o = e;
    if (o.type !== "ENTRY_BLOCKED")
        return false;
    const r = o.reason;
    return r === "AI_FILTER" || r === "AI_REJECT" || r === "AI_DIRECTION_MISMATCH";
}
function toAiBlockedEvalFromEvent(e) {
    if (!e || typeof e !== "object")
        return null;
    const o = e;
    const ts = o.ts;
    const symbol = o.symbol;
    const reason = o.reason;
    const dir = o.executor_direction;
    const bap = o.blocked_at_price;
    if (!isFiniteNum(ts) || typeof symbol !== "string" || typeof reason !== "string")
        return null;
    if (dir !== "long" && dir !== "short")
        return null;
    if (!isFiniteNum(bap) || bap <= 0)
        return null;
    return {
        ts,
        symbol,
        reason,
        executor_direction: dir,
        blocked_at_price: bap,
        price_after_5m: isFiniteNum(o.price_after_5m) ? o.price_after_5m : null,
        price_after_15m: isFiniteNum(o.price_after_15m) ? o.price_after_15m : null,
        price_after_30m: isFiniteNum(o.price_after_30m) ? o.price_after_30m : null,
        hypothetical_outcome_hint: o.hypothetical_outcome_hint === "good_block" ||
            o.hypothetical_outcome_hint === "missed_opportunity" ||
            o.hypothetical_outcome_hint === "neutral"
            ? o.hypothetical_outcome_hint
            : null
    };
}
function buildSymbolPriceMap(rows) {
    const m = new Map();
    for (const r of rows) {
        if (r && typeof r.symbol === "string" && isFiniteNum(r.lastPrice)) {
            m.set(r.symbol, r.lastPrice);
        }
    }
    return m;
}
