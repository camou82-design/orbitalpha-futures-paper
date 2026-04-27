import type { PaperClosedPositionRecord, PaperOpenPositionRecord } from "../models/types";
import type { PaperHealthReport } from "../storage/paper-health";
import type { JsonStore } from "../storage/json-store";

type PositionSideLower = "long" | "short";

const normalizeSideLower = (side: unknown): PositionSideLower | null => {
  if (typeof side !== "string") return null;
  const s = side.trim().toLowerCase();
  if (s === "long") return "long";
  if (s === "short") return "short";
  return null;
};

export class PositionManager {
  constructor(private readonly store: JsonStore) {}

  async loadOpenAll(): Promise<PaperOpenPositionRecord[]> {
    return await this.store.readPositionsOpenAll();
  }

  async saveOpenAll(positions: readonly PaperOpenPositionRecord[]): Promise<string> {
    return await this.store.writePositionsOpenAll(positions);
  }

  evaluateSymbolPositionMutex(
    symbol: string,
    requestedSide: "long" | "short",
    openPositions: readonly PaperOpenPositionRecord[],
    isScaleIn: boolean,
    addOnAllowed: boolean
  ): {
    sameSymbolOpenCount: number;
    sameSideOpen: boolean;
    oppositeSideOpen: boolean;
    existingSides: PositionSideLower[];
    existingPositionIds: string[];
    blocked: boolean;
    blockReason: "SYMBOL_OPPOSITE_POSITION_OPEN" | "SYMBOL_SAME_SIDE_POSITION_ALREADY_OPEN" | null;
  } {
    const authoritySideLower = normalizeSideLower(requestedSide);
    const sameSymbolOpenPositions = openPositions.filter((p) => String(p.symbol) === symbol);
    const sideEntries = sameSymbolOpenPositions
      .map((p) => {
        const side = normalizeSideLower(p.side);
        if (side == null) return null;
        return {
          side,
          id: `${String(p.symbol)}:${side}:${String(p.openedAt)}`
        };
      })
      .filter((x): x is { side: PositionSideLower; id: string } => x != null);
    const existingSides = sideEntries.map((x) => x.side);
    const existingPositionIds = sideEntries.map((x) => x.id);
    const sameSideOpen =
      authoritySideLower != null &&
      existingSides.some((side) => side === authoritySideLower);
    const oppositeSideOpen =
      authoritySideLower != null &&
      existingSides.some((side) => side !== authoritySideLower);
    const blockedReason =
      oppositeSideOpen
        ? "SYMBOL_OPPOSITE_POSITION_OPEN"
        : (sameSideOpen && !(isScaleIn || addOnAllowed)
          ? "SYMBOL_SAME_SIDE_POSITION_ALREADY_OPEN"
          : null);
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

  async ensureHistoryFile(): Promise<void> {
    await this.store.ensurePositionsHistoryEmpty();
  }

  async appendClosed(record: PaperClosedPositionRecord): Promise<void> {
    await this.store.appendPositionsHistory(record);
  }

  async deleteOpen(): Promise<void> {
    await this.store.deletePositionsOpen();
  }

  /** Rewrite summary reports under `data/reports/` from `positions/history.json`. */
  async refreshSummaryReport(): Promise<{
    summaryPath: string;
    dailyPath: string;
    windowPath: string;
    healthPath: string;
    health: PaperHealthReport;
  }> {
    return await this.store.writePaperSummaryReport();
  }
}
