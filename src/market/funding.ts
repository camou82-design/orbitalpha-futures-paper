import type { FundingRate, MarketSymbol } from "../models/types";
import type { OkxDemoClient } from "../exchange/okx-demo";

export async function fetchFundingRate(client: OkxDemoClient, symbol: MarketSymbol): Promise<FundingRate> {
  return await client.getFundingRate(symbol);
}

