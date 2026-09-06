import type { OkxDemoClient } from "../exchange/okx-demo";
import {
  readOkxAccountClosedTrades,
  saveOkxAccountClosedTrades,
  readOkxAccountTruthCursor,
  saveOkxAccountTruthCursor,
  type OkxAccountClosedTradeRecord
} from "../storage/account-truth-store";
import {
  reconstructLifecyclesFromFills,
  type OkxFillsHistoryItem
} from "./okxLifecycleReconstruction";
import { canonicalClosedTradeDedupKey } from "./paperClosedHistoryNormalize";

export interface SyncOkxAccountTruthOptions {
  dataDir: string;
  client: OkxDemoClient;
  bootstrapDays?: number;
  maxPages?: number;
}

export interface SyncOkxAccountTruthResult {
  ok: boolean;
  rawFillsFetched: number;
  newLifecyclesReconstructed: number;
  totalSavedTrades: number;
  lastFillTime: number;
  error?: string;
}

/**
 * Ingests OKX SWAP fills via read-only API and saves reconstructed lifecycles to account-truth store.
 * Never modifies bot trading positions or bot ledger.
 */
export async function syncOkxAccountTruthTrades(
  options: SyncOkxAccountTruthOptions
): Promise<SyncOkxAccountTruthResult> {
  const { dataDir, client, bootstrapDays = 7, maxPages = 5 } = options;

  try {
    const existingCursor = await readOkxAccountTruthCursor(dataDir);
    const existingTrades = await readOkxAccountClosedTrades(dataDir);

    const now = Date.now();
    const defaultBegin = now - bootstrapDays * 24 * 3600 * 1000;
    // Overlap by 5 minutes for safety
    const beginTime = existingCursor ? Math.max(defaultBegin, existingCursor.lastFillTime - 5 * 60 * 1000) : defaultBegin;

    const allRawFills: OkxFillsHistoryItem[] = [];
    let afterCursor: string | undefined = undefined;

    for (let page = 0; page < maxPages; page++) {
      const fillsRes = await client.getFillsHistory({
        instType: "SWAP",
        begin: String(beginTime),
        limit: "100",
        ...(afterCursor ? { after: afterCursor } : {})
      });

      if (!fillsRes.ok) {
        return {
          ok: false,
          rawFillsFetched: allRawFills.length,
          newLifecyclesReconstructed: 0,
          totalSavedTrades: existingTrades.length,
          lastFillTime: existingCursor?.lastFillTime ?? 0,
          error: fillsRes.error
        };
      }

      const list = Array.isArray(fillsRes.value) ? (fillsRes.value as unknown as OkxFillsHistoryItem[]) : [];
      if (list.length === 0) break;

      allRawFills.push(...list);

      // OKX pagination: after is older records
      if (list.length < 100) break;
      const lastItem = list[list.length - 1];
      afterCursor = lastItem.tradeId || lastItem.ordId;
    }

    if (allRawFills.length === 0) {
      return {
        ok: true,
        rawFillsFetched: 0,
        newLifecyclesReconstructed: 0,
        totalSavedTrades: existingTrades.length,
        lastFillTime: existingCursor?.lastFillTime ?? 0
      };
    }

    // Reconstruct lifecycles
    const reconstructed = reconstructLifecyclesFromFills(allRawFills);

    // Merge with existing trades using canonical key
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
      // Overwrite/update with latest reconstructed data
      tradeMap.set(key, t);
    }

    const mergedTrades = Array.from(tradeMap.values()).sort((a, b) => b.closedAt - a.closedAt);
    await saveOkxAccountClosedTrades(dataDir, mergedTrades);

    const maxFillTime = Math.max(
      existingCursor?.lastFillTime ?? 0,
      ...allRawFills.map((f) => Number(f.fillTime) || 0)
    );

    await saveOkxAccountTruthCursor(dataDir, {
      lastFillTime: maxFillTime,
      syncedAt: Date.now()
    });

    return {
      ok: true,
      rawFillsFetched: allRawFills.length,
      newLifecyclesReconstructed: newCount,
      totalSavedTrades: mergedTrades.length,
      lastFillTime: maxFillTime
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      rawFillsFetched: 0,
      newLifecyclesReconstructed: 0,
      totalSavedTrades: 0,
      lastFillTime: 0,
      error: msg
    };
  }
}
