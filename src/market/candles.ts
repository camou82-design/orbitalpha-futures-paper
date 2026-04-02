import type { Candle, MarketSymbol, Timeframe } from "../models/types";
import type { BybitPublicClient } from "../exchange/bybit-public";

export async function fetchCandles(
  client: BybitPublicClient,
  symbol: MarketSymbol,
  timeframe: Timeframe,
  limit = 200
): Promise<Candle[]> {
  return await client.getCandles(symbol, timeframe, limit);
}

