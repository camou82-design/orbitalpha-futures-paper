export type V2CloseContractAuthoritySource =
    | "okx_actual_contracts"
    | "live_position_contracts"
    | "ledger_okx_contracts_fail_safe"
    | "blocked_no_authority";

export type V2CloseKind = "full" | "partial";

export function resolveV2CloseContractAuthority(input: Readonly<{
    symbol: string;
    side: "long" | "short";
    closeKind: V2CloseKind;
    okxActualContracts: number | null;
    okxActualAvailable: boolean;
    ledgerContracts: number | null;
    liveContracts?: number | null;
    sizeUsd?: number | null;
    isV2Authority: boolean;
    fullClose?: boolean;
}>): Readonly<{
    selectedContracts: number;
    contractAuthoritySource: V2CloseContractAuthoritySource;
    fallbackUsed: boolean;
    submitAllowed: boolean;
    blockReason: string | null;
    okxActualContracts: number | null;
    ledgerContracts: number | null;
    sizeUsd: number | null;
}> {
    const ledger =
        input.ledgerContracts != null && Number.isFinite(input.ledgerContracts) && input.ledgerContracts > 0
            ? input.ledgerContracts
            : null;
    const actual =
        input.okxActualContracts != null &&
        Number.isFinite(input.okxActualContracts) &&
        input.okxActualContracts > 0
            ? input.okxActualContracts
            : null;
    const live =
        input.liveContracts != null && Number.isFinite(input.liveContracts) && input.liveContracts > 0
            ? input.liveContracts
            : null;

    if (input.okxActualAvailable && actual != null) {
        return {
            selectedContracts: actual,
            contractAuthoritySource: "okx_actual_contracts",
            fallbackUsed: ledger != null && Math.abs(ledger - actual) > 1e-8,
            submitAllowed: true,
            blockReason: null,
            okxActualContracts: actual,
            ledgerContracts: ledger,
            sizeUsd: input.sizeUsd ?? null
        };
    }

    if (live != null) {
        return {
            selectedContracts: live,
            contractAuthoritySource: "live_position_contracts",
            fallbackUsed: ledger != null && Math.abs(ledger - live) > 1e-8,
            submitAllowed: true,
            blockReason: null,
            okxActualContracts: actual,
            ledgerContracts: ledger,
            sizeUsd: input.sizeUsd ?? null
        };
    }

    if (!input.isV2Authority && ledger != null) {
        return {
            selectedContracts: ledger,
            contractAuthoritySource: "ledger_okx_contracts_fail_safe",
            fallbackUsed: true,
            submitAllowed: true,
            blockReason: null,
            okxActualContracts: actual,
            ledgerContracts: ledger,
            sizeUsd: input.sizeUsd ?? null
        };
    }

    return {
        selectedContracts: 0,
        contractAuthoritySource: "blocked_no_authority",
        fallbackUsed: false,
        submitAllowed: false,
        blockReason: input.isV2Authority
            ? "v2_actual_contract_authority_unavailable"
            : "no_contract_authority",
        okxActualContracts: actual,
        ledgerContracts: ledger,
        sizeUsd: input.sizeUsd ?? null
    };
}

export function resolveV2ReduceContracts(input: Readonly<{
    symbol: string;
    side: "long" | "short";
    reduceRatio: number;
    okxActualContracts: number | null;
    okxActualAvailable: boolean;
    ledgerContracts: number | null;
    liveContracts?: number | null;
    sizeUsd?: number | null;
    isV2Authority: boolean;
}>): Readonly<{
    baseAuthority: ReturnType<typeof resolveV2CloseContractAuthority>;
    targetContracts: number;
    submitAllowed: boolean;
    blockReason: string | null;
}> {
    const baseAuthority = resolveV2CloseContractAuthority({
        symbol: input.symbol,
        side: input.side,
        closeKind: "partial",
        okxActualContracts: input.okxActualContracts,
        okxActualAvailable: input.okxActualAvailable,
        ledgerContracts: input.ledgerContracts,
        liveContracts: input.liveContracts,
        sizeUsd: input.sizeUsd,
        isV2Authority: input.isV2Authority,
        fullClose: false
    });

    if (!baseAuthority.submitAllowed || baseAuthority.selectedContracts <= 0) {
        return {
            baseAuthority,
            targetContracts: 0,
            submitAllowed: false,
            blockReason: baseAuthority.blockReason ?? "missing_base_contract_authority"
        };
    }

    const ratio = Math.min(1, Math.max(0, input.reduceRatio));
    const targetContracts = baseAuthority.selectedContracts * ratio;
    if (!(targetContracts > 0)) {
        return {
            baseAuthority,
            targetContracts: 0,
            submitAllowed: false,
            blockReason: "reduce_target_contracts_zero"
        };
    }

    if (ratio >= 1 - 1e-8) {
        return {
            baseAuthority,
            targetContracts: baseAuthority.selectedContracts,
            submitAllowed: true,
            blockReason: null
        };
    }

    if (targetContracts >= baseAuthority.selectedContracts - 1e-8) {
        return {
            baseAuthority,
            targetContracts: baseAuthority.selectedContracts,
            submitAllowed: false,
            blockReason: "partial_reduce_must_be_less_than_actual"
        };
    }

    return {
        baseAuthority,
        targetContracts,
        submitAllowed: true,
        blockReason: null
    };
}

export function buildV2CloseContractAuthorityProof(
    input: Record<string, unknown>
): Record<string, unknown> {
    return { event: "V2_CLOSE_CONTRACT_AUTHORITY_PROOF", ...input };
}
