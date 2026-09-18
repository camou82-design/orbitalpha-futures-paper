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
 * Requires at least ONE strong bot evidence.
 * Supporting fields (entryStage, flowId/positionCycleId structure) alone are NOT sufficient.
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
        originalSizeUsd?: number;
        sourceSignal?: string | null;
        authoritySourceAtEntry?: string | null;
        authority?: string | null;
        adoptedEngine?: string | null;
        exchangeClOrdId?: string | null;
        entryClOrdId?: string | null;
        strategyVersion?: string | null;
        entryStage?: number | null;
        positionCycleId?: string | null;
        flowId?: string | null;
        protectiveSlAlgoId?: string | null;
        protectiveStopAlgoId?: string | null;
        protectiveTpAlgoId?: string | null;
        rangeBoxHighAtEntry?: number | null;
        rangeBoxLowAtEntry?: number | null;
        rangeBoxQuality?: number | null;
        v2RangeTp1Triggered?: boolean | null;
        lastBotExecutionReason?: string | null;
        lastBotExecutionAt?: number | null;
    },
    hasBotOrderEvidence?: boolean
): boolean {
    // 0. Hard exclusions: explicit manual adoption or external manual position without overriding bot evidence
    const sig = String(ledger.sourceSignal ?? "").trim().toLowerCase();
    if (
        (sig === "operator_adopted" || sig === "okx_reconcile_adopted") &&
        hasBotOrderEvidence !== true &&
        ledger.isV2Authority !== true
    ) {
        return false;
    }
    if (
        ledger.lifecycleState === "EXTERNAL_MANUAL_POSITION" &&
        hasBotOrderEvidence !== true &&
        ledger.isV2Authority !== true
    ) {
        return false;
    }

    // 1. Account / Order History Strong Evidence
    if (hasBotOrderEvidence === true) return true;

    // 2. Strong Authority / Lifecycle State Evidence
    if (ledger.isV2Authority === true) return true;
    if (
        ledger.lifecycleState === "BOT_V2_MANAGED" ||
        ledger.lifecycleState === "MANUAL_SIZE_AUGMENTED" ||
        ledger.lifecycleState === "PARTIAL_ACTIVE" ||
        ledger.lifecycleState === "ADDON_ACTIVE"
    ) {
        return true;
    }

    // 3. Explicit V2 / paper / highway authority / strategy provenance
    const authSrc = String(
        ledger.authoritySourceAtEntry ?? ledger.authority ?? ledger.adoptedEngine ?? ""
    )
        .trim()
        .toLowerCase();
    if (authSrc === "v2" || authSrc === "paper-v2" || authSrc.includes("highway")) return true;

    const strat = String(ledger.strategyVersion ?? "").trim().toLowerCase();
    if (strat.includes("v2") || strat.includes("paper") || strat.includes("highway")) return true;

    // 4. Actual Bot Client Order ID
    const clOrdId = String(ledger.exchangeClOrdId ?? ledger.entryClOrdId ?? "").trim().toLowerCase();
    if (
        clOrdId.startsWith("p_") ||
        clOrdId.startsWith("oap_") ||
        clOrdId.startsWith("sl_") ||
        clOrdId.startsWith("tp_") ||
        clOrdId.startsWith("v2_") ||
        clOrdId.startsWith("highway_") ||
        clOrdId.startsWith("pbtc") ||
        clOrdId.startsWith("peth") ||
        /^p\d+/.test(clOrdId) ||
        /^oap\d+/.test(clOrdId)
    ) {
        return true;
    }

    // 5. Bot-Owned Protective Algo ID
    const stopAlgo = String(
        ledger.protectiveSlAlgoId ?? ledger.protectiveStopAlgoId ?? ledger.protectiveTpAlgoId ?? ""
    )
        .trim()
        .toLowerCase();
    if (
        stopAlgo.startsWith("oap_") ||
        stopAlgo.startsWith("sl_") ||
        stopAlgo.startsWith("tp_") ||
        stopAlgo.startsWith("v2_") ||
        stopAlgo.startsWith("oap")
    ) {
        return true;
    }

    // 6. Saved V2 Entry Structure / Range Metadata
    if (
        ledger.rangeBoxHighAtEntry != null ||
        ledger.rangeBoxLowAtEntry != null ||
        ledger.rangeBoxQuality != null ||
        ledger.v2RangeTp1Triggered === true
    ) {
        return true;
    }

    // 7. Bot Execution Evidence
    if (
        ledger.lastBotExecutionReason != null ||
        (typeof ledger.lastBotExecutionAt === "number" && ledger.lastBotExecutionAt > 0)
    ) {
        return true;
    }

    // 8. Explicit Bot Source Signal
    if (
        sig.startsWith("v2_") ||
        sig.startsWith("highway_") ||
        sig.startsWith("range_") ||
        sig.startsWith("trend_") ||
        sig.startsWith("bot_") ||
        sig.startsWith("paper_")
    ) {
        return true;
    }

    // Note: entryStage alone or positionCycleId/flowId containing ":" alone are NOT strong evidence and will return false.
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
