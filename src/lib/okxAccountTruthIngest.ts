import type { OkxDemoClient } from "../exchange/okx-demo";
import {
  readOkxAccountClosedTrades,
  saveOkxAccountClosedTrades,
  readOkxAccountTruthCursor,
  saveOkxAccountTruthCursor,
  readOkxRawFills,
  saveOkxRawFills,
  mergeAndDedupRawFills,
  type OkxAccountClosedTradeRecord
} from "../storage/account-truth-store";
import {
  reconstructLifecyclesFromFills,
  type OkxFillsHistoryItem
} from "./okxLifecycleReconstruction";
import {
  canonicalClosedTradeDedupKey,
  normalizePositionsHistoryArray
} from "./paperClosedHistoryNormalize";

export interface SyncOkxAccountTruthOptions {
  dataDir: string;
  client: OkxDemoClient;
  bootstrapDays?: number;
  maxPages?: number;
  forceBackfill?: boolean;
}

export interface SyncOkxAccountTruthResult {
  ok: boolean;
  rawFillsFetched: number;
  totalRawFillsCount: number;
  newLifecyclesReconstructed: number;
  totalLifecyclesCount: number;
  totalSavedTrades: number;
  dashboardPositionsCount: number;
  lastFillTime: number;
  isTruncated: boolean;
  error?: string;
}

export interface BackfillOkxAccountTruthOptions {
  dataDir: string;
  client: OkxDemoClient;
  bootstrapDays?: number;
  maxPages?: number;
}

/**
 * Ingests OKX SWAP fills via read-only API and saves reconstructed lifecycles to account-truth store.
 * Persists deduplicated raw fills history so that lifecycles spanning multiple sync batches are never lost.
 * Never modifies bot trading positions or bot ledger.
 */
