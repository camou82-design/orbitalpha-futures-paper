import type { MarketSymbol, Ticker } from "../models/types";
import type { BybitPublicClient } from "../exchange/bybit-public";

export async function fetchTicker(client: BybitPublicClient, symbol: MarketSymbol): Promise<Ticker> {
  return await client.getTicker(symbol);
}

