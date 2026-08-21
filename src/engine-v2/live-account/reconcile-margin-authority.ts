import { isV2AuthorityRow } from "./position-size-authority";
import type { PaperOpenPositionRecord } from "../../models/types";

export const RECONCILE_NOTIONAL_TOLERANCE_USD = 1.0;
export const RECONCILE_MARGIN_INVARIANT_TOLERANCE_USD = 0.15;
export const RECONCILE_CONTRACT_TOLERANCE_RATIO = 0.001;

export type RemotePositionUnits = Readonly<{
    contracts: number;
    notionalUsd: number;
    marginUsd: number;
    leverage: number;
    avgPx: number;
}>;

export function contractTolerance(contracts: number): number {
    return Math.max(1e-8, RECONCILE_CONTRACT_TOLERANCE_RATIO * contracts);
}

export function contractsAligned(ledgerContracts: number, remoteContracts: number): boolean {
    return Math.abs(ledgerContracts - remoteContracts) <= contractTolerance(remoteContracts);
}

export function resolveLedgerMarginUsd(open: Pick<PaperOpenPositionRecord, "sizeUsd" | "notionalUsd" | "leverage" | "isV2Authority" | "lifecycleState" | "authoritySourceAtEntry" | "authority">): number {
    const leverage = Math.max(1, open.leverage ?? 10);
    if (isV2AuthorityRow(open)) {
        const notional = open.notionalUsd ?? open.sizeUsd ?? 0;
        return notional > 0 ? notional / leverage : 0;
    }
    return open.sizeUsd ?? 0;
}

/**
 * Returns true when a V2 row stores notional in sizeUsd (correct) rather than margin.
 */
export function isV2NotionalSizeUsdCorrect(open: Pick<PaperOpenPositionRecord, "sizeUsd" | "notionalUsd" | "isV2Authority" | "lifecycleState" | "authoritySourceAtEntry" | "authority">): boolean {
    if (!isV2AuthorityRow(open)) return false;
    const notional = open.notionalUsd ?? 0;
    if (!(notional > 0)) return false;
    return Math.abs((open.sizeUsd ?? 0) - notional) / notional <= 0.02;
}

/**
 * Detect legacy rows where sizeUsd accidentally holds notional instead of margin.
 */
export function detectLegacyMarginUnitPollution(
    open: Pick<PaperOpenPositionRecord, "sizeUsd" | "notionalUsd" | "entryPrice" | "okxContracts" | "leverage" | "isV2Authority" | "lifecycleState" | "authoritySourceAtEntry" | "authority">,
    remote: RemotePositionUnits,
    priceToleranceRatio: number
): boolean {
    if (isV2AuthorityRow(open)) return false;

    const leverage = remote.leverage || open.leverage || 10;
    const ledgerNotional = open.notionalUsd ?? open.sizeUsd;
    const ledgerMargin = open.sizeUsd;
    if (!(ledgerNotional > 0 && ledgerMargin > 0)) return false;

    const marginNotionalConfused =
        Math.abs(ledgerMargin - ledgerNotional) / Math.max(ledgerNotional, 1e-9) < 0.02;
    if (!marginNotionalConfused) return false;

    const priceOk =
        Math.abs(open.entryPrice - remote.avgPx) / Math.max(open.entryPrice || 1, 1e-9) <= priceToleranceRatio;
    const notionalOk = Math.abs(ledgerNotional - remote.notionalUsd) <= RECONCILE_NOTIONAL_TOLERANCE_USD;
    if (!priceOk || !notionalOk) return false;

    const expectedMargin = remote.notionalUsd / leverage;
    const looksLikeNotionalStoredAsMargin =
        Math.abs(ledgerMargin - remote.notionalUsd) / Math.max(remote.notionalUsd, 1e-9) < 0.02 &&
        Math.abs(expectedMargin - remote.marginUsd) / Math.max(remote.marginUsd, 1e-9) < 0.05;
    if (!looksLikeNotionalStoredAsMargin) return false;

    if (typeof open.okxContracts === "number" && open.okxContracts > 0) {
        if (!contractsAligned(open.okxContracts, remote.contracts)) return false;
    }
    return true;
}