export async function syncOkxAccountTruthTrades(
  options: SyncOkxAccountTruthOptions
): Promise<SyncOkxAccountTruthResult> {
  const { dataDir, client, bootstrapDays = 7, maxPages = 50, forceBackfill = false } = options;

  try {
    const existingRawFills = await readOkxRawFills(dataDir);
    const existingTrades = await readOkxAccountClosedTrades(dataDir);
    const existingCursor = await readOkxAccountTruthCursor(dataDir);

    const now = Date.now();
    const defaultBegin = now - bootstrapDays * 24 * 3600 * 1000;
    // For incremental sync, overlap by 5 minutes from last known fill time.
    // For force backfill or when no cursor exists, start from bootstrap begin time.
    const beginTime =
      !forceBackfill && existingCursor && existingCursor.lastFillTime > 0
        ? Math.max(defaultBegin, existingCursor.lastFillTime - 5 * 60 * 1000)
        : defaultBegin;

    const newFetchedFills: OkxFillsHistoryItem[] = [];
    let afterCursor: string | undefined = undefined;
    let isTruncated = false;
    const seenCursors = new Set<string>();

    for (let page = 0; page < maxPages; page++) {
      if (page > 0) {
        await new Promise((r) => setTimeout(r, 400));
      }

      let fillsRes = await client.getFillsHistory({
        instType: "SWAP",
        begin: String(beginTime),
        limit: "100",
        ...(afterCursor ? { after: afterCursor } : {})
      });

      if (!fillsRes.ok && typeof fillsRes.error === "string" && fillsRes.error.includes("429")) {
        await new Promise((r) => setTimeout(r, 1500));
        fillsRes = await client.getFillsHistory({
          instType: "SWAP",
          begin: String(beginTime),
          limit: "100",
          ...(afterCursor ? { after: afterCursor } : {})
        });
      }

      if (!fillsRes.ok) {
        const reconstructed = reconstructLifecyclesFromFills(existingRawFills);
        const dashboardPositionsCount = normalizePositionsHistoryArray(existingTrades).length;
        return {
          ok: false,
          rawFillsFetched: newFetchedFills.length,
          totalRawFillsCount: existingRawFills.length,
          newLifecyclesReconstructed: 0,
          totalLifecyclesCount: reconstructed.length,
          totalSavedTrades: existingTrades.length,
          dashboardPositionsCount,
          lastFillTime: existingCursor?.lastFillTime ?? 0,
          isTruncated: false,
          error: fillsRes.error
        };
      }

      const list = Array.isArray(fillsRes.value) ? (fillsRes.value as unknown as OkxFillsHistoryItem[]) : [];
      if (list.length === 0) break;

      newFetchedFills.push(...list);

      const firstItem = list[0];
      const lastItem = list[list.length - 1];
      const firstBillId = String(firstItem.billId ?? "").trim();
      const lastBillId = String(lastItem.billId ?? "").trim();
      const firstFillTime = Number(firstItem.fillTime) || 0;
      const lastFillTime = Number(lastItem.fillTime) || 0;

      let nextAfterCursor: string | undefined = undefined;
      let shouldHalt = false;

      if (list.length >= 100) {
        const candidateCursor = String(lastItem.billId ?? "").trim();
        if (!candidateCursor) {
          isTruncated = true;
          shouldHalt = true;
          console.warn("OKX_ACCOUNT_TRUTH_BILL_ID_MISSING_PROOF", {
            event: "OKX_ACCOUNT_TRUTH_BILL_ID_MISSING_PROOF",
            page: page + 1,
            returned_count: list.length,
            last_trade_id: lastItem.tradeId ?? null,
            last_ord_id: lastItem.ordId ?? null,
            action: "safe_pagination_halt"
          });
        } else if (seenCursors.has(candidateCursor) || afterCursor === candidateCursor) {
          isTruncated = true;
          shouldHalt = true;
          console.warn("OKX_ACCOUNT_TRUTH_PAGINATION_DUPLICATE_CURSOR_PROOF", {
            event: "OKX_ACCOUNT_TRUTH_PAGINATION_DUPLICATE_CURSOR_PROOF",
            page: page + 1,
            duplicate_cursor: candidateCursor,
            action: "halt_infinite_loop"
          });
        } else {
          nextAfterCursor = candidateCursor;
          seenCursors.add(candidateCursor);
        }
      }

      console.log("OKX_ACCOUNT_TRUTH_PAGE_FETCH_PROOF", {
        event: "OKX_ACCOUNT_TRUTH_PAGE_FETCH_PROOF",
        page: page + 1,
        returned_count: list.length,
        first_bill_id: firstBillId || null,
        last_bill_id: lastBillId || null,
        first_fill_time: firstFillTime,
        last_fill_time: lastFillTime,
        next_after_cursor: nextAfterCursor ?? null
      });

      if (shouldHalt) {
        break;
      }

      // OKX pagination: after is older records. If list < 100, we reached the end.
      if (list.length < 100) {
        break;
      }

      if (page === maxPages - 1 && list.length === 100) {
        isTruncated = true;
        console.warn("OKX_ACCOUNT_TRUTH_PAGINATION_TRUNCATED_PROOF", {
          event: "OKX_ACCOUNT_TRUTH_PAGINATION_TRUNCATED_PROOF",
          max_pages: maxPages,
          fetched_so_far: newFetchedFills.length,
          last_cursor: nextAfterCursor
        });
      }

      afterCursor = nextAfterCursor;
    }

    // Merge newly fetched fills into the persistent raw fill store with stable deduplication
    const allMergedRawFills = mergeAndDedupRawFills(existingRawFills, newFetchedFills);
    await saveOkxRawFills(dataDir, allMergedRawFills);

    // Reconstruct lifecycles from the complete continuous stream of deduplicated fills
    const reconstructed = reconstructLifecyclesFromFills(allMergedRawFills);

    // Merge reconstructed trades with existing store using canonical dedup keys
    const tradeMap = new Map<string, OkxAccountClosedTradeRecord>();
    for (const t of existingTrades) {
      const key = canonicalClosedTradeDedupKey(t) || t.lifecycleId;
      if (key) tradeMap.set(key, t);
    }

    let newCount = 0;
    for (const t of reconstructed) {
      const key = canonicalClosedTradeDedupKey(t) || t.lifecycleId;
      if (!key) continue;
      if (!tradeMap.has(key)) {
        newCount++;
      }
      tradeMap.set(key, t);
    }

    const mergedTrades = Array.from(tradeMap.values()).sort((a, b) => b.closedAt - a.closedAt);
    await saveOkxAccountClosedTrades(dataDir, mergedTrades);

    const maxFillTime = Math.max(
      existingCursor?.lastFillTime ?? 0,
      ...allMergedRawFills.map((f) => Number(f.fillTime) || 0)
    );

    await saveOkxAccountTruthCursor(dataDir, {
      lastFillTime: maxFillTime,
      syncedAt: Date.now()
    });

    // Compute normalized dashboard positions history count for parity cross-check
    const normalizedDashboardTrades = normalizePositionsHistoryArray(mergedTrades);
    const dashboardPositionsCount = normalizedDashboardTrades.length;

    const oldestFillTime =
      allMergedRawFills.length > 0
        ? Math.min(...allMergedRawFills.map((f) => Number(f.fillTime) || Number.MAX_SAFE_INTEGER))
        : 0;
    const reachedBeginWindow = oldestFillTime > 0 && oldestFillTime <= beginTime;

    console.log("OKX_ACCOUNT_TRUTH_BACKFILL_RANGE_PROOF", {
      event: "OKX_ACCOUNT_TRUTH_BACKFILL_RANGE_PROOF",
      requested_begin_time: beginTime,
      oldest_fill_time: oldestFillTime,
      newest_fill_time: maxFillTime,
      total_raw_fills: allMergedRawFills.length,
      reached_begin_window: reachedBeginWindow,
      is_truncated: isTruncated
    });

    console.log("OKX_ACCOUNT_TRUTH_INGEST_PROOF", {
      event: "OKX_ACCOUNT_TRUTH_INGEST_PROOF",
      raw_fills_count: allMergedRawFills.length,
      new_fills_fetched: newFetchedFills.length,
      reconstructed_lifecycles_count: reconstructed.length,
      account_truth_closed_trades_count: mergedTrades.length,
      dashboard_positions_history_count: dashboardPositionsCount,
      cursor_after: maxFillTime,
      is_truncated: isTruncated
    });

    return {
      ok: true,
      rawFillsFetched: newFetchedFills.length,
      totalRawFillsCount: allMergedRawFills.length,
      newLifecyclesReconstructed: newCount,
      totalLifecyclesCount: reconstructed.length,
      totalSavedTrades: mergedTrades.length,
      dashboardPositionsCount,
      lastFillTime: maxFillTime,
      isTruncated
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      rawFillsFetched: 0,
      totalRawFillsCount: 0,
      newLifecyclesReconstructed: 0,
      totalLifecyclesCount: 0,
      totalSavedTrades: 0,
      dashboardPositionsCount: 0,
      lastFillTime: 0,
      isTruncated: false,
      error: msg
    };
  }
}

