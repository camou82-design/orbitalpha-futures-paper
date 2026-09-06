import type { OkxDemoClient } from "../exchange/okx-demo";
import { syncOkxAccountTruthTrades, type SyncOkxAccountTruthResult } from "./okxAccountTruthIngest";
import { readOkxAccountTruthCursor } from "../storage/account-truth-store";

export interface AccountTruthSchedulerOptions {
  dataDir: string;
  client: OkxDemoClient | null;
  syncIntervalMs?: number;
  bootstrapDays?: number;
  logger?: {
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
  };
}

export class OkxAccountTruthScheduler {
  private readonly dataDir: string;
  private readonly client: OkxDemoClient | null;
  private readonly syncIntervalMs: number;
  private readonly bootstrapDays: number;
  private readonly logger?: AccountTruthSchedulerOptions["logger"];

  private syncInFlight = false;
  private lastSyncStartedAt = 0;

  constructor(options: AccountTruthSchedulerOptions) {
    this.dataDir = options.dataDir;
    this.client = options.client;
    this.syncIntervalMs = options.syncIntervalMs ?? 60_000;
    this.bootstrapDays = options.bootstrapDays ?? 7;
    this.logger = options.logger;
  }

  isSyncInFlight(): boolean {
    return this.syncInFlight;
  }

  getLastSyncStartedAt(): number {
    return this.lastSyncStartedAt;
  }

  /**
   * Non-blocking scheduler check.
   * Checks whether a sync is due and triggers background execution without blocking the caller.
   * Returns true if a background sync was initiated, false otherwise.
   */
  triggerIfDue(now = Date.now()): boolean {
    if (!this.client) return false;
    if (this.syncInFlight) return false;

    const elapsed = now - this.lastSyncStartedAt;
    if (this.lastSyncStartedAt > 0 && elapsed < this.syncIntervalMs) {
      return false;
    }

    this.syncInFlight = true;
    this.lastSyncStartedAt = now;
    const syncStartedAt = now;

    // Background execution: never throws or blocks caller
    (async () => {
      const cursorBefore = await readOkxAccountTruthCursor(this.dataDir);
      const mode = cursorBefore && cursorBefore.lastFillTime > 0 ? "incremental" : "bootstrap";

      const res = await syncOkxAccountTruthTrades({
        dataDir: this.dataDir,
        client: this.client!,
        bootstrapDays: this.bootstrapDays
      });

      const syncFinishedAt = Date.now();
      const durationMs = syncFinishedAt - syncStartedAt;

      if (res.ok) {
        this.logger?.info("OKX_ACCOUNT_TRUTH_SYNC_PROOF", {
          event: "OKX_ACCOUNT_TRUTH_SYNC_PROOF",
          sync_started_at: syncStartedAt,
          sync_finished_at: syncFinishedAt,
          mode,
          fetched_fill_count: res.rawFillsFetched,
          reconstructed_lifecycle_count: res.newLifecyclesReconstructed,
          stored_closed_trade_count: res.totalSavedTrades,
          cursor_before: cursorBefore?.lastFillTime ?? null,
          cursor_after: res.lastFillTime,
          duration_ms: durationMs
        });
      } else {
        this.logger?.warn("OKX_ACCOUNT_TRUTH_SYNC_ERROR", {
          event: "OKX_ACCOUNT_TRUTH_SYNC_ERROR",
          sync_started_at: syncStartedAt,
          sync_finished_at: syncFinishedAt,
          mode,
          error: res.error ?? "unknown_sync_error",
          duration_ms: durationMs
        });
      }
    })()
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger?.error("OKX_ACCOUNT_TRUTH_SYNC_ERROR", {
          event: "OKX_ACCOUNT_TRUTH_SYNC_ERROR",
          error: msg,
          unhandled: false
        });
      })
      .finally(() => {
        this.syncInFlight = false;
      });

    return true;
  }
}
