import type { Candle, MarketSymbol, Timeframe } from "../models/types";
import type { OkxDemoClient } from "../exchange/okx-demo";

export async function fetchCandles(
  client: OkxDemoClient,
  symbol: MarketSymbol,
  timeframe: Timeframe,
  limit = 200
): Promise<Candle[]> {
  return await client.getCandles(symbol, timeframe, limit);
}

