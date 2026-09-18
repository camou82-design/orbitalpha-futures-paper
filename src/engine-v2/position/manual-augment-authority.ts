export type ManualInterventionType =
    | "SAME_SIDE_MANUAL_AUGMENT"
    | "OPPOSITE_SIDE_INTERVENTION"
    | "MANUAL_REDUCE"
    | "NONE";

export interface ManualAugmentAuthorityProofInput {
    symbol: string;
    side: string;
    ledgerQty: number;
    ledgerAvgPx: number;
    ledgerNotional: number;
    okxActualQty: number;
    okxActualAvgPx: number;
    okxActualNotional: number;
    interventionType: ManualInterventionType;
    lifecycleState: string;
    positionManagementAllowed: boolean;
    autoAddonAllowed: boolean;
    protectionReconcileAllowed: boolean;
}

export function buildManualAugmentAuthorityProof(
    input: ManualAugmentAuthorityProofInput
): Record<string, unknown> {
    return {
        event: "V2_MANUAL_AUGMENT_AUTHORITY_PROOF",
        symbol: input.symbol,
        side: input.side,
        ledgerQty: Number(input.ledgerQty.toFixed(6)),
        ledgerAvgPx: Number(input.ledgerAvgPx.toFixed(2)),
        ledgerNotional: Number(input.ledgerNotional.toFixed(2)),
        okxActualQty: Number(input.okxActualQty.toFixed(6)),
        okxActualAvgPx: Number(input.okxActualAvgPx.toFixed(2)),
        okxActualNotional: Number(input.okxActualNotional.toFixed(2)),
        interventionType: input.interventionType,
        lifecycleState: input.lifecycleState,
        positionManagementAllowed: input.positionManagementAllowed,
        autoAddonAllowed: input.autoAddonAllowed,
        protectionReconcileAllowed: input.protectionReconcileAllowed
    };
}

export interface PositionManagementPriceAuthorityProofInput {
    symbol: string;
    pnlEntryPriceSource: "okx_actual_avg_px" | "ledger_entry_px";
    managementAvgPx: number;
    ledgerEntryPrice: number;
    actualAvgPx: number;
}

export function buildPositionManagementPriceAuthorityProof(
    input: PositionManagementPriceAuthorityProofInput
): Record<string, unknown> {
    return {
        event: "V2_POSITION_MANAGEMENT_PRICE_AUTHORITY_PROOF",
        symbol: input.symbol,
        pnlEntryPriceSource: input.pnlEntryPriceSource,
        managementAvgPx: Number(input.managementAvgPx.toFixed(2)),
        ledgerEntryPrice: Number(input.ledgerEntryPrice.toFixed(2)),
        actualAvgPx: Number(input.actualAvgPx.toFixed(2))
    };
}

export interface ProtectiveQtyCoverageInput {
    symbol: string;
    instId?: string;
    positionSide: "long" | "short";
    actualQty: number;
    pendingAlgos?: readonly Record<string, unknown>[] | null;
}

export interface ProtectiveQtyCoverageResult {
    actualQty: number;
    stopProtectedQty: number;
    tpProtectedQty: number;
    coverageRatio: number;
    ownership: "BOT_MANAGED" | "MANUAL" | "MIXED";
    proof: Record<string, unknown>;
}

export function computeProtectiveQtyCoverage(
    input: ProtectiveQtyCoverageInput
): ProtectiveQtyCoverageResult {
    const actualQty = input.actualQty;
    const expectedSide = input.positionSide === "long" ? "sell" : "buy";
    const instId = input.instId;

    const algos = (input.pendingAlgos ?? []).filter((a) => {
        if (instId && String(a.instId ?? "") !== instId) return false;
        const ps = String(a.posSide ?? "net").trim().toLowerCase();
        if (ps !== "net" && ps !== input.positionSide) return false;
        if (String(a.side ?? "").toLowerCase() !== expectedSide) return false;
        const reduceOnly =
            a.reduceOnly === true || String(a.reduceOnly ?? "").toLowerCase() === "true";
        return reduceOnly;
    });

    let stopProtectedQty = 0;
    let tpProtectedQty = 0;
    let botOrderCount = 0;
    let manualOrderCount = 0;

    for (const a of algos) {
        const clOrdId = String(a.algoClOrdId ?? a.clOrdId ?? "");
        const isBot =
            clOrdId.startsWith("oap") ||
            clOrdId.startsWith("sl") ||
            clOrdId.startsWith("tp");
        if (isBot) botOrderCount++;
        else manualOrderCount++;

        const isCloseFraction =
            a.closeFraction === "1" || String(a.closeFraction ?? "") === "1";
        const sz = isCloseFraction ? actualQty : Number(a.sz ?? 0);
        const hasSl =
            a.slTriggerPx != null ||
            (a.ordType && String(a.ordType).toLowerCase() === "oco");
        const hasTp =
            a.tpTriggerPx != null ||
            (a as any).tpPx != null ||
            (a.ordType && String(a.ordType).toLowerCase() === "oco");

        if (hasSl && Number.isFinite(sz) && sz > 0) {
            stopProtectedQty += sz;
        }
        if (hasTp && Number.isFinite(sz) && sz > 0) {
            tpProtectedQty += sz;
        }
    }

    const ownership: "BOT_MANAGED" | "MANUAL" | "MIXED" =
        botOrderCount > 0 && manualOrderCount > 0
            ? "MIXED"
            : botOrderCount > 0
              ? "BOT_MANAGED"
              : "MANUAL";

    const coverageRatio =
        actualQty > 0
            ? Number((Math.min(stopProtectedQty, actualQty) / actualQty).toFixed(4))
            : 1;

    const proof = {
        event: "V2_PROTECTIVE_QTY_COVERAGE_PROOF",
        symbol: input.symbol,
        actualQty: Number(actualQty.toFixed(6)),
        stopProtectedQty: Number(stopProtectedQty.toFixed(6)),
        tpProtectedQty: Number(tpProtectedQty.toFixed(6)),
        coverageRatio,
        ownership
    };

    return {
        actualQty,
        stopProtectedQty,
        tpProtectedQty,
        coverageRatio,
        ownership,
        proof
    };
}

