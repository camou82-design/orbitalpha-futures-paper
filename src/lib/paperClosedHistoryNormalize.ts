import type { PaperCloseSource, PaperClosedPositionRecord, PaperExitType } from "../models/types";
import {
  defaultLabelForExitType,
  derivePaperCloseSource,
  finiteUsd,
  inferPaperCloseSourceFromExitType,
  outcomeStatusFromNetPnl,
  paperExitDisplayMeta
} from "../engine/paper-close-finalize";

const MISSING = "기록 없음";

const VALID_CLOSE_REASONS = new Set<string>([
  "candidate_lost",
  "take_profit",
  "stop_loss",
  "trailing_stop",
  "time_based_exit",
  "trend_break_exit",
  "regime_exit",
  "partial_exit_1",
  "partial_exit_2",
  "range_box_break",
  "range_profit_trail",
  "structural_regime_shift",
  "trend_switch"
]);

const VALID_EXIT_TYPES = new Set<PaperExitType>([
  "EXIT_SL",
  "EXIT_TP",
  "EXIT_TP_1",
  "EXIT_TP_2",
  "EXIT_PARTIAL_TP",
  "EXIT_TRAILING",
  "EXIT_TIME_STOP",
  "EXIT_TREND_BREAK",
  "EXIT_REGIME",
  "EXIT_REGIME_BREAK",
  "EXIT_SIGNAL_LOST",
  "EXIT_RANGE_REBALANCE",
  "EXIT_TREND_SWITCH",
  "EXIT_RISK",
  "EXIT_UNKNOWN"
]);

function isPaperCloseReason(x: unknown): x is PaperClosedPositionRecord["closeReason"] {
  return typeof x === "string" && VALID_CLOSE_REASONS.has(x);
}

