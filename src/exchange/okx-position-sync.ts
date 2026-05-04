/**
 * Normalize OKX `/api/v5/account/positions` SWAP rows for hedge (`long`/`short`) and net (`net`/empty posSide) modes.
 */

export type OkxSwapLedgerKeyParts = Readonly<{
  /** Paper ledger style e.g. `BTCUSDT:short` */
  key: string;
  symbol: string;
  side: "long" | "short";
  posSigned: number;
  avgPx: number;
  notionalUsd: number;
  instId: string;
}>;

export type LedgerOkxPositionSyncSnapshot = Readonly<{
  sync_status: 
    | "ALIGNED" 
    | "OKX_ONLY" 
    | "LEDGER_ONLY" 
    | "KEY_MISMATCH" 
    | "SIZE_MISMATCH" 
    | "NOTIONAL_MISMATCH" 
    | "AVG_PRICE_MISMATCH" 
    | "REMOTE_UNAVAILABLE"
    | "MANUAL_PARTIAL_DETECTED"
    | "MANUAL_FULL_CLOSE_DETECTED"
    | "ADOPTED_POSITION_SIZE_MISMATCH"
    | "ADOPTED_POSITION_MANUAL_PARTIAL_DETECTED";
  okx_nonzero_position_count: number;
  paper_open_position_count: number;
  okx_positions_preview: ReadonlyArray<{
    symbol: string;
    side: "long" | "short";
    instId: string;
    pos: number;
    avgPx: number;
    notionalUsd: number;
  }>;
  paper_positions_preview: ReadonlyArray<{ 
    symbol: string; 
    side: "long" | "short";
    pos: number;
    entryPrice: number;
    sizeUsd: number;
    reconcileState?: string;
  }>;
  detail: string | null;
}>;

const NOTIONAL_TOLERANCE_USD = 1.0;
const PRICE_TOLERANCE_RATIO = 0.0005; // 0.05%

export function okxSwapRowToLedgerKey(row: Record<string, unknown>): OkxSwapLedgerKeyParts | null {
  const instId = String(row.instId ?? "");
  const posRaw = row.pos;
  const posNum = typeof posRaw === "number" ? posRaw : typeof posRaw === "string" ? Number(posRaw) : NaN;
  if (!Number.isFinite(posNum) || Math.abs(posNum) <= 0) return null;

  const avgPxRaw = row.avgPx;
  const avgPx = typeof avgPxRaw === "number" ? avgPxRaw : typeof avgPxRaw === "string" ? Number(avgPxRaw) : 0;
  
  const notionalUsdRaw = row.notionalUsd;
  const notionalUsd = typeof notionalUsdRaw === "number" ? notionalUsdRaw : typeof notionalUsdRaw === "string" ? Number(notionalUsdRaw) : 0;

  const posSideRaw = String(row.posSide ?? "").trim().toLowerCase();
  let side: "long" | "short";
  if (posSideRaw === "short") side = "short";
  else if (posSideRaw === "long") side = "long";
  else {
    side = posNum < 0 ? "short" : "long";
  }

  const symbol = instId.endsWith("-USDT-SWAP") ? `${instId.slice(0, -"-USDT-SWAP".length)}USDT` : instId;
  return { key: `${symbol}:${side}`, symbol, side, posSigned: posNum, avgPx, notionalUsd, instId };
}

