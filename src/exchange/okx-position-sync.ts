/**
 * Normalize OKX `/api/v5/account/positions` SWAP rows for hedge (`long`/`short`) and net (`net`/empty posSide) modes.
 */

export type OkxSwapLedgerKeyParts = Readonly<{
  /** Paper ledger style e.g. `BTCUSDT:short` */
  key: string;
  symbol: string;
  side: "long" | "short";
  posSigned: number;
  instId: string;
}>;

export type LedgerOkxPositionSyncSnapshot = Readonly<{
  sync_status: "ALIGNED" | "OKX_ONLY" | "LEDGER_ONLY" | "KEY_MISMATCH" | "REMOTE_UNAVAILABLE";
  okx_nonzero_position_count: number;
  paper_open_position_count: number;
  okx_positions_preview: ReadonlyArray<{
    symbol: string;
    side: "long" | "short";
    instId: string;
    pos: number;
  }>;
  paper_positions_preview: ReadonlyArray<{ symbol: string; side: "long" | "short" }>;
  detail: string | null;
}>;

export function okxSwapRowToLedgerKey(row: Record<string, unknown>): OkxSwapLedgerKeyParts | null {
  const instId = String(row.instId ?? "");
  const posRaw = row.pos;
  const posNum = typeof posRaw === "number" ? posRaw : typeof posRaw === "string" ? Number(posRaw) : NaN;
  if (!Number.isFinite(posNum) || Math.abs(posNum) <= 0) return null;

  const posSideRaw = String(row.posSide ?? "").trim().toLowerCase();
  let side: "long" | "short";
  if (posSideRaw === "short") side = "short";
  else if (posSideRaw === "long") side = "long";
  else {
    side = posNum < 0 ? "short" : "long";
  }

  const symbol = instId.endsWith("-USDT-SWAP") ? `${instId.slice(0, -"-USDT-SWAP".length)}USDT` : instId;
  return { key: `${symbol}:${side}`, symbol, side, posSigned: posNum, instId };
}

export function paperOpensToActiveLedgerKeys(
  opens: ReadonlyArray<{ symbol: string; side: string; status?: string; lifecycleState?: string }>
): Set<string> {
  const s = new Set<string>();
  for (const p of opens) {
    if ((p.status ?? "open") !== "open") continue;
    if (p.lifecycleState === "FAILED") continue;
    const side = String(p.side).toLowerCase() === "short" ? "short" : "long";
    s.add(`${String(p.symbol)}:${side}`);
  }
  return s;
}

export function buildLedgerOkxPositionSyncSnapshot(
  paperOpens: ReadonlyArray<{ symbol: string; side: string; status?: string; lifecycleState?: string }>,
  okxPayload: ReadonlyArray<Record<string, unknown>> | null | undefined
): LedgerOkxPositionSyncSnapshot {
  const ledgerKeys = paperOpensToActiveLedgerKeys(paperOpens);
  const paper_positions_preview: Array<{ symbol: string; side: "long" | "short" }> = [...ledgerKeys].map((key) => {
    const [symbol, sideToken] = key.split(":");
    const side: "long" | "short" = sideToken === "short" ? "short" : "long";
    return { symbol: String(symbol), side };
  });

  if (!okxPayload || !Array.isArray(okxPayload)) {
    return {
      sync_status: "REMOTE_UNAVAILABLE",
      okx_nonzero_position_count: 0,
      paper_open_position_count: ledgerKeys.size,
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
  }> = [];
  const okxKeys = new Set<string>();
  for (const row of okxPayload) {
    const hit = okxSwapRowToLedgerKey(row as Record<string, unknown>);
    if (!hit) continue;
    okxKeys.add(hit.key);
    okx_positions_preview.push({
      symbol: hit.symbol,
      side: hit.side,
      instId: hit.instId,
      pos: hit.posSigned
    });
  }

  const okx_nonzero_position_count = okx_positions_preview.length;
  const paper_open_position_count = ledgerKeys.size;

  let sync_status: LedgerOkxPositionSyncSnapshot["sync_status"];
  let detail: string | null = null;

  if (okx_nonzero_position_count === 0 && paper_open_position_count === 0) {
    sync_status = "ALIGNED";
  } else if (
    okx_nonzero_position_count === paper_open_position_count &&
    [...okxKeys].every((k) => ledgerKeys.has(k)) &&
    [...ledgerKeys].every((k) => okxKeys.has(k))
  ) {
    sync_status = "ALIGNED";
  } else if (okx_nonzero_position_count > 0 && paper_open_position_count === 0) {
    sync_status = "OKX_ONLY";
    detail = "Exchange reports open SWAP positions but paper ledger has no active rows";
  } else if (okx_nonzero_position_count === 0 && paper_open_position_count > 0) {
    sync_status = "LEDGER_ONLY";
    detail = "Paper ledger lists open positions but OKX SWAP snapshot shows none";
  } else {
    sync_status = "KEY_MISMATCH";
    detail = "Paper ledger keys differ from OKX position keys (symbol/side)";
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
