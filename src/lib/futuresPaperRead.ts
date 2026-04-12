import type { FuturesPaperDataBundle } from "./futuresPaperBundleCore";
import {
  loadFuturesPaperBundleFromDiskRoot,
  normalizePositionsHistoryArray,
  paperOperationalFromEngineState
} from "./futuresPaperBundleCore";
import { buildLedgerPerformanceFromHistory } from "./futuresPaperLedgerStats";

export type {
  ClosedRowDisplayFields,
  FuturesPaperDataBundle,
  FuturesPaperHealthHistoryItem,
  FuturesPaperSymbolRow,
  NormalizedPaperClosedRow
} from "./futuresPaperBundleCore";
export {
  displayFieldsForClosedRow,
  normalizeClosedHistoryRow,
  normalizePositionsHistoryArray,
  paperOperationalFromEngineState
} from "./futuresPaperBundleCore";

const HEADER_TOKEN = "x-orbitalpha-futures-paper-token";

function emptyBundle(configHint: string): FuturesPaperDataBundle {
  const now = Date.now();
  return {
    configured: false,
    configHint,
    summary: null,
    summaryRange: null,
    summaryTrend: null,
    summaryDaily: null,
    summaryWindow: null,
    summaryHealth: null,
    dashboard: null,
    engineState: null,
    paperOperational: null,
    latestSnapshot: null,
    latestMeta: null,
    symbolRows: [],
    healthHistoryRecent: [],
    ledgerPerformance: null,
    openPositions: [],
    positionsHistory: [],
    eventsRecent: [],
    generatedAt: now
  };
}

function isBundleShape(v: unknown): v is FuturesPaperDataBundle {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.configured === "boolean" && Array.isArray(o.symbolRows) && Array.isArray(o.healthHistoryRecent);
}

async function loadFromRemoteApi(baseUrl: string, secret: string): Promise<FuturesPaperDataBundle> {
  const root = baseUrl.replace(/\/+$/, "");
  const url = `${root}/api/futures-paper/data`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        [HEADER_TOKEN]: secret,
        Authorization: `Bearer ${secret}`
      },
      cache: "no-store"
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return emptyBundle(`Lightsail API unreachable: ${msg}`);
  }
  if (res.status === 401 || res.status === 403) {
    return emptyBundle("Lightsail API rejected the token (check ORBITALPHA_FUTURES_PAPER_API_SECRET matches).");
  }
  if (!res.ok) {
    return emptyBundle(`Lightsail API error: HTTP ${res.status}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return emptyBundle("Lightsail API returned invalid JSON.");
  }
  if (!isBundleShape(json)) {
    return emptyBundle("Lightsail API response did not match the expected bundle shape.");
  }
  const b = json as FuturesPaperDataBundle;
  const generatedAt = typeof b.generatedAt === "number" && Number.isFinite(b.generatedAt) ? b.generatedAt : Date.now();
  const positionsHistory = normalizePositionsHistoryArray(Array.isArray(b.positionsHistory) ? b.positionsHistory : []);
  const withDefaults: FuturesPaperDataBundle = {
    ...b,
    ledgerPerformance: buildLedgerPerformanceFromHistory(positionsHistory as unknown[], generatedAt),
    openPositions: Array.isArray(b.openPositions) ? b.openPositions : [],
    positionsHistory,
    paperOperational: paperOperationalFromEngineState(b.engineState) ?? b.paperOperational,
    generatedAt
  };
  return withDefaults;
}

/**
 * Used by orbitalpha.kr homepage (Vercel): ORBITALPHA_FUTURES_PAPER_API_URL + ORBITALPHA_FUTURES_PAPER_API_SECRET.
 * Local: ORBITALPHA_FUTURES_PAPER_ROOT reads this repo's data/ layout.
 */
export async function loadFuturesPaperDataBundle(): Promise<FuturesPaperDataBundle> {
  const apiUrl = process.env.ORBITALPHA_FUTURES_PAPER_API_URL?.trim();
  if (apiUrl) {
    const secret = process.env.ORBITALPHA_FUTURES_PAPER_API_SECRET?.trim();
    if (!secret) {
      return emptyBundle(
        "Set ORBITALPHA_FUTURES_PAPER_API_SECRET (server-only, same value as on the Lightsail reader API)."
      );
    }
    return loadFromRemoteApi(apiUrl, secret);
  }

  const root = process.env.ORBITALPHA_FUTURES_PAPER_ROOT?.trim();
  if (root) {
    return loadFuturesPaperBundleFromDiskRoot(root);
  }

  return emptyBundle(
    "Set ORBITALPHA_FUTURES_PAPER_API_URL (+ ORBITALPHA_FUTURES_PAPER_API_SECRET) for production, or ORBITALPHA_FUTURES_PAPER_ROOT for local disk."
  );
}
