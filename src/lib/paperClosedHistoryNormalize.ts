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

  const crRaw = o.closeReason;
  const meta = isPaperCloseReason(crRaw)
    ? paperExitDisplayMeta(crRaw)
    : { exitType: "EXIT_UNKNOWN" as PaperExitType, closeReasonLabel: MISSING };

  const exitType = parseExitType(o.exitType, meta.exitType);

  let closeSource: PaperCloseSource = isPaperCloseReason(crRaw)
    ? derivePaperCloseSource(crRaw, exitType)
    : inferPaperCloseSourceFromExitType(exitType);
  if (closeSource === "UNKNOWN") {
    closeSource = inferPaperCloseSourceFromExitType(exitType);
  }

  const closeReasonLabel =
    typeof o.closeReasonLabel === "string" && o.closeReasonLabel.trim().length > 0
      ? String(o.closeReasonLabel).trim()
      : meta.closeReasonLabel !== MISSING
        ? meta.closeReasonLabel
        : defaultLabelForExitType(exitType);

  const exitReason =
    typeof o.exitReason === "string" && o.exitReason.trim().length > 0
      ? String(o.exitReason).trim()
      : closeReasonLabel;

  const realizedPnlPct =
    parseFinite(o.realizedPnlPct) ??
    (sizeUsd > 0 && Number.isFinite(pnlNet) ? finiteUsd(pnlNet / sizeUsd) : 0);

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

  return Object.assign(base, {
    closedAt,
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
}

export type ClosedRowDisplayFields = Readonly<{
  exitType: string;
  exitReason: string;
  status: string;
  closeSource: string;
}>;

/** UI: "해당 없음" 대신 우선순위 fallback — 모두 비면 `기록 없음`. */
export function displayFieldsForClosedRow(row: unknown): ClosedRowDisplayFields {
  const o = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
  const nz = (...vals: unknown[]): string => {
    for (const x of vals) {
      if (typeof x === "string" && x.trim().length > 0) return x.trim();
    }
    return MISSING;
  };

  const et = parseExitType(o.exitType, "EXIT_UNKNOWN");

  const exitType = nz(
    typeof o.exitType === "string" ? o.exitType : null,
    defaultLabelForExitType(et),
    o.closeReasonLabel,
    typeof o.closeReason === "string" ? o.closeReason : null
  );

  const exitReason = nz(
    o.exitReason,
    o.closeReasonLabel,
    typeof o.closeReason === "string" ? o.closeReason : null,
    defaultLabelForExitType(et)
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
              typeof o.positionStatus === "string" ? o.positionStatus : null,
              typeof (o as { status?: string }).status === "string" ? (o as { status?: string }).status : null
            );

  const closeSource = nz(
    typeof o.closeSource === "string" ? o.closeSource : null,
    inferPaperCloseSourceFromExitType(et),
    defaultLabelForExitType(et)
  );

  return {
    exitType,
    exitReason,
    status,
    closeSource
  };
}

export function normalizePositionsHistoryArray(rows: unknown[]): NormalizedPaperClosedRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => normalizeClosedHistoryRow(r));
}
