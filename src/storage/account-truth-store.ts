import path from "node:path";
import fs from "node:fs/promises";

export interface OkxAccountClosedTradeRecord {
  symbol: string;
  side: "long" | "short";
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  closePrice: number;
  entryQty: number;
  closedQty: number;
  sizeUsd: number;
  realizedPnl: number;
  realizedPnlPct: number;
  fee: number;
  pnlNet: number;
  holdingMs: number;

  source: string;
  entrySource: string;
  exitSource: string;
  sourceLabel: string;
  exitReason: string;
  exitType: string;

  exchangeEntryOrdIds: string[];
  exchangeExitOrdIds: string[];
  exchangeFillIds: string[];

  positionCycleId?: string;
  lifecycleId: string;
  flowId?: string;

  isManualEntry: boolean;
  isManualExit: boolean;
  isBotEntry: boolean;
  isBotExit: boolean;
  isAdoptedExternal: boolean;
  isOperatorManaged: boolean;

  isChildExecution: false;
  isPositionCycleFinal: true;
  accountTruth: true;
  tradeSource: string;
}

export interface OkxFillsHistoryItem {
  instId: string;
  side: "buy" | "sell" | string;
  posSide?: string;
  fillPx: string | number;
  fillSz: string | number;
  fillPnl?: string | number;
  fee?: string | number;
  feeCcy?: string;
  fillTime: string | number;
  tradeId?: string;
  ordId?: string;
  clOrdId?: string;
  execType?: string;
}

export interface OkxAccountTruthCursor {
  lastFillTime: number;
  lastTradeId?: string;
  syncedAt: number;
}

const ACCOUNT_TRUTH_DIR = "account-truth";
const RAW_FILLS_FILE = "okx-raw-fills.json";
const CLOSED_TRADES_FILE = "okx-closed-trades.json";
const SYNC_CURSOR_FILE = "okx-sync-cursor.json";

export function okxRawFillDedupKey(fill: OkxFillsHistoryItem): string {
  const tradeId = typeof fill.tradeId === "string" ? fill.tradeId.trim() : "";
  if (tradeId.length > 0) return `tid:${tradeId}`;
  const instId = typeof fill.instId === "string" ? fill.instId.trim() : "";
  const ordId = typeof fill.ordId === "string" ? fill.ordId.trim() : "";
  const fillTime = String(fill.fillTime ?? "").trim();
  const side = String(fill.side ?? "").trim().toLowerCase();
  const fillSz = String(fill.fillSz ?? "").trim();
  const fillPx = String(fill.fillPx ?? "").trim();
  return `cmp:${instId}:${ordId}:${fillTime}:${side}:${fillSz}:${fillPx}`;
}

export function mergeAndDedupRawFills(
  existing: readonly OkxFillsHistoryItem[],
  incoming: readonly OkxFillsHistoryItem[]
): OkxFillsHistoryItem[] {
  const fillMap = new Map<string, OkxFillsHistoryItem>();
  for (const f of existing) {
    if (!f) continue;
    fillMap.set(okxRawFillDedupKey(f), f);
  }
  for (const f of incoming) {
    if (!f) continue;
    fillMap.set(okxRawFillDedupKey(f), f);
  }
  return Array.from(fillMap.values()).sort((a, b) => {
    const ta = Number(a.fillTime) || 0;
    const tb = Number(b.fillTime) || 0;
    if (ta !== tb) return ta - tb;
    return String(a.tradeId || a.ordId || "").localeCompare(String(b.tradeId || b.ordId || ""));
  });
}

export async function readOkxRawFills(dataDir: string): Promise<OkxFillsHistoryItem[]> {
  const p = path.join(dataDir, ACCOUNT_TRUTH_DIR, RAW_FILLS_FILE);
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as OkxFillsHistoryItem[]) : [];
  } catch {
    return [];
  }
}

export async function saveOkxRawFills(
  dataDir: string,
  fills: OkxFillsHistoryItem[]
): Promise<void> {
  const dir = path.join(dataDir, ACCOUNT_TRUTH_DIR);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, RAW_FILLS_FILE);
  const tempPath = `${p}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(fills, null, 2), "utf8");
  await fs.rename(tempPath, p);
}

export async function readOkxAccountClosedTrades(dataDir: string): Promise<OkxAccountClosedTradeRecord[]> {
  const p = path.join(dataDir, ACCOUNT_TRUTH_DIR, CLOSED_TRADES_FILE);
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as OkxAccountClosedTradeRecord[]) : [];
  } catch {
    return [];
  }
}

export async function saveOkxAccountClosedTrades(
  dataDir: string,
  trades: OkxAccountClosedTradeRecord[]
): Promise<void> {
  const dir = path.join(dataDir, ACCOUNT_TRUTH_DIR);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, CLOSED_TRADES_FILE);
  const tempPath = `${p}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(trades, null, 2), "utf8");
  await fs.rename(tempPath, p);
}

export async function readOkxAccountTruthCursor(dataDir: string): Promise<OkxAccountTruthCursor | null> {
  const p = path.join(dataDir, ACCOUNT_TRUTH_DIR, SYNC_CURSOR_FILE);
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as OkxAccountTruthCursor;
    return parsed && typeof parsed.lastFillTime === "number" ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveOkxAccountTruthCursor(
  dataDir: string,
  cursor: OkxAccountTruthCursor
): Promise<void> {
  const dir = path.join(dataDir, ACCOUNT_TRUTH_DIR);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, SYNC_CURSOR_FILE);
  const tempPath = `${p}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(cursor, null, 2), "utf8");
  await fs.rename(tempPath, p);
}