export function buildLedgerOkxPositionSyncSnapshot(
  paperOpens: ReadonlyArray<{ 
    symbol: string; 
    side: string; 
    pos?: number; 
    entryPrice: number; 
    sizeUsd: number;
    status?: string; 
    lifecycleState?: string;
    reconcileState?: string;
  }>,
  okxPayload: ReadonlyArray<Record<string, unknown>> | null | undefined
): LedgerOkxPositionSyncSnapshot {
  const paperMap = new Map<string, typeof paperOpens[0]>();
  const paper_positions_preview: Array<{ 
    symbol: string; 
    side: "long" | "short";
    pos: number;
    entryPrice: number;
    sizeUsd: number;
    reconcileState?: string;
  }> = [];

  for (const p of paperOpens) {
    if ((p.status ?? "open") !== "open") continue;
    if (p.lifecycleState === "FAILED") continue;
    const side: "long" | "short" = String(p.side).toLowerCase() === "short" ? "short" : "long";
    const key = `${String(p.symbol)}:${side}`;
    paperMap.set(key, p);
    paper_positions_preview.push({
      symbol: String(p.symbol),
      side,
      pos: p.pos ?? (p.sizeUsd / (p.entryPrice || 1)),
      entryPrice: p.entryPrice,
      sizeUsd: p.sizeUsd,
      reconcileState: p.reconcileState
    });
  }

  const paper_open_position_count = paperMap.size;

  if (!okxPayload || !Array.isArray(okxPayload)) {
    return {
      sync_status: "REMOTE_UNAVAILABLE",
      okx_nonzero_position_count: 0,
      paper_open_position_count,
      okx_positions_preview: [],
      paper_positions_preview,
      detail: "OKX positions payload unavailable for sync comparison"
    };
  }

  const okx_positions_preview: Array<{
    symbol: string;
    side: "long" | "short";
    instId: string;
    pos: number;
    avgPx: number;
    notionalUsd: number;
  }> = [];
  const okxMap = new Map<string, OkxSwapLedgerKeyParts>();

  for (const row of okxPayload) {
    const hit = okxSwapRowToLedgerKey(row as Record<string, unknown>);
    if (!hit) continue;
    okxMap.set(hit.key, hit);
    okx_positions_preview.push({
      symbol: hit.symbol,
      side: hit.side,
      instId: hit.instId,
      pos: Math.abs(hit.posSigned),
      avgPx: hit.avgPx,
      notionalUsd: hit.notionalUsd
    });
  }

  const okx_nonzero_position_count = okxMap.size;

  let sync_status: LedgerOkxPositionSyncSnapshot["sync_status"] = "ALIGNED";
  let detail: string | null = null;

  if (okx_nonzero_position_count === 0 && paper_open_position_count === 0) {
    sync_status = "ALIGNED";
  } else if (okx_nonzero_position_count > 0 && paper_open_position_count === 0) {
    sync_status = "OKX_ONLY";
    detail = "Exchange reports open SWAP positions but paper ledger has no active rows";
  } else if (okx_nonzero_position_count === 0 && paper_open_position_count > 0) {
    sync_status = "MANUAL_FULL_CLOSE_DETECTED";
    detail = "Paper ledger lists open positions but OKX SWAP snapshot shows none (Manual full close suspected)";
  } else {
    // Key-level comparison
    const okxKeys = Array.from(okxMap.keys());
    const paperKeys = Array.from(paperMap.keys());
    
    if (okxKeys.length !== paperKeys.length || !okxKeys.every(k => paperMap.has(k)) || !paperKeys.every(k => okxMap.has(k))) {
      sync_status = "KEY_MISMATCH";
      detail = "Paper ledger keys differ from OKX position keys (symbol/side)";
    } else {
      // Deep comparison for each key
      for (const [key, okxPos] of okxMap.entries()) {
        const paperPosData = paperMap.get(key)!;
        const paperPosQty = paperPosData.pos ?? (paperPosData.sizeUsd / (paperPosData.entryPrice || 1));
        const isAdoptedOrManaged = paperPosData.reconcileState === "ADOPTED" || paperPosData.lifecycleState === "CLOSE_ONLY_MANAGED";
        
        // 1. Size Mismatch (absolute quantity)
        if (Math.abs(Math.abs(okxPos.posSigned) - Math.abs(paperPosQty)) > 0.00000001) {
          sync_status = isAdoptedOrManaged ? "ADOPTED_POSITION_MANUAL_PARTIAL_DETECTED" : "MANUAL_PARTIAL_DETECTED";
          detail = `Size mismatch on ${key}: OKX=${Math.abs(okxPos.posSigned)}, Paper=${Math.abs(paperPosQty)}`;
          break;
        }

        // 2. Avg Price Mismatch
        const priceDiffRatio = Math.abs(okxPos.avgPx - paperPosData.entryPrice) / (paperPosData.entryPrice || 1);
        if (priceDiffRatio > PRICE_TOLERANCE_RATIO) {
          sync_status = isAdoptedOrManaged ? "AVG_PRICE_MISMATCH" : "AVG_PRICE_MISMATCH"; // Can refine if needed
          detail = `Price mismatch on ${key}: OKX=${okxPos.avgPx}, Paper=${paperPosData.entryPrice} (diff=${(priceDiffRatio * 100).toFixed(4)}%)`;
          break;
        }

        // 3. Notional Mismatch
        const notionalDiff = Math.abs(Math.abs(okxPos.notionalUsd) - Math.abs(paperPosData.sizeUsd));
        if (notionalDiff > NOTIONAL_TOLERANCE_USD) {
          sync_status = "NOTIONAL_MISMATCH";
          detail = `Notional mismatch on ${key}: OKX=${Math.abs(okxPos.notionalUsd)}, Paper=${Math.abs(paperPosData.sizeUsd)} (diff=${notionalDiff.toFixed(2)} USD)`;
          break;
        }
      }
    }
  }

  return {
    sync_status,
    okx_nonzero_position_count,
    paper_open_position_count,
    okx_positions_preview,
    paper_positions_preview,
    detail
  };
}
