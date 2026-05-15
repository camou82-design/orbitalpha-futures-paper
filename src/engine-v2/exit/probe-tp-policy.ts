/**
 * Probe TP Policy Module
 * ─────────────────────────────────────────────────────────────────────────────
 * EARLY_REVERSAL_SHORT_PROBE / EARLY_REVERSAL_LONG_PROBE
 * PULLBACK_RETEST_SHORT_CONFIRM / PULLBACK_RETEST_LONG_CONFIRM
 * 포지션 전용 짧은 익절 레이어.
 *
 * 절대 금지:
 *  - TP1 requested만 보고 본절 이동 금지
 *  - TP1 filled 확인 전 SL 이동 금지
 *  - market order 추가 금지
 *  - partial requested ≠ partial filled 원칙 위반 금지
 *  - 순이익이 수수료/슬리피지 후 0 이하인 TP 실행 금지
 */

export type ProbeEntryReason =
    | "EARLY_REVERSAL_SHORT_PROBE"
    | "EARLY_REVERSAL_LONG_PROBE"
    | "PULLBACK_RETEST_SHORT_CONFIRM"
    | "PULLBACK_RETEST_LONG_CONFIRM";

/** TP1/Final TP R 배율 규칙 */
const PROBE_RULES: Record<
    ProbeEntryReason,
    {
        tp1R: number;
        tp1CloseRatio: number;
        finalTpR: number;
        maxHoldBars5m: number;
        progressGateR: number;    // maxHoldBars5m 내 진전 기준 R
        progressGateBars5m: number;
    }
> = {
    EARLY_REVERSAL_SHORT_PROBE: {
        tp1R: 0.45,
        tp1CloseRatio: 0.50,
        finalTpR: 0.85,
        maxHoldBars5m: 4,
        progressGateR: 0.25,
        progressGateBars5m: 4,
    },
    EARLY_REVERSAL_LONG_PROBE: {
        tp1R: 0.45,
        tp1CloseRatio: 0.50,
        finalTpR: 0.85,
        maxHoldBars5m: 4,
        progressGateR: 0.25,
        progressGateBars5m: 4,
    },
    PULLBACK_RETEST_SHORT_CONFIRM: {
        tp1R: 0.65,
        tp1CloseRatio: 0.50,
        finalTpR: 1.10,
        maxHoldBars5m: 8,
        progressGateR: 0.30,
        progressGateBars5m: 6,
    },
    PULLBACK_RETEST_LONG_CONFIRM: {
        tp1R: 0.65,
        tp1CloseRatio: 0.50,
        finalTpR: 1.10,
        maxHoldBars5m: 8,
        progressGateR: 0.30,
        progressGateBars5m: 6,
    },
};

/** 수수료+슬리피지 단방향 비용 추정 (taker fee 0.05% × 2 + slippage 0.02%) */
const ROUND_TRIP_COST_R_ESTIMATE = 0.0012; // 0.12% round trip (riskDistance 기준 상대값)

export function isProbeEntryReason(reason: string | undefined): reason is ProbeEntryReason {
    return (
        reason === "EARLY_REVERSAL_SHORT_PROBE" ||
        reason === "EARLY_REVERSAL_LONG_PROBE" ||
        reason === "PULLBACK_RETEST_SHORT_CONFIRM" ||
        reason === "PULLBACK_RETEST_LONG_CONFIRM"
    );
}

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
    expectedNetProfitAfterCost: number;
    netPositive: boolean;
}

