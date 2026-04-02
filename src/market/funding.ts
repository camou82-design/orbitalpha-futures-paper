import type { FundingRate, MarketSymbol } from "../models/types";
import type { BybitPublicClient } from "../exchange/bybit-public";

export async function fetchFundingRate(client: BybitPublicClient, symbol: MarketSymbol): Promise<FundingRate> {
  return await client.getFundingRate(symbol);
}