export interface SymbolPositionAuthorityProofInput {
    symbol: string;
    symbolPositionsCount: number;
    heldPositionSide: string | null;
    managementSide: string | null;
    isContaminated: boolean;
}

export function buildSymbolPositionAuthorityProof(
    input: SymbolPositionAuthorityProofInput
): Record<string, unknown> {
    return {
        event: "V2_SYMBOL_POSITION_AUTHORITY_PROOF",
        symbol: input.symbol,
        symbolPositionsCount: input.symbolPositionsCount,
        heldPositionSide: input.heldPositionSide,
        managementSide: input.managementSide,
        isContaminated: input.isContaminated
    };
}

/**
 * Checks whether a position record has genuine BOT-origin provenance.
 * Recovers BOT origin even when newer v2 authority flags were lost/stripped during legacy takeover latching.
 */
export function isBotOriginPositionEvidence(
    ledger: {
        symbol?: string;
        side?: string;
        okxContracts?: number | null;
        isV2Authority?: boolean;
        lifecycleState?: string;
        manualTakeoverActive?: boolean;
        manualOwnershipLatch?: boolean;
        manualTakeoverReason?: string | null;
        originalEntryPrice?: number;
        sourceSignal?: string | null;
        authoritySourceAtEntry?: string | null;
        authority?: string | null;
        adoptedEngine?: string | null;
        exchangeClOrdId?: string | null;
        strategyVersion?: string | null;
        entryStage?: number | null;
        positionCycleId?: string | null;
        flowId?: string | null;
        protectiveSlAlgoId?: string | null;
        protectiveStopAlgoId?: string | null;
        rangeBoxHighAtEntry?: number | null;
        rangeBoxLowAtEntry?: number | null;
        rangeBoxQuality?: number | null;
        v2RangeTp1Triggered?: boolean | null;
        lastBotExecutionReason?: string | null;
        lastBotExecutionAt?: number | null;
    },
    hasBotOrderEvidence?: boolean
): boolean {
    if (hasBotOrderEvidence === true) return true;
    if (ledger.isV2Authority === true) return true;
    if (
        ledger.lifecycleState === "BOT_V2_MANAGED" ||
        ledger.lifecycleState === "MANUAL_SIZE_AUGMENTED" ||
        ledger.lifecycleState === "PARTIAL_ACTIVE" ||
        ledger.lifecycleState === "ADDON_ACTIVE"
    ) {
        return true;
    }

    // 1. Explicit source/authority tags
    const authSrc = String(ledger.authoritySourceAtEntry ?? ledger.authority ?? ledger.adoptedEngine ?? "").trim().toLowerCase();
    if (authSrc === "v2" || authSrc === "paper-v2") return true;

    // 2. Strategy version
    const strat = String(ledger.strategyVersion ?? "").trim().toLowerCase();
    if (strat.includes("v2") || strat.includes("paper") || strat.includes("highway")) return true;

    // 3. Entry stage
    if (typeof ledger.entryStage === "number" && ledger.entryStage >= 1) return true;

    // 4. Saved original entry price from earlier v2 migration
    if (typeof ledger.originalEntryPrice === "number" && ledger.originalEntryPrice > 0) return true;

    // 5. V2 Range / Box state at entry
    if (
        ledger.rangeBoxHighAtEntry != null ||
        ledger.rangeBoxLowAtEntry != null ||
        ledger.rangeBoxQuality != null ||
        ledger.v2RangeTp1Triggered === true
    ) {
        return true;
    }

    // 6. Bot execution timestamps / reasons
    if (ledger.lastBotExecutionReason != null || ledger.lastBotExecutionAt != null) return true;

    // 7. Client order ID evidence
    const clOrdId = String(ledger.exchangeClOrdId ?? "");
    if (clOrdId.startsWith("p") || clOrdId.startsWith("oap") || clOrdId.startsWith("sl") || clOrdId.startsWith("tp")) {
        return true;
    }

    // 8. Bot protective stop algo IDs
    const stopAlgo = String(ledger.protectiveSlAlgoId ?? ledger.protectiveStopAlgoId ?? "");
    if (stopAlgo.startsWith("oap") || stopAlgo.startsWith("sl") || stopAlgo.startsWith("tp")) {
        return true;
    }

    // 9. Position Cycle ID / Flow ID
    const cycleId = String(ledger.positionCycleId ?? ledger.flowId ?? "");
    if (cycleId && !cycleId.includes("manual_adopt") && !cycleId.includes("operator_adopt")) {
        if (cycleId.startsWith("BTC") || cycleId.startsWith("ETH") || cycleId.startsWith("p") || cycleId.startsWith("v2") || cycleId.includes(":")) {
            return true;
        }
    }

    // 10. Source signal (exclude explicit operator adoptions)
    const sig = String(ledger.sourceSignal ?? "").trim().toLowerCase();
    if (sig && sig !== "okx_reconcile_adopted" && sig !== "operator_adopted" && sig !== "manual_intervention_detected" && sig !== "manual_add") {
        return true;
    }

    // 11. Takeover reason was MANUAL_ADD / MANUAL_SIZE_CHANGE on pre-existing record
    const takeoverReason = String(ledger.manualTakeoverReason ?? "").trim().toUpperCase();
    if (takeoverReason === "MANUAL_ADD" || takeoverReason === "MANUAL_SIZE_CHANGE" || takeoverReason === "CONFIRMED_MANUAL_SIZE_CHANGE") {
        if (sig !== "operator_adopted" && sig !== "okx_reconcile_adopted" && ledger.lifecycleState !== "EXTERNAL_MANUAL_POSITION") {
            return true;
        }
    }

    return false;
}

