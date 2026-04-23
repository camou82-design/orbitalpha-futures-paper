import type { MarketSymbol, Ticker } from "../models/types";
import type { OkxDemoClient } from "../exchange/okx-demo";

export async function fetchTicker(client: OkxDemoClient, symbol: MarketSymbol): Promise<Ticker> {
  return await client.getTicker(symbol);
}

