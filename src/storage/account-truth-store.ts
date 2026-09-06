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

export interface OkxAccountTruthCursor {
  lastFillTime: number;
  lastTradeId?: string;
  syncedAt: number;
}

const ACCOUNT_TRUTH_DIR = "account-truth";
const CLOSED_TRADES_FILE = "okx-closed-trades.json";
const SYNC_CURSOR_FILE = "okx-sync-cursor.json";

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
