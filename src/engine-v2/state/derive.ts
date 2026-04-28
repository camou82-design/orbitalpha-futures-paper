import type { EngineV2Input, EngineV2Position, EngineV2Side } from "../types";
import type { V2StateAuthority } from "./types";

function inferIntentSide(input: EngineV2Input): EngineV2Side {
    const s = input.snapshot?.signal ?? "none";
    if (s === "paper_long_candidate") return "long";
    if (s === "paper_short_candidate") return "short";
    const emaGap = Number(input.snapshot?.emaGap ?? 0);
    if (emaGap > 0) return "long";
    if (emaGap < 0) return "short";
    return "none";
}

function toSideLower(p: EngineV2Position): "long" | "short" | "none" {
    const side = String(p.side).toLowerCase();
    if (side === "long") return "long";
    if (side === "short") return "short";
    return "none";
}

function ledgerNotionalKrw(positions: EngineV2Position[]): number {
    return Math.round(
        positions.reduce((acc, p) => acc + Math.max(0, Number(p.sizeUsd ?? 0)), 0)
    );
}

export function deriveV2StateAuthority(input: EngineV2Input): V2StateAuthority {
    const rawPositions = Array.isArray(input.state.currentPositions) ? input.state.currentPositions : [];
    const currentPositions = rawPositions.filter((p) => p != null);
    const symbol = input.symbol;
    const symbolPositions = currentPositions.filter((p) => p.symbol === symbol);
    const inferredIntentSide = inferIntentSide(input);
    const sameSidePosition =
        inferredIntentSide === "long" || inferredIntentSide === "short"
            ? symbolPositions.find((p) => toSideLower(p) === inferredIntentSide) ?? null
            : null;
    const oppositeSidePosition =
        inferredIntentSide === "long"
            ? symbolPositions.find((p) => toSideLower(p) === "short") ?? null
            : inferredIntentSide === "short"
                ? symbolPositions.find((p) => toSideLower(p) === "long") ?? null
                : null;
    const marketSnapshotReady =
        input.snapshot != null &&
        Number.isFinite(input.snapshot.lastPrice) &&
        input.snapshot.lastPrice > 0 &&
        Number.isFinite(input.snapshot.latestCandleClose);
    const positionStateReady = Array.isArray(input.state.currentPositions);
    const v2InputReady = marketSnapshotReady && positionStateReady;
    const killSwitch = input.state.killSwitch === true || input.state.killSwitchActive === true;
    const reconcileSafeMode = input.state.reconcileSafeMode === true || input.state.reconcileSafeModeActive === true;
    const crashState = String(input.state.crashState ?? "NONE").toUpperCase();
    const pumpState = String(input.state.pumpState ?? input.state.pump_state ?? "NONE").toUpperCase();
    return {
        symbol,
        now: input.now,
        currentPositions,
        symbolPositions,
        sameSidePosition,
        oppositeSidePosition,
        hasSameSidePosition: sameSidePosition != null,
        hasOppositeSidePosition: oppositeSidePosition != null,
        currentStage: sameSidePosition ? Math.max(1, Number(sameSidePosition.entryStage ?? 1)) : 0,
        positionStateReady,
        marketSnapshotReady,
        v2InputReady,
        serverTradeEnabled: input.state.serverTradeEnabled !== false,
        closeOnlyMode: input.state.closeOnlyMode === true,
        killSwitch,
        reconcileSafeMode,
        riskMode: input.state.riskMode ?? null,
        dailyLossGuardTriggered: input.state.dailyLossGuardTriggered === true,
        freshTickBarrierActive: input.state.freshTickBarrierActive === true,
        freshTickExecutionBlocked: input.state.freshTickExecutionBlocked === true,
        freshTickCompletedCycles: Number.isFinite(input.state.freshTickCompletedCycles) ? input.state.freshTickCompletedCycles : 0,
        freshTickRequiredCycles: Number.isFinite(input.state.freshTickRequiredCycles) ? input.state.freshTickRequiredCycles : 0,
        paperExecutionReady: input.state.paperExecutionReady === true,
        signedExecutionReady: input.state.signedExecutionReady === true,
        directionalShockState: input.state.directionalShockState ?? "NONE",
        crashState,
        pumpState,
        longAllow: input.state.longAllow !== false,
        shortAllow: input.state.shortAllow !== false,
        accountEquityKrw: Number.isFinite(input.state.accountEquityKrw) ? Number(input.state.accountEquityKrw) : 500_000,
        maxUsableMarginKrw: Number.isFinite(input.state.maxUsableMarginKrw) ? Number(input.state.maxUsableMarginKrw) : 420_000,
        exposureNotionalCapKrw: Number.isFinite(input.state.exposureNotionalCapKrw) ? Number(input.state.exposureNotionalCapKrw) : 2_000_000,
        symbolExposureNotionalCapKrw: Number.isFinite(input.state.symbolExposureNotionalCapKrw) ? Number(input.state.symbolExposureNotionalCapKrw) : 1_400_000,
        ledgerExposureNotionalKrw: ledgerNotionalKrw(currentPositions),
        symbolLedgerExposureNotionalKrw: ledgerNotionalKrw(symbolPositions),
        lossStreaks: input.state.lossStreaks ?? {},
        entryQualityProfiles: input.state.entryQualityProfiles,
        stateAuthoritySource: "v2_state_authority_from_bridge",
        inferredIntentSide
    };
}
