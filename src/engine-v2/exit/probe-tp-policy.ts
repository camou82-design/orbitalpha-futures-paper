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

export type ProbeEntryReason =
    | "EARLY_REVERSAL_SHORT_PROBE"
    | "EARLY_REVERSAL_LONG_PROBE"
    | "PULLBACK_RETEST_SHORT_CONFIRM"
    | "PULLBACK_RETEST_LONG_CONFIRM";

const PROBE_RULES: Record<
    ProbeEntryReason,
    {
        tp1R: number;
        tp1CloseRatio: number;
        finalTpR: number;
        maxHoldBars5m: number;
        progressGateR: number;
        progressGateBars5m: number;
        stalePendingBars5m: number; // TP1 submitted 후 미체결 경보 기준
    }
> = {
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

export function isProbeEntryReason(reason: string | undefined): reason is ProbeEntryReason {
    return (
        reason === "EARLY_REVERSAL_SHORT_PROBE" ||
        reason === "EARLY_REVERSAL_LONG_PROBE" ||
        reason === "PULLBACK_RETEST_SHORT_CONFIRM" ||
        reason === "PULLBACK_RETEST_LONG_CONFIRM"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 0: TP Plan 계산
// ─────────────────────────────────────────────────────────────────────────────

export interface ProbeTpPlan {
    entryReason: ProbeEntryReason;
    side: "long" | "short";
    entryPrice: number;
    stopPrice: number;
    riskDistance: number;
    tp1Price: number;
    tp1R: number;
    tp1CloseRatio: number;
    finalTpPrice: number;
    finalTpR: number;
    maxHoldBars5m: number;
    stalePendingBars5m: number;
    expectedNetProfitAfterCost: number;
    netPositive: boolean;
}

export function calculateProbeTpPlan(
    symbol: string,
    side: "long" | "short",
    entryReason: ProbeEntryReason,
    entryPrice: number,
    stopPrice: number
): ProbeTpPlan | null {
    if (!Number.isFinite(entryPrice) || !Number.isFinite(stopPrice)) return null;
    if (entryPrice <= 0 || stopPrice <= 0) return null;

    const riskDistance = Math.abs(entryPrice - stopPrice);
    if (riskDistance <= 0) return null;

    if (side === "long" && stopPrice >= entryPrice) return null;
    if (side === "short" && stopPrice <= entryPrice) return null;

    const rules = PROBE_RULES[entryReason];
    const dirMult = side === "long" ? 1 : -1;

    const tp1Price = entryPrice + dirMult * riskDistance * rules.tp1R;
    const finalTpPrice = entryPrice + dirMult * riskDistance * rules.finalTpR;
    const tp1NetR = rules.tp1R - ROUND_TRIP_COST_R_ESTIMATE;
    const expectedNetProfitAfterCost = tp1NetR * rules.tp1CloseRatio;
    const netPositive = tp1NetR > 0;

    const plan: ProbeTpPlan = {
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

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1: reduce-only 주문 제출 결정
// ─────────────────────────────────────────────────────────────────────────────

export interface ProbeTP1SubmitDecision {
    shouldSubmit: boolean;
    qty: number;
    tp1Price: number;
    reduceOnly: true;
    entryReason: ProbeEntryReason;
    reason: string;
}

export function evaluateProbeTP1Submit(
    symbol: string,
    side: "long" | "short",
    plan: ProbeTpPlan,
    positionQty: number,
    alreadySubmitted: boolean,
    alreadyFilled: boolean
): ProbeTP1SubmitDecision | null {
    if (alreadySubmitted || alreadyFilled) return null;

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
    if (qty <= 0) return null;

    const decision: ProbeTP1SubmitDecision = {
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

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2: markPrice TP1 도달 감지 (trigger ≠ fill)
// ─────────────────────────────────────────────────────────────────────────────

export interface ProbeTP1TriggerResult {
    triggered: boolean;
    markPrice: number;
    tp1Price: number;
    currentR: number;
    entryReason: ProbeEntryReason;
    /** 이 결과로 fill 처리하면 안 됨. OKX fill API 확인 필요. */
    fillConfirmed: false;
}

export function detectProbeTP1Trigger(
    symbol: string,
    side: "long" | "short",
    plan: ProbeTpPlan,
    markPrice: number,
    alreadySubmitted: boolean,
    alreadyFilled: boolean
): ProbeTP1TriggerResult | null {
    // submitted 아직 안 됐거나 이미 fill된 경우 감지 불필요
    if (!alreadySubmitted || alreadyFilled) return null;

    const dirMult = side === "long" ? 1 : -1;
    const currentR = (dirMult * (markPrice - plan.entryPrice)) / plan.riskDistance;
    const triggered = side === "long"
        ? markPrice >= plan.tp1Price
        : markPrice <= plan.tp1Price;

    if (!triggered) return null;

    const result: ProbeTP1TriggerResult = {
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

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3: OKX fill 데이터 주입 후 ledger 반영
//   - caller(executor)가 OKX fill API로 filledQty/avgFillPrice를 확인한 뒤 호출
//   - ledgerUpdated는 caller가 실제 ledger write 성공 후 true로 넘겨야 함
// ─────────────────────────────────────────────────────────────────────────────

export interface ProbeTP1FillInput {
    /** OKX 실제 체결 수량 (caller가 API에서 확인한 값) */
    okxFilledQty: number;
    /** OKX 실제 체결 평균가 */
    okxAvgFillPrice: number;
    /** caller가 paper ledger write 성공 시 true로 세팅 */
    ledgerUpdated: boolean;
    /** OKX fill 확인 소스 (audit용) */
    fillSource: "okx_order_status_api" | "okx_fill_history_api" | "manual_reconcile";
}

export interface ProbeTP1FillResult {
    okxFilledQty: number;
    remainingQty: number;
    okxAvgFillPrice: number;
    realizedPnl: number;
    /** caller가 ledger write 성공 후 true로 넘긴 값을 그대로 전달 */
    ledgerUpdated: boolean;
    fillSource: ProbeTP1FillInput["fillSource"];
    entryReason: ProbeEntryReason;
}

export function processProbeTP1Fill(
    symbol: string,
    side: "long" | "short",
    plan: ProbeTpPlan,
    totalQty: number,
    fillInput: ProbeTP1FillInput
): ProbeTP1FillResult | null {
    const { okxFilledQty, okxAvgFillPrice, ledgerUpdated, fillSource } = fillInput;

    if (okxFilledQty <= 0) return null;
    if (!Number.isFinite(okxAvgFillPrice) || okxAvgFillPrice <= 0) return null;

    const remainingQty = Math.max(0, totalQty - okxFilledQty);
    const dirMult = side === "long" ? 1 : -1;
    const realizedPnl = okxFilledQty * (okxAvgFillPrice - plan.entryPrice) * dirMult;

    const result: ProbeTP1FillResult = {
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

// ─────────────────────────────────────────────────────────────────────────────
// Stage 4: fill 확인 후 본절 이동 판단
//   - tp1Filled = OKX fill 확인된 경우에만 true
// ─────────────────────────────────────────────────────────────────────────────

export interface ProbeBreakevenResult {
    shouldMove: boolean;
    oldStopPrice: number;
    newStopPrice: number;
    remainingQty: number;
    /**
     * false: 이동 결정만 반환. 실제 주문 재등록은 caller(executor) 수행 후 Stage 5로.
     * protectionOrderRebuilt는 Stage 5(evaluateProbeProtectionRealign) 완료 후에만 true.
     */
    protectionOrderRebuilt: false;
    entryReason: ProbeEntryReason;
}

export function evaluateProbeBreakevenStop(
    symbol: string,
    side: "long" | "short",
    plan: ProbeTpPlan,
    currentStopPrice: number,
    tp1Filled: boolean,      // OKX fill API 확인된 값 (markPrice 통과 ≠ true)
    remainingQty: number
): ProbeBreakevenResult | null {
    // 절대 가드: OKX fill 확인 전 이동 불가
    if (!tp1Filled) return null;
    if (remainingQty <= 0) return null;

    const feeBuffer = plan.entryPrice * 0.0012;
    const dirMult = side === "long" ? 1 : -1;
    const newStopPrice = plan.entryPrice + dirMult * feeBuffer;

    const wouldWorsen = side === "long"
        ? newStopPrice <= currentStopPrice
        : newStopPrice >= currentStopPrice;
    if (wouldWorsen) return null;

    const result: ProbeBreakevenResult = {
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

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5: 잔량 기준 SL/TP 보호주문 재정렬 결정
//   - protectionOrderRebuilt는 caller가 실제 주문 취소/재등록 성공 후 로그 발행
// ─────────────────────────────────────────────────────────────────────────────

export interface ProbeProtectionRealignResult {
    shouldRealign: boolean;
    remainingQty: number;
    newStopPrice: number;
    finalTpPrice: number;
    /**
     * 항상 false: 실제 주문 재등록은 caller(executor) 수행.
     * caller가 성공 시 V2_PROBE_PROTECTION_REALIGN_PROOF를 별도 발행.
     */
    protectionOrderRebuilt: false;
    reason: string;
}

export function evaluateProbeProtectionRealign(
    symbol: string,
    side: "long" | "short",
    plan: ProbeTpPlan,
    remainingQty: number,
    newStopPrice: number
): ProbeProtectionRealignResult | null {
    if (remainingQty <= 0) return null;
    if (!Number.isFinite(newStopPrice) || newStopPrice <= 0) return null;

    const result: ProbeProtectionRealignResult = {
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

// ─────────────────────────────────────────────────────────────────────────────
// Stage 6: Time Stop 후보 감지
// ─────────────────────────────────────────────────────────────────────────────

export interface ProbeTimeStopResult {
    isTimeStopCandidate: boolean;
    barsHeld5m: number;
    maxHoldBars5m: number;
    currentR: number;
    reason: string;
}

export function evaluateProbeTimeStop(
    symbol: string,
    side: "long" | "short",
    plan: ProbeTpPlan,
    markPrice: number,
    barsHeld5m: number,
    tp1Filled: boolean
): ProbeTimeStopResult | null {
    if (tp1Filled) return null; // fill 완료 후 time stop 불필요

    const rules = PROBE_RULES[plan.entryReason];
    const dirMult = side === "long" ? 1 : -1;
    const currentR = (dirMult * (markPrice - plan.entryPrice)) / plan.riskDistance;

    const timeExpired = barsHeld5m >= rules.maxHoldBars5m;
    const progressInsufficient = currentR < rules.progressGateR;
    const isTimeStopCandidate = timeExpired && progressInsufficient;

    const result: ProbeTimeStopResult = {
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

// ─────────────────────────────────────────────────────────────────────────────
// Stage 7: TP1 submitted 장시간 미체결 경보
// ─────────────────────────────────────────────────────────────────────────────

export interface ProbePendingStaleResult {
    isStale: boolean;
    barsHeld5m: number;
    stalePendingBars5m: number;
    entryReason: ProbeEntryReason;
}

export function detectProbePendingStale(
    symbol: string,
    side: "long" | "short",
    plan: ProbeTpPlan,
    alreadySubmitted: boolean,
    alreadyFilled: boolean,
    barsHeldSinceSubmit5m: number
): ProbePendingStaleResult | null {
    if (!alreadySubmitted || alreadyFilled) return null;

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