/**
 * One-time historical backfill path.
 * Fetches all available fills across the specified bootstrap window,
 * merges into raw fills store, reconstructs all lifecycles, and recovers any missing closed trades.
 */
export async function backfillOkxAccountTruthTrades(
  options: BackfillOkxAccountTruthOptions
): Promise<SyncOkxAccountTruthResult> {
  const { dataDir, client, bootstrapDays = 30, maxPages = 100 } = options;
  console.log("OKX_HISTORICAL_BACKFILL_START_PROOF", {
    event: "OKX_HISTORICAL_BACKFILL_START_PROOF",
    bootstrap_days: bootstrapDays,
    max_pages: maxPages
  });

  const res = await syncOkxAccountTruthTrades({
    dataDir,
    client,
    bootstrapDays,
    maxPages,
    forceBackfill: true
  });

  console.log("OKX_HISTORICAL_BACKFILL_COMPLETE_PROOF", {
    event: "OKX_HISTORICAL_BACKFILL_COMPLETE_PROOF",
    ok: res.ok,
    raw_fills_count: res.totalRawFillsCount,
    reconstructed_lifecycles_count: res.totalLifecyclesCount,
    account_truth_closed_trades_count: res.totalSavedTrades,
    dashboard_positions_history_count: res.dashboardPositionsCount,
    is_truncated: res.isTruncated,
    error: res.error ?? null
  });

  return res;
}
