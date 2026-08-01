"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PositionManager = void 0;
const normalizeSideLower = (side) => {
    if (typeof side !== "string")
        return null;
    const s = side.trim().toLowerCase();
    if (s === "long")
        return "long";
    if (s === "short")
        return "short";
    return null;
};
class PositionManager {
    store;
    constructor(store) {
        this.store = store;
    }
    async loadOpenAll() {
        return await this.store.readPositionsOpenAll();
    }
    async saveOpenAll(positions) {
        return await this.store.writePositionsOpenAll(positions);
    }
    evaluateSymbolPositionMutex(symbol, requestedSide, openPositions, isScaleIn, addOnAllowed) {
        const authoritySideLower = normalizeSideLower(requestedSide);
        const sameSymbolOpenPositions = openPositions.filter((p) => String(p.symbol) === symbol);
        const sideEntries = sameSymbolOpenPositions
            .map((p) => {
            const side = normalizeSideLower(p.side);
            if (side == null)
                return null;
            return {
                side,
                id: `${String(p.symbol)}:${side}:${String(p.openedAt)}`
            };
        })
            .filter((x) => x != null);
        const existingSides = sideEntries.map((x) => x.side);
        const existingPositionIds = sideEntries.map((x) => x.id);
        const sameSideOpen = authoritySideLower != null &&
            existingSides.some((side) => side === authoritySideLower);
        const oppositeSideOpen = authoritySideLower != null &&
            existingSides.some((side) => side !== authoritySideLower);
        const pendingConfirmPresent = sameSymbolOpenPositions.some(p => p.lifecycleState === "PENDING_EXCHANGE_CONFIRM");
        const blockedReason = pendingConfirmPresent
            ? "PENDING_EXCHANGE_CONFIRM_LOCK"
            : (oppositeSideOpen
                ? "SYMBOL_OPPOSITE_POSITION_OPEN"
                : (sameSideOpen && !(isScaleIn || addOnAllowed)
                    ? "SYMBOL_SAME_SIDE_POSITION_ALREADY_OPEN"
                    : null));
        return {
            sameSymbolOpenCount: sameSymbolOpenPositions.length,
            sameSideOpen,
            oppositeSideOpen,
            existingSides,
            existingPositionIds,
            blocked: blockedReason != null,
            blockReason: blockedReason
        };
    }
    async ensureHistoryFile() {
        await this.store.ensurePositionsHistoryEmpty();
    }
    async appendClosed(record) {
        await this.store.appendPositionsHistory(record);
    }
    async deleteOpen() {
        await this.store.deletePositionsOpen();
    }
    /** Rewrite summary reports under `data/reports/` from `positions/history.json`. */
    async refreshSummaryReport(okxBalance) {
        return await this.store.writePaperSummaryReport(okxBalance);
    }
}
exports.PositionManager = PositionManager;
