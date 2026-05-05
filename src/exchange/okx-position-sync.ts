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
    | "ADOPTED_POSITION_MANUAL_PARTIAL_DETECTED"
    | "EXTERNAL_MANUAL_MISMATCH_IGNORED";
  okx_nonzero_position_count: number;
  paper_open_position_count: number;
  mismatched_keys: string[];
  ignored_external_manual_keys: string[];
  okx_positions_preview: ReadonlyArray<{
    symbol: string;
    side: "long" | "short";
    instId: string;
    /** OKX SWAP `pos`: signed contract count magnitude (not base coin). */
    okxContracts: number;
    avgPx: number;
    notionalUsd: number;
    baseQty?: number;
    /** @deprecated Prefer okxContracts — legacy dashboards. */
    pos: number;
  }>;
  paper_positions_preview: ReadonlyArray<{
    symbol: string;
    side: "long" | "short";
    okxContracts?: number;
    baseQty: number;
    notionalUsd: number;
    entryPrice: number;
    sizeUsd: number;
    reconcileState?: string;
    /** @deprecated Legacy alias for base coin qty — equals baseQty. */
    pos: number;
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

export type InstrumentSizing = {
  ctVal: number;
  ctValCcy: string;
};

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
    okxContracts?: number;
    baseQty?: number;
    notionalUsd?: number;
    avgPx?: number;
  }>,
  okxPayload: ReadonlyArray<Record<string, unknown>> | null | undefined,
  instrumentMap?: Map<string, InstrumentSizing>
): LedgerOkxPositionSyncSnapshot {
  const paperMap = new Map<string, typeof paperOpens[0]>();
  const paper_positions_preview: Array<LedgerOkxPositionSyncSnapshot["paper_positions_preview"][number]> = [];

  for (const p of paperOpens) {
    if ((p.status ?? "open") !== "open") continue;
    if (p.lifecycleState === "FAILED") continue;
    const side: "long" | "short" = String(p.side).toLowerCase() === "short" ? "short" : "long";
    const key = `${String(p.symbol)}:${side}`;
    paperMap.set(key, p);

    const paperBaseQty =
      typeof p.baseQty === "number" && Number.isFinite(p.baseQty) && p.baseQty > 0
        ? p.baseQty
        : p.sizeUsd / Math.max(1e-12, p.entryPrice || 1);
    const paperNotional =
      typeof p.notionalUsd === "number" && Number.isFinite(p.notionalUsd) ? p.notionalUsd : p.sizeUsd;

    paper_positions_preview.push({
      symbol: String(p.symbol),
      side,
      okxContracts: typeof p.okxContracts === "number" && Number.isFinite(p.okxContracts) ? p.okxContracts : undefined,
      baseQty: paperBaseQty,
      notionalUsd: paperNotional,
      entryPrice: p.entryPrice,
      sizeUsd: p.sizeUsd,
      reconcileState: p.reconcileState,
      pos: paperBaseQty
    });
  }

  const paper_open_position_count = paperMap.size;

  if (!okxPayload || !Array.isArray(okxPayload)) {
    return {
      sync_status: "REMOTE_UNAVAILABLE",
      okx_nonzero_position_count: 0,
      paper_open_position_count,
      mismatched_keys: [],
      ignored_external_manual_keys: [],
      okx_positions_preview: [],
      paper_positions_preview,
      detail: "OKX positions payload unavailable for sync comparison"
    };
  }

  const okx_positions_preview: Array<{
    symbol: string;
    side: "long" | "short";
    instId: string;
    okxContracts: number;
    avgPx: number;
    notionalUsd: number;
    baseQty?: number;
    pos: number;
  }> = [];
  const okxMap = new Map<string, OkxSwapLedgerKeyParts & { baseQty?: number; okxContracts: number; notionalUsd: number }>();

  for (const row of okxPayload) {
    const hit = okxSwapRowToLedgerKey(row as Record<string, unknown>);
    if (!hit) continue;

    const inst = instrumentMap?.get(hit.instId);
    const contractsAbs = Math.abs(hit.posSigned);
    const baseQty = inst ? contractsAbs * inst.ctVal : undefined;
    let nu = hit.notionalUsd;
    if ((!Number.isFinite(nu) || nu === 0) && inst && hit.avgPx > 0 && baseQty !== undefined) {
      nu = baseQty * hit.avgPx;
    }

    const enriched = { ...hit, notionalUsd: nu, baseQty, okxContracts: contractsAbs };
    okxMap.set(hit.key, enriched);
    okx_positions_preview.push({
      symbol: hit.symbol,
      side: hit.side,
      instId: hit.instId,
      okxContracts: contractsAbs,
      avgPx: hit.avgPx,
      notionalUsd: nu,
      baseQty,
      pos: contractsAbs
    });
  }

  const okx_nonzero_position_count = okxMap.size;

  let sync_status: LedgerOkxPositionSyncSnapshot["sync_status"] = "ALIGNED";
  let detail: string | null = null;
  const mismatched_keys: string[] = [];
  const ignored_external_manual_keys: string[] = [];

  if (okx_nonzero_position_count === 0 && paper_open_position_count === 0) {
    sync_status = "ALIGNED";
  } else if (okx_nonzero_position_count > 0 && paper_open_position_count === 0) {
    sync_status = "OKX_ONLY";
    detail = "Exchange reports open SWAP positions but paper ledger has no active rows";
    for (const k of okxMap.keys()) mismatched_keys.push(k);
  } else if (okx_nonzero_position_count === 0 && paper_open_position_count > 0) {
    sync_status = "MANUAL_FULL_CLOSE_DETECTED";
    detail = "Paper ledger lists open positions but OKX SWAP snapshot shows none (Manual full close suspected)";
    for (const k of paperMap.keys()) mismatched_keys.push(k);
  } else {
    // Key-level comparison
    const okxKeys = Array.from(okxMap.keys());
    const paperKeys = Array.from(paperMap.keys());
    
    const onlyOkx = okxKeys.filter(k => !paperMap.has(k));
    const onlyPaper = paperKeys.filter(k => !okxMap.has(k));

    if (onlyOkx.length > 0 || onlyPaper.length > 0) {
      sync_status = "KEY_MISMATCH";
      detail = "Paper ledger keys differ from OKX position keys (symbol/side)";
      for (const k of onlyOkx) mismatched_keys.push(k);
      for (const k of onlyPaper) mismatched_keys.push(k);
    } 

    // Deep comparison for each key (even if key mismatch, we want to check others)
    for (const [key, okxPos] of okxMap.entries()) {
      const paperPosData = paperMap.get(key);
      if (!paperPosData) continue;

      const isAdoptedOrManaged = paperPosData.reconcileState === "ADOPTED" || paperPosData.lifecycleState === "CLOSE_ONLY_MANAGED";
      const isExternalManual = paperPosData.lifecycleState === "EXTERNAL_MANUAL_POSITION";

      const paperNotional =
        typeof paperPosData.notionalUsd === "number" && Number.isFinite(paperPosData.notionalUsd)
          ? paperPosData.notionalUsd
          : paperPosData.sizeUsd;

      let mismatchAtThisKey = false;

      // 1. Avg price (primary)
      const priceDiffRatio = Math.abs(okxPos.avgPx - paperPosData.entryPrice) / (paperPosData.entryPrice || 1);
      if (priceDiffRatio > PRICE_TOLERANCE_RATIO) {
        if (sync_status === "ALIGNED" || sync_status === "KEY_MISMATCH") {
           // Only promote to global status if NOT external manual
           if (!isExternalManual) sync_status = "AVG_PRICE_MISMATCH";
        }
        detail = detail || `Price mismatch on ${key}: OKX=${okxPos.avgPx}, Paper=${paperPosData.entryPrice} (diff=${(priceDiffRatio * 100).toFixed(4)}%)`;
        mismatchAtThisKey = true;
      }

      // 2. Notional USD (primary)
      const notionalDiff = Math.abs(Math.abs(okxPos.notionalUsd) - Math.abs(paperNotional));
      if (notionalDiff > NOTIONAL_TOLERANCE_USD) {
        if (sync_status === "ALIGNED" || sync_status === "KEY_MISMATCH" || sync_status === "AVG_PRICE_MISMATCH") {
           if (!isExternalManual) sync_status = "NOTIONAL_MISMATCH";
        }
        detail = detail || `Notional mismatch on ${key}: OKX=${Math.abs(okxPos.notionalUsd)}, Paper=${Math.abs(paperNotional)} (diff=${notionalDiff.toFixed(2)} USD)`;
        mismatchAtThisKey = true;
      }

      // 3. Base-coin audit
      const okxBaseQty = okxPos.baseQty;
      const paperBaseLedger = paperPosData.baseQty;
      const hasExplicitPaperBase =
        typeof paperBaseLedger === "number" && Number.isFinite(paperBaseLedger) && paperBaseLedger > 0;
      if (
        okxBaseQty !== undefined &&
        hasExplicitPaperBase &&
        Math.abs(okxBaseQty - paperBaseLedger) > Math.max(1e-8, 0.002 * Math.max(okxBaseQty, paperBaseLedger))
      ) {
        if (sync_status === "ALIGNED" || sync_status === "KEY_MISMATCH" || sync_status === "AVG_PRICE_MISMATCH" || sync_status === "NOTIONAL_MISMATCH") {
           if (!isExternalManual) {
             sync_status = isAdoptedOrManaged ? "ADOPTED_POSITION_MANUAL_PARTIAL_DETECTED" : "MANUAL_PARTIAL_DETECTED";
           }
        }
        detail = detail || `Base quantity mismatch on ${key}: OKX=${okxBaseQty.toFixed(8)}, Paper=${paperBaseLedger.toFixed(8)}`;
        mismatchAtThisKey = true;
      }

      if (mismatchAtThisKey) {
        if (!mismatched_keys.includes(key)) mismatched_keys.push(key);
        if (isExternalManual) {
          if (!ignored_external_manual_keys.includes(key)) ignored_external_manual_keys.push(key);
        }
      }
    }

    // Final status resolution: if we have mismatches but they are ALL external manual, 
    // use the specific IGNORED status instead of ALIGNED or error statuses.
    const nonManualMismatches = mismatched_keys.filter(k => !ignored_external_manual_keys.includes(k));
    if (mismatched_keys.length > 0 && nonManualMismatches.length === 0) {
      sync_status = "EXTERNAL_MANUAL_MISMATCH_IGNORED";
      detail = "Mismatch exists only on EXTERNAL_MANUAL_POSITION keys and was ignored for global readiness.";
    }
  }

  return {
    sync_status,
    okx_nonzero_position_count,
    paper_open_position_count,
    mismatched_keys,
    ignored_external_manual_keys,
    okx_positions_preview,
    paper_positions_preview,
    detail
  };
}

