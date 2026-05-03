import type { MarketRegime } from "../strategy/market-regime-detector";
import { stopLossPctForRegime } from "../strategy/regime-exit";
import type { PaperOpenPositionRecord } from "../models/types";
import {
  buildLedgerOkxPositionSyncSnapshot,
  okxSwapRowToLedgerKey,
  type LedgerOkxPositionSyncSnapshot
} from "../exchange/okx-position-sync";

export type PositionOpsBanner =
  | "NO_POSITION"
  | "REMOTE_UNAVAILABLE"
  | "RECONCILE_MISMATCH"
  | "MONITORING_NO_PROTECT_WARNING"
  | "MONITORING_PROTECT_DETECTED"
  | "MONITORING_SCAN_PENDING";

export type PositionOpsRow = Readonly<{
  symbol: string;
  side: "long" | "short";
  inst_id: string;
  okx_avg_px: number | null;
  reference_entry_px: number | null;
  reference_source: "paper_ledger" | "okx_avgPx" | "none";
  regime_for_sl: MarketRegime;
  policy_sl_net_frac: number;
  initial_stop_px_engine_mirror: number | null;
  ledger_stop_px: number | null;
  reduce_only_protective_found: boolean;
  protective_match_hints: string[];
}>;

export type PositionOpsSurface = Readonly<{
  generated_at: number;
  orders_scan_performed: boolean;
  orders_scan_errors: string[];
  reconcile_sync_status: LedgerOkxPositionSyncSnapshot["sync_status"];
  surface_banner: PositionOpsBanner;
  surface_banner_ko: string;
  rows: PositionOpsRow[];
}>;