/** Probe TP Plan 계산 */
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

    // stopPrice 방향 검증
    if (side === "long" && stopPrice >= entryPrice) return null;
    if (side === "short" && stopPrice <= entryPrice) return null;

    const rules = PROBE_RULES[entryReason];
    const dirMult = side === "long" ? 1 : -1;

    const tp1Price = entryPrice + dirMult * riskDistance * rules.tp1R;
    const finalTpPrice = entryPrice + dirMult * riskDistance * rules.finalTpR;

    // 수수료/슬리피지 후 순이익 추정 (R 단위, tp1 기준)
    const tp1NetR = rules.tp1R - ROUND_TRIP_COST_R_ESTIMATE;
    const expectedNetProfitAfterCost = tp1NetR * rules.tp1CloseRatio;
    const netPositive = tp1NetR > 0;

    const plan: ProbeTpPlan = {
        entryReason,
        side,
        entryPrice,
        stopPrice,
        riskDistance,
        tp1Price,
        tp1R: rules.tp1R,
        tp1CloseRatio: rules.tp1CloseRatio,
        finalTpPrice,
        finalTpR: rules.finalTpR,
        maxHoldBars5m: rules.maxHoldBars5m,
        expectedNetProfitAfterCost,
        netPositive,
    };

    console.info(JSON.stringify({
        event: "V2_PROBE_TP_PLAN_PROOF",
        symbol,
        side,
        entryReason,
        entryPrice,
        stopPrice,
        riskDistance,
        tp1Price,
        tp1R: rules.tp1R,
        tp1CloseRatio: rules.tp1CloseRatio,
        finalTpPrice,
        finalTpR: rules.finalTpR,
        maxHoldBars5m: rules.maxHoldBars5m,
        expectedNetProfitAfterCost,
    }));

    return plan;
}

export interface ProbeTP1SubmitDecision {
    shouldSubmit: boolean;
    qty: number;
    tp1Price: number;
    reduceOnly: true;
    entryReason: ProbeEntryReason;
    reason: string;
}

/**
 * TP1 주문 제출 결정
 * - 이미 submitted/filled이면 건드리지 않음
 * - 순이익이 0 이하인 TP는 제출하지 않음
 */
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
            symbol,
            side,
            qty: 0,
            tp1Price: plan.tp1Price,
            reduceOnly: true,
            entryReason: plan.entryReason,
            reason: "NET_PROFIT_NEGATIVE_AFTER_COST_SKIP",
        }));
        return null;
    }

    const qty = positionQty * plan.tp1CloseRatio;
    if (qty <= 0) return null;

    const decision: ProbeTP1SubmitDecision = {
        shouldSubmit: true,
        qty,
        tp1Price: plan.tp1Price,
        reduceOnly: true,
        entryReason: plan.entryReason,
        reason: "PROBE_TP1_REDUCE_ONLY_SUBMIT",
    };

    console.info(JSON.stringify({
        event: "V2_PROBE_TP1_SUBMIT_PROOF",
        symbol,
        side,
        qty,
        tp1Price: plan.tp1Price,
        reduceOnly: true,
        entryReason: plan.entryReason,
        reason: decision.reason,
    }));

    return decision;
}

export interface ProbeTP1FillResult {
    filledQty: number;
    remainingQty: number;
    avgFillPrice: number;
    realizedPnl: number;
    ledgerUpdated: boolean;
    entryReason: ProbeEntryReason;
}

/**
 * TP1 체결 감지 및 ledger 반영
 * - TP1 filled 확인 전에는 SL 이동 불가
 */
export function processProbeTP1Fill(
    symbol: string,
    side: "long" | "short",
    plan: ProbeTpPlan,
    totalQty: number,
    filledQty: number,
    avgFillPrice: number
): ProbeTP1FillResult | null {
    if (filledQty <= 0) return null;

    const remainingQty = Math.max(0, totalQty - filledQty);

    // 실현 손익 추정 (USD 기준, entryPrice 대비)
    const dirMult = side === "long" ? 1 : -1;
    const realizedPnl = filledQty * (avgFillPrice - plan.entryPrice) * dirMult;

    const result: ProbeTP1FillResult = {
        filledQty,
        remainingQty,
        avgFillPrice,
        realizedPnl,
        ledgerUpdated: true,
        entryReason: plan.entryReason,
    };

    console.info(JSON.stringify({
        event: "V2_PROBE_TP1_FILL_PROOF",
        symbol,
        side,
        filledQty,
        remainingQty,
        avgFillPrice,
        realizedPnl,
        ledgerUpdated: true,
        entryReason: plan.entryReason,
    }));

    return result;
}

export interface ProbeBreakevenResult {
    shouldMove: boolean;
    oldStopPrice: number;
    newStopPrice: number;
    remainingQty: number;
    protectionRebuilt: boolean;
    entryReason: ProbeEntryReason;
}

/**
 * TP1 체결 후 본절 이동 판단
 * - TP1 filled = true인 경우에만 실행
 * - 수수료 포함 본절 또는 entryPrice 근처
 */