export function evaluateManualAugmentReclassification(input: Readonly<{
    ledger: {
        symbol?: string;
        side?: string;
        okxContracts?: number | null;
        isV2Authority?: boolean;
        lifecycleState?: string;
        manualTakeoverActive?: boolean;
        manualOwnershipLatch?: boolean;
        manualTakeoverReason?: string | null;
        originalEntryPrice?: number;
        sourceSignal?: string | null;
        authoritySourceAtEntry?: string | null;
        authority?: string | null;
        adoptedEngine?: string | null;
        exchangeClOrdId?: string | null;
        strategyVersion?: string | null;
        entryStage?: number | null;
        positionCycleId?: string | null;
        flowId?: string | null;
        protectiveSlAlgoId?: string | null;
        protectiveStopAlgoId?: string | null;
        rangeBoxHighAtEntry?: number | null;
        rangeBoxLowAtEntry?: number | null;
        rangeBoxQuality?: number | null;
        v2RangeTp1Triggered?: boolean | null;
        lastBotExecutionReason?: string | null;
        lastBotExecutionAt?: number | null;
    };
    okxActualPositionExists: boolean;
    okxActualContracts: number;
    okxActualAvgPx: number;
    okxActualNotional: number;
    okxSide?: string | null;
    hasBotOrderEvidence?: boolean;
}>): Readonly<{
    shouldReclassify: boolean;
    reason: string | null;
}> {
    const ledger = input.ledger;
    if (!input.okxActualPositionExists || input.okxActualContracts <= 0) {
        return { shouldReclassify: false, reason: null };
    }

    // Exclude explicit manual adoptions from scratch
    const sig = String(ledger.sourceSignal ?? "").trim().toLowerCase();
    if (
        (sig === "operator_adopted" || sig === "okx_reconcile_adopted") &&
        input.hasBotOrderEvidence !== true &&
        ledger.isV2Authority !== true
    ) {
        return { shouldReclassify: false, reason: "MANUAL_ADOPTED_ORIGIN" };
    }

    const isBotOriginated = isBotOriginPositionEvidence(ledger, input.hasBotOrderEvidence);
    if (!isBotOriginated) {
        return { shouldReclassify: false, reason: "NOT_BOT_ORIGINATED" };
    }

    const ledgerSide = String(ledger.side ?? "").toLowerCase();
    const okxSide = String(input.okxSide ?? ledgerSide).toLowerCase();
    const isSameSide = okxSide === ledgerSide || okxSide === "net";
    if (!isSameSide) {
        return { shouldReclassify: false, reason: "OPPOSITE_SIDE_NOT_ELIGIBLE" };
    }

    const paperContracts = ledger.okxContracts ?? 0;
    const isSizeIncreased = input.okxActualContracts > paperContracts;
    const isCurrentlyOperatorManaged =
        ledger.lifecycleState === "OPERATOR_MANAGED" ||
        ledger.manualTakeoverActive === true ||
        ledger.manualOwnershipLatch === true;

    if (
        (isSizeIncreased || ledger.lifecycleState === "MANUAL_SIZE_AUGMENTED") &&
        (isCurrentlyOperatorManaged || ledger.lifecycleState === "MANUAL_SIZE_AUGMENTED")
    ) {
        return {
            shouldReclassify: true,
            reason: "SAME_SIDE_MANUAL_AUGMENT_RECLASSIFICATION"
        };
    }

    return { shouldReclassify: false, reason: null };
}