function toFinite(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

function regimeForSl(raw: unknown): MarketRegime {
  return raw === "RANGE" || raw === "TREND" || raw === "NO_TRADE" ? raw : "NO_TRADE";
}

/** Mirror engine STOP_BACKFILL / hard-SL gate: `stopLossPctForRegime` is negative pnl fraction; price stop uses same multiplicative shape as ledger backfill. */
export function engineMirrorStopPrice(entryPx: number, side: "long" | "short", regime: MarketRegime): number | null {
  if (!(entryPx > 0)) return null;
  const slPct = stopLossPctForRegime(regime);
  return side === "long" ? entryPx * (1 + slPct) : entryPx * (1 - slPct);
}

function instIdMatchesRow(instId: string, rowInst: string): boolean {
  return String(rowInst) === instId;
}

function stringifyHints(o: Record<string, unknown>): string {
  const id = o.algoId ?? o.ordId ?? "?";
  const typ = o.ordType ?? o.orderType ?? "?";
  const ro = o.reduceOnly;
  const trig = o.slTriggerPx ?? o.tpTriggerPx ?? o.triggerPx ?? "";
  return `${String(id)}|${String(typ)}|ro=${String(ro)}|tr=${String(trig)}`;
}

export function orderLooksReduceOnlyProtective(o: Record<string, unknown>): boolean {
  const ro = o.reduceOnly;
  const roOk = ro === true || String(ro).toLowerCase() === "true";
  if (!roOk) return false;
  const typ = String(o.ordType ?? o.orderType ?? "").toLowerCase();
  if (
    typ.includes("conditional") ||
    typ === "trigger" ||
    typ.includes("oco") ||
    typ.includes("move_order_stop")
  ) {
    return true;
  }
  if (o.slTriggerPx != null || o.tpTriggerPx != null || o.triggerPx != null) return true;
  return false;
}

export function findProtectiveHintsForInst(
  instId: string,
  pending: readonly Record<string, unknown>[],
  algos: readonly Record<string, unknown>[]
): { found: boolean; hints: string[] } {
  const hints: string[] = [];
  for (const o of algos) {
    if (!instIdMatchesRow(instId, String(o.instId ?? ""))) continue;
    if (orderLooksReduceOnlyProtective(o)) hints.push(`algo:${stringifyHints(o)}`);
  }
  for (const o of pending) {
    if (!instIdMatchesRow(instId, String(o.instId ?? ""))) continue;
    if (orderLooksReduceOnlyProtective(o)) hints.push(`pend:${stringifyHints(o)}`);
  }
  return { found: hints.length > 0, hints };
}

function matchLedgerRow(
  opens: ReadonlyArray<PaperOpenPositionRecord>,
  symbol: string,
  side: "long" | "short"
): PaperOpenPositionRecord | null {
  for (const p of opens) {
    if ((p.status ?? "open") !== "open") continue;
    if (p.lifecycleState === "FAILED") continue;
    if (String(p.symbol) !== symbol) continue;
    const ps = String(p.side).toLowerCase() === "short" ? "short" : "long";
    if (ps !== side) continue;
    return p;
  }
  return null;
}

function bannerKo(b: PositionOpsBanner): string {
  switch (b) {
    case "NO_POSITION":
      return "열린 스왑 포지션 없음";
    case "REMOTE_UNAVAILABLE":
      return "OKX 포지션 스냅샷 없음 · 감시 제한";
    case "RECONCILE_MISMATCH":
      return "리컨실 불일치 · 원장·거래소 대조 필요";
    case "MONITORING_NO_PROTECT_WARNING":
      return "감시 중 · 보호(reduce-only) 주문 없음";
    case "MONITORING_PROTECT_DETECTED":
      return "감시 중 · 보호 주문 확인됨";
    case "MONITORING_SCAN_PENDING":
      return "감시 중 · 보호 주문 스캔 대기";
    default:
      return b;
  }
}

export function buildPositionOpsSurface(input: Readonly<{
  now: number;
  paperOpens: ReadonlyArray<PaperOpenPositionRecord>;
  okxPayload: ReadonlyArray<Record<string, unknown>> | null | undefined;
  pendingOrders: ReadonlyArray<Record<string, unknown>> | null;
  algoOrders: ReadonlyArray<Record<string, unknown>> | null;
  ordersScanPerformed: boolean;
  ordersScanErrors: string[];
}>): PositionOpsSurface {
  const sync = buildLedgerOkxPositionSyncSnapshot(input.paperOpens, input.okxPayload);
  const pending = input.pendingOrders ?? [];
  const algos = input.algoOrders ?? [];

  const rows: PositionOpsRow[] = [];
  const payload = input.okxPayload;
  if (payload && Array.isArray(payload)) {
    for (const raw of payload) {
      const hit = okxSwapRowToLedgerKey(raw as Record<string, unknown>);
      if (!hit) continue;
      const avgPx = toFinite((raw as Record<string, unknown>).avgPx);
      const ledger = matchLedgerRow(input.paperOpens, hit.symbol, hit.side);
      const refPx = ledger?.entryPrice && ledger.entryPrice > 0 ? ledger.entryPrice : avgPx;
      const refSrc: PositionOpsRow["reference_source"] = ledger ? "paper_ledger" : avgPx != null ? "okx_avgPx" : "none";
      const regime = regimeForSl(ledger?.regimeAtEntry);
      const slNet = stopLossPctForRegime(regime);
      const stopPx = refPx != null && refPx > 0 ? engineMirrorStopPrice(refPx, hit.side, regime) : null;
      const { found, hints } = findProtectiveHintsForInst(hit.instId, pending, algos);
      rows.push({
        symbol: hit.symbol,
        side: hit.side,
        inst_id: hit.instId,
        okx_avg_px: avgPx,
        reference_entry_px: refPx,
        reference_source: refSrc,
        regime_for_sl: regime,
        policy_sl_net_frac: slNet,
        initial_stop_px_engine_mirror: stopPx,
        ledger_stop_px: typeof ledger?.stopPrice === "number" && Number.isFinite(ledger.stopPrice) ? ledger.stopPrice : null,
        reduce_only_protective_found: found,
        protective_match_hints: hints
      });
    }
  }

  let surface_banner: PositionOpsBanner;
  if (sync.sync_status === "REMOTE_UNAVAILABLE") {
    if (sync.paper_open_position_count === 0 && sync.okx_nonzero_position_count === 0) {
      surface_banner = "NO_POSITION";
    } else {
      surface_banner = "REMOTE_UNAVAILABLE";
    }
  } else if (sync.sync_status !== "ALIGNED") {
    surface_banner = "RECONCILE_MISMATCH";
  } else if (rows.length === 0) {
    surface_banner = "NO_POSITION";
  } else if (!input.ordersScanPerformed) {
    surface_banner = "MONITORING_SCAN_PENDING";
  } else {
    const anyMissing = rows.some((r) => !r.reduce_only_protective_found);
    surface_banner = anyMissing ? "MONITORING_NO_PROTECT_WARNING" : "MONITORING_PROTECT_DETECTED";
  }

  return {
    generated_at: input.now,
    orders_scan_performed: input.ordersScanPerformed,
    orders_scan_errors: [...input.ordersScanErrors],
    reconcile_sync_status: sync.sync_status,
    surface_banner,
    surface_banner_ko: bannerKo(surface_banner),
    rows
  };
}