/**
 * V2 reconcile: mark-price notional drift with unchanged contracts must not hard-block.
 */
export function marginReconcileToleranceUsd(marginUsd: number): number {
    return Math.max(RECONCILE_MARGIN_INVARIANT_TOLERANCE_USD, marginUsd * 0.02);
}

export function evaluateV2NotionalReconcile(input: Readonly<{
    open: Pick<PaperOpenPositionRecord, "sizeUsd" | "notionalUsd" | "okxContracts" | "leverage" | "isV2Authority" | "lifecycleState" | "authoritySourceAtEntry" | "authority">;
    remote: RemotePositionUnits;
}>): Readonly<{
    contractsAligned: boolean;
    marginAligned: boolean;
    notionalDriftOnly: boolean;
    mismatchType: "MATCHED" | "NOTIONAL_MISMATCH" | "CONTRACT_MISMATCH";
    ledgerMarginUsd: number;
}> {
    const { open, remote } = input;
    const ledgerContracts = open.okxContracts ?? 0;
    const aligned = ledgerContracts > 0 && contractsAligned(ledgerContracts, remote.contracts);
    const ledgerMarginUsd = resolveLedgerMarginUsd(open);
    const marginTol = marginReconcileToleranceUsd(remote.marginUsd);
    const marginAligned =
        Math.abs(ledgerMarginUsd - remote.marginUsd) <= marginTol;
    const ledgerNotional = open.notionalUsd ?? open.sizeUsd ?? 0;
    const notionalDiff = Math.abs(ledgerNotional - remote.notionalUsd);
    const notionalDriftOnly = aligned && notionalDiff > RECONCILE_NOTIONAL_TOLERANCE_USD && marginAligned;

    if (!aligned && ledgerContracts > 0) {
        return {
            contractsAligned: false,
            marginAligned,
            notionalDriftOnly: false,
            mismatchType: "CONTRACT_MISMATCH",
            ledgerMarginUsd
        };
    }

    if (notionalDriftOnly || (aligned && marginAligned)) {
        return {
            contractsAligned: aligned,
            marginAligned,
            notionalDriftOnly,
            mismatchType: "MATCHED",
            ledgerMarginUsd
        };
    }

    if (notionalDiff > RECONCILE_NOTIONAL_TOLERANCE_USD) {
        return {
            contractsAligned: aligned,
            marginAligned,
            notionalDriftOnly: false,
            mismatchType: "NOTIONAL_MISMATCH",
            ledgerMarginUsd
        };
    }

    return {
        contractsAligned: aligned,
        marginAligned,
        notionalDriftOnly: false,
        mismatchType: "MATCHED",
        ledgerMarginUsd
    };
}

/**
 * Exposes unit bug when margin is compared using notional-sized ledger.sizeUsd.
 */
export function detectV2MarginComparedAsNotionalBug(
    open: Pick<PaperOpenPositionRecord, "sizeUsd" | "notionalUsd" | "leverage" | "isV2Authority" | "lifecycleState" | "authoritySourceAtEntry" | "authority">,
    remote: RemotePositionUnits
): boolean {
    if (!isV2AuthorityRow(open)) return false;
    const leverage = Math.max(1, remote.leverage || open.leverage || 10);
    const wrongMarginCompare = open.sizeUsd ?? 0;
    const expectedMargin = remote.notionalUsd / leverage;
    return (
        Math.abs(wrongMarginCompare - remote.notionalUsd) / Math.max(remote.notionalUsd, 1e-9) < 0.02 &&
        Math.abs(wrongMarginCompare - remote.marginUsd) / Math.max(remote.marginUsd, 1e-9) > 0.5 &&
        Math.abs(expectedMargin - remote.marginUsd) / Math.max(remote.marginUsd, 1e-9) < 0.05
    );
}
