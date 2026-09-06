import type { OkxAccountClosedTradeRecord } from "../storage/account-truth-store";

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

export function toCanonicalSymbol(instId: string): string {
  const s = String(instId ?? "").trim().toUpperCase();
  if (s.endsWith("-SWAP")) {
    const base = s.slice(0, -5);
    return base.replace("-", "");
  }
  return s.replace("-", "");
}

export function isBotClOrdId(clOrdId?: string): boolean {
  if (!clOrdId || typeof clOrdId !== "string") return false;
  const c = clOrdId.trim();
  return c.startsWith("pBTCUSDT") || c.startsWith("pETHUSDT") || c.startsWith("pBTC-USDT") || c.startsWith("pETH-USDT");
}

export function isAlgoTriggerClOrdId(clOrdId?: string): boolean {
  if (!clOrdId || typeof clOrdId !== "string") return false;
  const c = clOrdId.trim();
  return /^O\d{10,}/.test(c);
}

interface PositionLeg {
  fill: OkxFillsHistoryItem;
  qty: number;
}

/**
 * Pure lifecycle reconstruction from raw OKX fills.
 * Groups by symbol, sorts chronologically, and converts fill streams into closed trade lifecycles.
 */
export function reconstructLifecyclesFromFills(
  rawFills: readonly OkxFillsHistoryItem[]
): OkxAccountClosedTradeRecord[] {
  if (!Array.isArray(rawFills) || rawFills.length === 0) return [];

  // Group fills by instrument symbol
  const bySymbol = new Map<string, OkxFillsHistoryItem[]>();
  for (const f of rawFills) {
    if (!f || !f.instId) continue;
    const sym = toCanonicalSymbol(f.instId);
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    bySymbol.get(sym)!.push(f);
  }

  const completedTrades: OkxAccountClosedTradeRecord[] = [];

  for (const [symbol, fills] of bySymbol.entries()) {
    // Sort chronologically ascending
    const sorted = [...fills].sort((a, b) => {
      const ta = Number(a.fillTime) || 0;
      const tb = Number(b.fillTime) || 0;
      if (ta !== tb) return ta - tb;
      return String(a.tradeId || a.ordId || "").localeCompare(String(b.tradeId || b.ordId || ""));
    });

    let currentQty = 0; // Positive for LONG, negative for SHORT, 0 for FLAT
    let openLegs: PositionLeg[] = [];
    let closeLegs: PositionLeg[] = [];

    const emitClosedLifecycle = (): void => {
      if (openLegs.length === 0 || closeLegs.length === 0) {
        openLegs = [];
        closeLegs = [];
        return;
      }

      const isLong = openLegs[0].fill.side === "buy";
      const side: "long" | "short" = isLong ? "long" : "short";

      const totalEntryQty = openLegs.reduce((sum, l) => sum + l.qty, 0);
      const totalCloseQty = closeLegs.reduce((sum, l) => sum + l.qty, 0);

      if (totalEntryQty <= 0 || totalCloseQty <= 0) {
        openLegs = [];
        closeLegs = [];
        return;
      }

      const entryPrice =
        openLegs.reduce((sum, l) => sum + l.qty * (Number(l.fill.fillPx) || 0), 0) / totalEntryQty;
      const closePrice =
        closeLegs.reduce((sum, l) => sum + l.qty * (Number(l.fill.fillPx) || 0), 0) / totalCloseQty;

      const openedAt = Number(openLegs[0].fill.fillTime) || Date.now();
      const closedAt = Number(closeLegs[closeLegs.length - 1].fill.fillTime) || openedAt;

      // Fee is sum of abs(fee) across all entry and exit legs
      let totalFee = 0;
      for (const l of [...openLegs, ...closeLegs]) {
        const feeVal = Math.abs(Number(l.fill.fee) || 0);
        totalFee += feeVal;
      }

      // Realized PnL: sum fillPnl from close legs if available
      let realizedPnl = 0;
      let hasExplicitPnl = false;
      for (const l of closeLegs) {
        if (l.fill.fillPnl != null && l.fill.fillPnl !== "") {
          realizedPnl += Number(l.fill.fillPnl) || 0;
          hasExplicitPnl = true;
        }
      }

      // Contract multiplier / size approximation for linear USDT swap
      // OKX USDT linear swap contract multiplier: BTC contract = 0.01 BTC, ETH contract = 0.1 ETH
      const ctMult = symbol.startsWith("BTC") ? 0.01 : symbol.startsWith("ETH") ? 0.1 : 1.0;
      const sizeUsd = entryPrice * totalCloseQty * ctMult;

      if (!hasExplicitPnl && entryPrice > 0) {
        const priceDiff = isLong ? closePrice - entryPrice : entryPrice - closePrice;
        realizedPnl = priceDiff * totalCloseQty * ctMult;
      }

      const pnlNet = realizedPnl - totalFee;
      const realizedPnlPct =
        entryPrice > 0
          ? isLong
            ? (closePrice - entryPrice) / entryPrice
            : (entryPrice - closePrice) / entryPrice
          : 0;

      const holdingMs = Math.max(0, closedAt - openedAt);

      const exchangeEntryOrdIds = Array.from(
        new Set(openLegs.map((l) => String(l.fill.ordId ?? "").trim()).filter((id) => id.length > 0))
      );
      const exchangeExitOrdIds = Array.from(
        new Set(closeLegs.map((l) => String(l.fill.ordId ?? "").trim()).filter((id) => id.length > 0))
      );
      const exchangeFillIds = Array.from(
        new Set(
          [...openLegs, ...closeLegs]
            .map((l) => String(l.fill.tradeId ?? "").trim())
            .filter((id) => id.length > 0)
        )
      );

      // Attribution & Ownership
      const isBotEntry = openLegs.some((l) => isBotClOrdId(l.fill.clOrdId));
      const hasAlgoExit = closeLegs.some((l) => isAlgoTriggerClOrdId(l.fill.clOrdId));
      const isBotExit = closeLegs.some((l) => isBotClOrdId(l.fill.clOrdId)) || (isBotEntry && hasAlgoExit);

      const isManualEntry = !isBotEntry;
      const isManualExit = !isBotExit;

      let sourceLabel = "거래소 체결";
      let tradeSource = "OKX_ACCOUNT_TRUTH";
      let exitReason = "거래소 청산";

      if (isBotEntry && isBotExit) {
        sourceLabel = "자동";
        tradeSource = "BOT_V2";
        exitReason = hasAlgoExit ? "보호 주문 체결 (TP/SL)" : "전략 자동 종료";
      } else if (isManualEntry && isManualExit) {
        sourceLabel = "수동";
        tradeSource = "MANUAL_EXTERNAL";
        exitReason = "수동 청산";
      } else if (isBotEntry && isManualExit) {
        sourceLabel = "자동→수동";
        tradeSource = "ADOPTED_EXTERNAL";
        exitReason = "수동 청산 (봇 진입)";
      } else if (isManualEntry && isBotExit) {
        sourceLabel = "수동→자동";
        tradeSource = "BOT_V2";
        exitReason = hasAlgoExit ? "보호 주문 체결 (TP/SL)" : "전략 자동 종료 (수동 진입)";
      }

      const positionCycleId = `${symbol}:${side}:${openedAt}`;
      const lifecycleId = `okx_life:${symbol}:${side}:${openedAt}:${closedAt}`;

      completedTrades.push({
        symbol,
        side,
        openedAt,
        closedAt,
        entryPrice,
        closePrice,
        entryQty: totalEntryQty,
        closedQty: totalCloseQty,
        sizeUsd,
        realizedPnl,
        realizedPnlPct,
        fee: totalFee,
        pnlNet,
        holdingMs,

        source: tradeSource,
        entrySource: isBotEntry ? "BOT" : "MANUAL",
        exitSource: isBotExit ? (hasAlgoExit ? "EXCHANGE_ALGO" : "BOT") : "MANUAL",
        sourceLabel,
        exitReason,
        exitType: hasAlgoExit ? "EXIT_EXCHANGE_ALGO" : isBotExit ? "EXIT_V2_AUTHORITY" : "EXIT_MANUAL",

        exchangeEntryOrdIds,
        exchangeExitOrdIds,
        exchangeFillIds,

        positionCycleId,
        lifecycleId,
        flowId: isBotEntry ? openLegs[0].fill.clOrdId : undefined,

        isManualEntry,
        isManualExit,
        isBotEntry,
        isBotExit,
        isAdoptedExternal: isBotEntry && isManualExit,
        isOperatorManaged: isManualEntry,

        isChildExecution: false,
        isPositionCycleFinal: true,
        accountTruth: true,
        tradeSource
      });

      openLegs = [];
      closeLegs = [];
    };

    for (const fill of sorted) {
      const fillQty = Number(fill.fillSz) || 0;
      if (fillQty <= 0) continue;

      const fillSigned = fill.side === "buy" ? fillQty : -fillQty;

      if (currentQty === 0) {
        // Case 1: Flat -> Open new lifecycle
        currentQty = fillSigned;
        openLegs = [{ fill, qty: fillQty }];
        closeLegs = [];
      } else if (Math.sign(currentQty) === Math.sign(fillSigned)) {
        // Case 2: Adding / Scaling in same direction
        currentQty += fillSigned;
        openLegs.push({ fill, qty: fillQty });
      } else {
        // Case 3: Reducing / Closing
        const currentAbs = Math.abs(currentQty);

        if (currentAbs > fillQty) {
          // Subcase 3A: Partial reduction (remaining > 0)
          closeLegs.push({ fill, qty: fillQty });
          currentQty += fillSigned;
        } else if (currentAbs === fillQty) {
          // Subcase 3B: Exact full close
          closeLegs.push({ fill, qty: fillQty });
          currentQty = 0;
          emitClosedLifecycle();
        } else {
          // Subcase 3C: Sign flip / Reversal (e.g. Long 0.8 -> Sell 1.2 => 0.8 close, 0.4 short open)
          const reducingQty = currentAbs;
          const overflowQty = fillQty - reducingQty;

          closeLegs.push({ fill, qty: reducingQty });
          currentQty = 0;
          emitClosedLifecycle();

          // Start new opposite lifecycle with remainder
          currentQty = fill.side === "buy" ? overflowQty : -overflowQty;
          openLegs = [{ fill, qty: overflowQty }];
          closeLegs = [];
        }
      }
    }
  }

  // Sort all reconstructed trades by closedAt descending
  return completedTrades.sort((a, b) => b.closedAt - a.closedAt);
}
