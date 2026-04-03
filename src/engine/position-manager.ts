import type { PaperClosedPositionRecord, PaperOpenPositionRecord } from "../models/types";
import type { PaperHealthReport } from "../storage/paper-health";
import type { JsonStore } from "../storage/json-store";

export class PositionManager {
  constructor(private readonly store: JsonStore) {}

  async loadOpenAll(): Promise<PaperOpenPositionRecord[]> {
    return await this.store.readPositionsOpenAll();
  }

  async saveOpenAll(positions: readonly PaperOpenPositionRecord[]): Promise<string> {
    return await this.store.writePositionsOpenAll(positions);
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
