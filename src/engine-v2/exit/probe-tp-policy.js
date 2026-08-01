"use strict";
/**
 * Probe TP Policy Module (v2 — execution-stage separation)
 * ─────────────────────────────────────────────────────────────────────────────
 * EARLY_REVERSAL_SHORT_PROBE / EARLY_REVERSAL_LONG_PROBE
 * PULLBACK_RETEST_SHORT_CONFIRM / PULLBACK_RETEST_LONG_CONFIRM
 *
 * 실행 단계 엄격 분리:
 *  Stage 0. calculateProbeTpPlan()     → 계획 수립 (V2_PROBE_TP_PLAN_PROOF)
 *  Stage 1. evaluateProbeTP1Submit()   → reduce-only 주문 제출 결정 (V2_PROBE_TP1_SUBMIT_PROOF)
 *  Stage 2. detectProbeTP1Trigger()    → markPrice 도달 감지 [trigger ≠ fill] (V2_PROBE_TP1_TRIGGER_PROOF)
 *  Stage 3. processProbeTP1Fill()      → OKX fill 데이터 주입 후 ledger 반영 (V2_PROBE_TP1_FILL_PROOF)
 *  Stage 4. evaluateProbeBreakevenStop()  → fill 확인 후 본절 이동 (V2_PROBE_BREAKEVEN_STOP_MOVE_PROOF)
 *  Stage 5. evaluateProbeProtectionRealign() → 재정렬 결정 (V2_PROBE_PROTECTION_REALIGN_PROOF)
 *           실제 주문 취소/재등록은 caller(executor)가 수행 후 proof 기록
 *  Stage 6. evaluateProbeTimeStop()    → time stop 후보 감지 (V2_PROBE_TIME_STOP_PROOF)
 *  Stage 7. detectProbePendingStale()  → TP1 submitted 장시간 미체결 경보 (PROBE_TP1_PENDING_STALE)
 *
 * 절대 금지:
 *  - markPrice 통과만으로 TP1_FILL_CONFIRMED 발행 금지
 *  - OKX fill 없이 ledgerUpdated=true / protectionOrderRebuilt=true 발행 금지
 *  - TP1 filled 확인 전 본절 SL 이동 금지
 *  - 실제 fill 전 remainingQty 확정 금지
 *  - market order 추가 금지
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isProbeEntryReason = isProbeEntryReason;
exports.calculateProbeTpPlan = calculateProbeTpPlan;
exports.evaluateProbeTP1Submit = evaluateProbeTP1Submit;
exports.detectProbeTP1Trigger = detectProbeTP1Trigger;
exports.processProbeTP1Fill = processProbeTP1Fill;
exports.evaluateProbeBreakevenStop = evaluateProbeBreakevenStop;
exports.evaluateProbeProtectionRealign = evaluateProbeProtectionRealign;
exports.evaluateProbeTimeStop = evaluateProbeTimeStop;
exports.detectProbePendingStale = detectProbePendingStale;
const PROBE_RULES = {
    EARLY_REVERSAL_SHORT_PROBE: {
        tp1R: 0.45,
        tp1CloseRatio: 0.50,
        finalTpR: 0.85,
        maxHoldBars5m: 4,
        progressGateR: 0.25,
        progressGateBars5m: 4,
        stalePendingBars5m: 6,
    },
    EARLY_REVERSAL_LONG_PROBE: {
        tp1R: 0.45,
        tp1CloseRatio: 0.50,
        finalTpR: 0.85,
        maxHoldBars5m: 4,
        progressGateR: 0.25,
        progressGateBars5m: 4,
        stalePendingBars5m: 6,
    },
    PULLBACK_RETEST_SHORT_CONFIRM: {
        tp1R: 0.65,
        tp1CloseRatio: 0.50,
        finalTpR: 1.10,
        maxHoldBars5m: 8,
        progressGateR: 0.30,
        progressGateBars5m: 6,
        stalePendingBars5m: 10,
    },
    PULLBACK_RETEST_LONG_CONFIRM: {
        tp1R: 0.65,
        tp1CloseRatio: 0.50,
        finalTpR: 1.10,
        maxHoldBars5m: 8,
        progressGateR: 0.30,
        progressGateBars5m: 6,
        stalePendingBars5m: 10,
    },
};
/** taker fee 0.05%×2 + slippage 0.02% — riskDistance 대비 상대값 */
const ROUND_TRIP_COST_R_ESTIMATE = 0.0012;
function isProbeEntryReason(reason) {
    return (reason === "EARLY_REVERSAL_SHORT_PROBE" ||
        reason === "EARLY_REVERSAL_LONG_PROBE" ||
        reason === "PULLBACK_RETEST_SHORT_CONFIRM" ||
        reason === "PULLBACK_RETEST_LONG_CONFIRM");
}
function calculateProbeTpPlan(symbol, side, entryReason, entryPrice, stopPrice) {
    if (!Number.isFinite(entryPrice) || !Number.isFinite(stopPrice))
        return null;
    if (entryPrice <= 0 || stopPrice <= 0)
        return null;
    const riskDistance = Math.abs(entryPrice - stopPrice);
    if (riskDistance <= 0)
        return null;
    if (side === "long" && stopPrice >= entryPrice)
        return null;
    if (side === "short" && stopPrice <= entryPrice)
        return null;
    const rules = PROBE_RULES[entryReason];
    const dirMult = side === "long" ? 1 : -1;
    const tp1Price = entryPrice + dirMult * riskDistance * rules.tp1R;
    const finalTpPrice = entryPrice + dirMult * riskDistance * rules.finalTpR;
    const tp1NetR = rules.tp1R - ROUND_TRIP_COST_R_ESTIMATE;
    const expectedNetProfitAfterCost = tp1NetR * rules.tp1CloseRatio;
    const netPositive = tp1NetR > 0;
    const plan = {
        entryReason, side, entryPrice, stopPrice, riskDistance,
        tp1Price, tp1R: rules.tp1R, tp1CloseRatio: rules.tp1CloseRatio,
        finalTpPrice, finalTpR: rules.finalTpR,
        maxHoldBars5m: rules.maxHoldBars5m,
        stalePendingBars5m: rules.stalePendingBars5m,
        expectedNetProfitAfterCost, netPositive,
    };
    console.info(JSON.stringify({
        event: "V2_PROBE_TP_PLAN_PROOF",
        symbol, side, entryReason, entryPrice, stopPrice, riskDistance,
        tp1Price, tp1R: rules.tp1R, tp1CloseRatio: rules.tp1CloseRatio,
        finalTpPrice, finalTpR: rules.finalTpR,
        maxHoldBars5m: rules.maxHoldBars5m, expectedNetProfitAfterCost,
    }));
    return plan;
}
function evaluateProbeTP1Submit(symbol, side, plan, positionQty, alreadySubmitted, alreadyFilled) {
    if (alreadySubmitted || alreadyFilled)
        return null;
    if (!plan.netPositive) {
        console.info(JSON.stringify({
            event: "V2_PROBE_TP1_SUBMIT_PROOF",
            symbol, side,
            qty: 0, tp1Price: plan.tp1Price, reduceOnly: true,
            entryReason: plan.entryReason,
            reason: "NET_PROFIT_NEGATIVE_AFTER_COST_SKIP",
            submitted: false,
        }));
        return null;
    }
    const qty = positionQty * plan.tp1CloseRatio;
    if (qty <= 0)
        return null;
    const decision = {
        shouldSubmit: true, qty,
        tp1Price: plan.tp1Price, reduceOnly: true,
        entryReason: plan.entryReason,
        reason: "PROBE_TP1_REDUCE_ONLY_SUBMIT",
    };
    // V2_PROBE_TP1_SUBMIT_PROOF: 제출 결정만, 체결 아님
    console.info(JSON.stringify({
        event: "V2_PROBE_TP1_SUBMIT_PROOF",
        symbol, side, qty, tp1Price: plan.tp1Price,
        reduceOnly: true, entryReason: plan.entryReason,
        reason: decision.reason, submitted: true,
        note: "ORDER_SUBMIT_DECISION_ONLY_NOT_FILL_CONFIRMED",
    }));
    return decision;
}
function detectProbeTP1Trigger(symbol, side, plan, markPrice, alreadySubmitted, alreadyFilled) {
    // submitted 아직 안 됐거나 이미 fill된 경우 감지 불필요
    if (!alreadySubmitted || alreadyFilled)
        return null;
    const dirMult = side === "long" ? 1 : -1;
    const currentR = (dirMult * (markPrice - plan.entryPrice)) / plan.riskDistance;
    const triggered = side === "long"
        ? markPrice >= plan.tp1Price
        : markPrice <= plan.tp1Price;
    if (!triggered)
        return null;
    const result = {
        triggered: true, markPrice, tp1Price: plan.tp1Price,
        currentR, entryReason: plan.entryReason,
        fillConfirmed: false,
    };
    // V2_PROBE_TP1_TRIGGER_PROOF: markPrice 도달 기록. fill 아님.
    console.info(JSON.stringify({
        event: "V2_PROBE_TP1_TRIGGER_PROOF",
        symbol, side, markPrice, tp1Price: plan.tp1Price,
        currentR, entryReason: plan.entryReason,
        fillConfirmed: false,
        note: "MARK_PRICE_HIT_ONLY_AWAITING_OKX_FILL_CONFIRMATION",
    }));
    return result;
}
function processProbeTP1Fill(symbol, side, plan, totalQty, fillInput) {
    const { okxFilledQty, okxAvgFillPrice, ledgerUpdated, fillSource } = fillInput;
    if (okxFilledQty <= 0)
        return null;
    if (!Number.isFinite(okxAvgFillPrice) || okxAvgFillPrice <= 0)
        return null;
    const remainingQty = Math.max(0, totalQty - okxFilledQty);
    const dirMult = side === "long" ? 1 : -1;
    const realizedPnl = okxFilledQty * (okxAvgFillPrice - plan.entryPrice) * dirMult;
    const result = {
        okxFilledQty, remainingQty, okxAvgFillPrice,
        realizedPnl,
        ledgerUpdated, // caller가 실제 ledger write 완료 후 true 전달
        fillSource,
        entryReason: plan.entryReason,
    };
    // V2_PROBE_TP1_FILL_PROOF: OKX fill 데이터 주입 후에만 발행
    console.info(JSON.stringify({
        event: "V2_PROBE_TP1_FILL_PROOF",
        symbol, side, okxFilledQty, remainingQty,
        okxAvgFillPrice, realizedPnl,
        ledgerUpdated, fillSource,
        entryReason: plan.entryReason,
        note: "OKX_FILL_CONFIRMED_BY_CALLER",
    }));
    if (ledgerUpdated) {
        // V2_PROBE_LEDGER_PARTIAL_UPDATE_PROOF: ledger 반영 성공
        console.info(JSON.stringify({
            event: "V2_PROBE_LEDGER_PARTIAL_UPDATE_PROOF",
            symbol, side, okxFilledQty, remainingQty,
            realizedPnl, fillSource,
            entryReason: plan.entryReason,
        }));
    }
    return result;
}
function evaluateProbeBreakevenStop(symbol, side, plan, currentStopPrice, tp1Filled, // OKX fill API 확인된 값 (markPrice 통과 ≠ true)
remainingQty) {
    // 절대 가드: OKX fill 확인 전 이동 불가
    if (!tp1Filled)
        return null;
    if (remainingQty <= 0)
        return null;
    const feeBuffer = plan.entryPrice * 0.0012;
    const dirMult = side === "long" ? 1 : -1;
    const newStopPrice = plan.entryPrice + dirMult * feeBuffer;
    const wouldWorsen = side === "long"
        ? newStopPrice <= currentStopPrice
        : newStopPrice >= currentStopPrice;
    if (wouldWorsen)
        return null;
    const result = {
        shouldMove: true,
        oldStopPrice: currentStopPrice,
        newStopPrice, remainingQty,
        protectionOrderRebuilt: false, // 실제 주문 재등록은 caller 담당
        entryReason: plan.entryReason,
    };
    console.info(JSON.stringify({
        event: "V2_PROBE_BREAKEVEN_STOP_MOVE_PROOF",
        symbol, side,
        oldStopPrice: currentStopPrice, newStopPrice,
        tp1Filled, remainingQty,
        protectionOrderRebuilt: false,
        note: "STOP_MOVE_DECISION_ONLY_CALLER_MUST_RESUBMIT_ORDER",
        entryReason: plan.entryReason,
    }));
    return result;
}
function evaluateProbeProtectionRealign(symbol, side, plan, remainingQty, newStopPrice) {
    if (remainingQty <= 0)
        return null;
    if (!Number.isFinite(newStopPrice) || newStopPrice <= 0)
        return null;
    const result = {
        shouldRealign: true,
        remainingQty, newStopPrice,
        finalTpPrice: plan.finalTpPrice,
        protectionOrderRebuilt: false, // caller 담당
        reason: "PROBE_TP1_FILL_PROTECTION_REALIGN_DECISION",
    };
    // 결정만 기록. protectionOrderRebuilt=true는 caller가 재등록 성공 후 발행.
    console.info(JSON.stringify({
        event: "V2_PROBE_PROTECTION_REALIGN_PROOF",
        symbol, side, remainingQty, newStopPrice,
        finalTpPrice: plan.finalTpPrice,
        protectionOrderRebuilt: false,
        reason: result.reason,
        note: "REALIGN_DECISION_ONLY_CALLER_MUST_CANCEL_AND_RESUBMIT",
    }));
    return result;
}
function evaluateProbeTimeStop(symbol, side, plan, markPrice, barsHeld5m, tp1Filled) {
    if (tp1Filled)
        return null; // fill 완료 후 time stop 불필요
    const rules = PROBE_RULES[plan.entryReason];
    const dirMult = side === "long" ? 1 : -1;
    const currentR = (dirMult * (markPrice - plan.entryPrice)) / plan.riskDistance;
    const timeExpired = barsHeld5m >= rules.maxHoldBars5m;
    const progressInsufficient = currentR < rules.progressGateR;
    const isTimeStopCandidate = timeExpired && progressInsufficient;
    const result = {
        isTimeStopCandidate,
        barsHeld5m, maxHoldBars5m: rules.maxHoldBars5m,
        currentR,
        reason: isTimeStopCandidate
            ? "TIME_STOP_BARS_EXCEEDED_PROGRESS_INSUFFICIENT"
            : timeExpired
                ? "TIME_EXPIRED_BUT_PROGRESS_OK"
                : "TIME_STOP_NOT_YET",
    };
    if (isTimeStopCandidate) {
        console.info(JSON.stringify({
            event: "V2_PROBE_TIME_STOP_PROOF",
            symbol, side, barsHeld5m,
            maxHoldBars5m: rules.maxHoldBars5m,
            currentR, reason: result.reason,
        }));
    }
    return result;
}
function detectProbePendingStale(symbol, side, plan, alreadySubmitted, alreadyFilled, barsHeldSinceSubmit5m) {
    if (!alreadySubmitted || alreadyFilled)
        return null;
    const isStale = barsHeldSinceSubmit5m >= plan.stalePendingBars5m;
    if (isStale) {
        console.info(JSON.stringify({
            event: "PROBE_TP1_PENDING_STALE",
            symbol, side,
            barsHeldSinceSubmit5m,
            stalePendingBars5m: plan.stalePendingBars5m,
            entryReason: plan.entryReason,
            note: "TP1_SUBMITTED_BUT_NOT_FILLED_STALE_WARNING",
        }));
    }
    return { isStale, barsHeld5m: barsHeldSinceSubmit5m, stalePendingBars5m: plan.stalePendingBars5m, entryReason: plan.entryReason };
}