export function evaluateProbeBreakevenStop(
    symbol: string,
    side: "long" | "short",
    plan: ProbeTpPlan,
    currentStopPrice: number,
    tp1Filled: boolean,
    remainingQty: number
): ProbeBreakevenResult | null {
    // 핵심 가드: TP1 filled 확인 전에는 절대 이동 불가
    if (!tp1Filled) return null;
    if (remainingQty <= 0) return null;

    // 본절: 수수료 포함 약 0.12% 위/아래
    const feeBuffer = plan.entryPrice * 0.0012;
    const dirMult = side === "long" ? 1 : -1;
    const newStopPrice = plan.entryPrice + dirMult * feeBuffer;

    // 기존 stop보다 나빠지면 이동 안 함 (never-worsen)
    const wouldWorsen = side === "long"
        ? newStopPrice <= currentStopPrice
        : newStopPrice >= currentStopPrice;
    if (wouldWorsen) return null;

    const result: ProbeBreakevenResult = {
        shouldMove: true,
        oldStopPrice: currentStopPrice,
        newStopPrice,
        remainingQty,
        protectionRebuilt: true,
        entryReason: plan.entryReason,
    };

    console.info(JSON.stringify({
        event: "V2_PROBE_BREAKEVEN_STOP_MOVE_PROOF",
        symbol,
        side,
        oldStopPrice: currentStopPrice,
        newStopPrice,
        tp1Filled,
        remainingQty,
        protectionRebuilt: true,
        entryReason: plan.entryReason,
    }));

    return result;
}

export interface ProbeProtectionRealignResult {
    shouldRealign: boolean;
    remainingQty: number;
    stopPrice: number;
    finalTpPrice: number;
    protectionOrderRebuilt: boolean;
    reason: string;
}

/**
 * TP1 체결 후 남은 수량 기준 SL/TP 보호주문 재정렬
 */
export function evaluateProbeProtectionRealign(
    symbol: string,
    side: "long" | "short",
    plan: ProbeTpPlan,
    remainingQty: number,
    newStopPrice: number
): ProbeProtectionRealignResult | null {
    if (remainingQty <= 0) return null;

    const result: ProbeProtectionRealignResult = {
        shouldRealign: true,
        remainingQty,
        stopPrice: newStopPrice,
        finalTpPrice: plan.finalTpPrice,
        protectionOrderRebuilt: true,
        reason: "PROBE_TP1_FILL_PROTECTION_REALIGN",
    };

    console.info(JSON.stringify({
        event: "V2_PROBE_PROTECTION_REALIGN_PROOF",
        symbol,
        side,
        remainingQty,
        stopPrice: newStopPrice,
        finalTpPrice: plan.finalTpPrice,
        protectionOrderRebuilt: true,
        reason: result.reason,
    }));

    return result;
}

export interface ProbeTimeStopResult {
    isTimeStopCandidate: boolean;
    barsHeld5m: number;
    maxHoldBars5m: number;
    currentR: number;
    reason: string;
}

/**
 * Time Stop 평가
 * - maxHoldBars5m 이내에 progressGateR 이상 진전 없으면 time stop 후보
 * - TP1 이미 체결됐으면 time stop 평가 불필요
 */
export function evaluateProbeTimeStop(
    symbol: string,
    side: "long" | "short",
    plan: ProbeTpPlan,
    markPrice: number,
    barsHeld5m: number,
    tp1Filled: boolean
): ProbeTimeStopResult | null {
    // TP1 체결된 경우 time stop 적용 안 함
    if (tp1Filled) return null;

    const rules = PROBE_RULES[plan.entryReason];
    const dirMult = side === "long" ? 1 : -1;
    const currentR = (dirMult * (markPrice - plan.entryPrice)) / plan.riskDistance;

    // maxHoldBars5m 초과 AND progressGateR 미달
    const timeExpired = barsHeld5m >= rules.maxHoldBars5m;
    const progressInsufficient = currentR < rules.progressGateR;

    const isTimeStopCandidate = timeExpired && progressInsufficient;

    const result: ProbeTimeStopResult = {
        isTimeStopCandidate,
        barsHeld5m,
        maxHoldBars5m: rules.maxHoldBars5m,
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
            symbol,
            side,
            barsHeld5m,
            maxHoldBars5m: rules.maxHoldBars5m,
            currentR,
            reason: result.reason,
        }));
    }

    return result;
}