function parseFinite(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "") {
    const n = parseFloat(String(x).replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseExitType(x: unknown, fallback: PaperExitType): PaperExitType {
  if (typeof x === "string" && VALID_EXIT_TYPES.has(x as PaperExitType)) return x as PaperExitType;
  return fallback;
}

function resolveCloseReasonText(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const t = val.trim();
  if (t === "" || t === MISSING) return null;

  if (isPaperCloseReason(t)) {
    const meta = paperExitDisplayMeta(t);
    return meta.closeReasonLabel !== MISSING ? meta.closeReasonLabel : null;
  }
  return t;
}

/** 번들·UI용: 디스크 `history.json` 한 행을 항상 표시 가능한 형태로 보강한다. */
export type NormalizedPaperClosedRow = Readonly<
  PaperClosedPositionRecord & {
    realizedPnlUsd: number;
    realizedPnlPct: number;
    exitReason: string;
    closeSource: PaperCloseSource;
    outcomeStatus: "win" | "loss" | "flat";
  }
>;

export function normalizeClosedHistoryRow(raw: unknown): NormalizedPaperClosedRow {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const pnlNet = parseFinite(o.pnlUsdNet) ?? parseFinite(o.pnlUsd) ?? parseFinite(o.realizedPnlUsd) ?? 0;
  const sizeUsd = finiteUsd(parseFinite(o.sizeUsd) ?? 0);
  const closedAt = parseFinite(o.closedAt) ?? 0;
  const entryPrice = parseFinite(o.entryPrice);
  const closePrice = parseFinite(o.closePrice) ?? parseFinite(o.exitPrice) ?? parseFinite(o.avgExitPrice) ?? 0;
  const leverage = parseFinite(o.leverage) ?? 1;
  const side = (typeof o.side === "string" ? o.side.toLowerCase() : "long") as "long" | "short";

  const crRaw = o.closeReason;
  const meta = isPaperCloseReason(crRaw)
    ? paperExitDisplayMeta(crRaw)
    : { exitType: "EXIT_UNKNOWN" as PaperExitType, closeReasonLabel: MISSING };

  const exitType = parseExitType(o.exitType, meta.exitType);

  const resolvedCloseReasonCandidate = resolveCloseReasonText(crRaw);

  /**
   * 종료 사유 우선순위 (B):
   * closeReasonLabel > exitReason > resolveCloseReasonText(closeReason) > exitType > closeSource
   */
  const mappedReasonLabel = (() => {
    const vals = [
      o.closeReasonLabel,
      o.exitReason,
      resolvedCloseReasonCandidate,
      defaultLabelForExitType(exitType),
      o.closeSource
    ];
    for (const v of vals) {
      if (typeof v === "string" && v.trim().length > 0 && v !== MISSING) return v.trim();
    }
    return exitType === "EXIT_UNKNOWN" ? "종료 사유 미기록 (EXIT_UNKNOWN)" : defaultLabelForExitType(exitType);
  })();

  const closeReasonLabel = mappedReasonLabel;
  const exitReason = mappedReasonLabel;

  let closeSource: PaperCloseSource = isPaperCloseReason(crRaw)
    ? derivePaperCloseSource(crRaw, exitType)
    : inferPaperCloseSourceFromExitType(exitType);
  if (closeSource === "UNKNOWN") {
    closeSource = inferPaperCloseSourceFromExitType(exitType);
  }

  /** 수익률 매핑 복구 (C): realizedPnlPct > (pnlNet/sizeUsd) > Calculation from price */
  let computedPnlPct: number | null = null;
  if (entryPrice && entryPrice > 0 && closePrice && closePrice > 0) {
    const move = side === "long" ? (closePrice - entryPrice) / entryPrice : (entryPrice - closePrice) / entryPrice;
    computedPnlPct = move * leverage;
  }

  const realizedPnlPct =
    parseFinite(o.realizedPnlPct) ??
    (sizeUsd > 0 && Number.isFinite(pnlNet) ? finiteUsd(pnlNet / sizeUsd) : (computedPnlPct ?? 0));

  const outcomeRaw = o.outcomeStatus;
  const outcomeStatus =
    outcomeRaw === "win" || outcomeRaw === "loss" || outcomeRaw === "flat"
      ? outcomeRaw
      : outcomeStatusFromNetPnl(pnlNet);

  const closeReasonForRecord: PaperClosedPositionRecord["closeReason"] = isPaperCloseReason(crRaw)
    ? crRaw
    : typeof crRaw === "string" && crRaw.length > 0
      ? (crRaw as PaperClosedPositionRecord["closeReason"])
      : "regime_exit";

  const pnlGross =
    parseFinite(o.pnlUsdGross) ??
    finiteUsd(pnlNet + (parseFinite(o.feeUsd) ?? 0) + (parseFinite(o.fundingUsd) ?? 0));

  const base = raw && typeof raw === "object" ? { ...(raw as object) } : {};

  const record: NormalizedPaperClosedRow = Object.assign(base, {
    closedAt,
    entryPrice: entryPrice ?? (base as any).entryPrice ?? 0,
    closePrice,
    pnlUsd: finiteUsd(pnlNet),
    pnlUsdNet: finiteUsd(pnlNet),
    pnlUsdGross: pnlGross,
    sizeUsd,
    closeReason: closeReasonForRecord,
    exitType,
    closeReasonLabel,
    exitReason,
    closeSource,
    realizedPnlUsd: finiteUsd(pnlNet),
    realizedPnlPct,
    outcomeStatus
  }) as NormalizedPaperClosedRow;

  // Proof Log (D)
  console.log("EXIT_HISTORY_MAPPING_PROOF", {
    symbol: String(o.symbol ?? "UNKNOWN"),
    closed_at: closedAt,
    raw_close_reason_label: o.closeReasonLabel ?? null,
    raw_exit_reason: o.exitReason ?? null,
    raw_close_reason: crRaw ?? null,
    resolved_close_reason_candidate: resolvedCloseReasonCandidate,
    raw_exit_type: o.exitType ?? null,
    raw_close_source: o.closeSource ?? null,
    mapped_exit_reason_label: mappedReasonLabel,
    raw_close_price: o.closePrice ?? null,
    mapped_close_price: closePrice,
    raw_realized_pnl_pct: o.realizedPnlPct ?? null,
    computed_realized_pnl_pct: computedPnlPct,
    mapped_realized_pnl_pct: realizedPnlPct,
    mapping_fallback_used: (closePrice === 0 && (o.closePrice == null)) || exitType === "EXIT_UNKNOWN"
  });

  return record;
}

export type ClosedRowDisplayFields = Readonly<{
  exitType: string;
  exitReason: string;
  status: string;
  closeSource: string;
  closePriceLabel: string;
  pnlPctLabel: string;
}>;

/** UI: "해당 없음" 대신 우선순위 fallback — 모두 비면 `기록 없음`. */
export function displayFieldsForClosedRow(row: unknown): ClosedRowDisplayFields {
  const o = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;

  // 만약 normalize를 거친 record라면 이미 강화된 필드들이 있을 것임.
  const nz = (...vals: unknown[]): string => {
    for (const x of vals) {
      if (typeof x === "string" && x.trim().length > 0 && x !== MISSING) return x.trim();
    }
    return MISSING;
  };

  const et = parseExitType(o.exitType, "EXIT_UNKNOWN");

  /** 우선순위 (C): exitReason > closeReasonLabel > resolveCloseReasonText(closeReason) > fallback */
  const exitReason = nz(
    o.exitReason,
    o.closeReasonLabel,
    resolveCloseReasonText(o.closeReason),
    et === "EXIT_UNKNOWN" ? "종료 사유 미기록 (EXIT_UNKNOWN)" : defaultLabelForExitType(et)
  );

  const st = o.outcomeStatus;
  const status =
    st === "win"
      ? "익"
      : st === "loss"
        ? "손"
        : st === "flat"
          ? "보합"
          : nz(
            o.positionStatus,
            (o as any).status
          );

  const closeSource = nz(
    o.closeSource,
    inferPaperCloseSourceFromExitType(et),
    "UNKNOWN"
  );

  const cp = parseFinite(o.closePrice);
  const closePriceLabel = cp !== null && cp > 0 ? cp.toLocaleString() : MISSING;

  const pct = parseFinite(o.realizedPnlPct);
  const pnlPctLabel = pct !== null ? `${(pct * 100).toFixed(2)}%` : MISSING;

  return {
    exitType: exitReason, // UI에서 exitType 자리에 reason을 표시하는 경우가 많음
    exitReason,
    status,
    closeSource,
    closePriceLabel,
    pnlPctLabel
  };
}


export function normalizePositionsHistoryArray(rows: unknown[]): NormalizedPaperClosedRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => normalizeClosedHistoryRow(r));
}
