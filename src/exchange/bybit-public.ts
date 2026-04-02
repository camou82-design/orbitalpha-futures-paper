import type { Candle, FundingRate, MarketSymbol, Ticker, Timeframe } from "../models/types";

export type BybitPublicClientOptions = Readonly<{
  baseUrl?: string; // default: https://api.bybit.com
}>;

/** One public GET call diagnostics (HTTP + Bybit envelope when present). */
export type BybitPublicDiagnostics = Readonly<{
  httpStatus: number;
  requestUrl: string;
  retCode?: number;
  retMsg?: string;
}>;

export type TryResult<T> =
  | Readonly<{ ok: true; value: T; diagnostics: BybitPublicDiagnostics }>
  | Readonly<{ ok: false; error: string; diagnostics: BybitPublicDiagnostics }>;

type BybitV5Response<T> = Readonly<{
  retCode: number;
  retMsg: string;
  time?: number;
  result?: T;
}>;

function mustFiniteNumber(raw: unknown, ctx: string): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${ctx}: ${String(raw)}`);
  return n;
}

function timeframeToBybitInterval(tf: Timeframe): string {
  switch (tf) {
    case "1m":
      return "1";
    case "3m":
      return "3";
    case "5m":
      return "5";
    case "15m":
      return "15";
    case "30m":
      return "30";
    case "1h":
      return "60";
    case "4h":
      return "240";
    case "1d":
      return "D";
    default: {
      const _exhaustive: never = tf;
      return _exhaustive;
    }
  }
}

type PublicGetOk<T> = Readonly<{ success: true; json: T; diagnostics: BybitPublicDiagnostics }>;
type PublicGetFail = Readonly<{ success: false; error: string; diagnostics: BybitPublicDiagnostics; json?: unknown }>;

export class BybitPublicClient {
  private readonly baseUrl: string;

  constructor(opts: BybitPublicClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.bybit.com").replace(/\/+$/, "");
  }

  async getTicker(symbol: MarketSymbol): Promise<Ticker> {
    const r = await this.tryGetTicker(symbol);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  }

  async getCandles(symbol: MarketSymbol, timeframe: Timeframe, limit = 200): Promise<Candle[]> {
    const r = await this.tryGetCandles(symbol, timeframe, limit);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  }

  async getFundingRate(symbol: MarketSymbol): Promise<FundingRate> {
    const r = await this.tryGetFundingRate(symbol);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  }

  async tryGetTicker(symbol: MarketSymbol): Promise<TryResult<Ticker>> {
    const path = "/v5/market/tickers";
    const query = { category: "linear", symbol };
    const gr = await this.publicGetResult<BybitV5Response<{ list: unknown[] }>>(path, query);
    if (!gr.success) return { ok: false, error: gr.error, diagnostics: gr.diagnostics };

    const json = gr.json;
    if (json.retCode !== 0) {
      return {
        ok: false,
        error: `Bybit ticker error: ${json.retCode} ${json.retMsg}`,
        diagnostics: gr.diagnostics
      };
    }

    try {
      const list = (json.result?.list ?? []) as any[];
      const item = list[0];
      if (!item) throw new Error(`Bybit ticker empty result for ${symbol}`);

      const fetchedAt = Date.now();
      const last = mustFiniteNumber(item.lastPrice, `${symbol}.lastPrice`);
      const bid = item.bid1Price !== undefined ? mustFiniteNumber(item.bid1Price, `${symbol}.bid1Price`) : undefined;
      const ask = item.ask1Price !== undefined ? mustFiniteNumber(item.ask1Price, `${symbol}.ask1Price`) : undefined;

      return { ok: true, value: { symbol, ts: fetchedAt, last, bid, ask }, diagnostics: gr.diagnostics };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg, diagnostics: gr.diagnostics };
    }
  }

  async tryGetCandles(symbol: MarketSymbol, timeframe: Timeframe, limit = 200): Promise<TryResult<Candle[]>> {
    const interval = timeframeToBybitInterval(timeframe);
    const path = "/v5/market/kline";
    const query = { category: "linear", symbol, interval, limit: String(limit) };
    const gr = await this.publicGetResult<BybitV5Response<{ list: unknown[] }>>(path, query);
    if (!gr.success) return { ok: false, error: gr.error, diagnostics: gr.diagnostics };

    const json = gr.json;
    if (json.retCode !== 0) {
      return {
        ok: false,
        error: `Bybit kline error: ${json.retCode} ${json.retMsg}`,
        diagnostics: gr.diagnostics
      };
    }

    try {
      const rows = (json.result?.list ?? []) as any[];
      const parsed: Candle[] = rows.map((r, idx) => {
        if (!Array.isArray(r) || r.length < 6) throw new Error(`Invalid kline row at ${symbol}[${idx}]`);
        const ts = mustFiniteNumber(r[0], `${symbol}.kline.ts`);
        const open = mustFiniteNumber(r[1], `${symbol}.kline.open`);
        const high = mustFiniteNumber(r[2], `${symbol}.kline.high`);
        const low = mustFiniteNumber(r[3], `${symbol}.kline.low`);
        const close = mustFiniteNumber(r[4], `${symbol}.kline.close`);
        const volume = mustFiniteNumber(r[5], `${symbol}.kline.volume`);
        return { ts, open, high, low, close, volume };
      });
      return { ok: true, value: parsed.reverse(), diagnostics: gr.diagnostics };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg, diagnostics: gr.diagnostics };
    }
  }

  async tryGetFundingRate(symbol: MarketSymbol): Promise<TryResult<FundingRate>> {
    const path = "/v5/market/funding/history";
    const query = { category: "linear", symbol, limit: "1" };
    const gr = await this.publicGetResult<BybitV5Response<{ list: unknown[] }>>(path, query);
    if (!gr.success) return { ok: false, error: gr.error, diagnostics: gr.diagnostics };

    const json = gr.json;
    if (json.retCode !== 0) {
      return {
        ok: false,
        error: `Bybit funding error: ${json.retCode} ${json.retMsg}`,
        diagnostics: gr.diagnostics
      };
    }

    try {
      const list = (json.result?.list ?? []) as any[];
      const item = list[0];
      const fetchedAt = Date.now();
      if (!item) return { ok: true, value: { symbol, ts: fetchedAt, rate: 0 }, diagnostics: gr.diagnostics };

      const rate = mustFiniteNumber(item.fundingRate, `${symbol}.fundingRate`);
      const tsRaw = item.fundingRateTimestamp ?? item.fundingRateTimestampMs ?? item.fundingTime;
      const ts = tsRaw !== undefined ? mustFiniteNumber(tsRaw, `${symbol}.fundingRateTimestamp`) : fetchedAt;

      return { ok: true, value: { symbol, ts, rate }, diagnostics: gr.diagnostics };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg, diagnostics: gr.diagnostics };
    }
  }

  /**
   * Public GET with full diagnostics. No auth / no private endpoints.
   */
  protected async publicGetResult<T>(path: string, query?: Record<string, string>): Promise<PublicGetOk<T> | PublicGetFail> {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const requestUrl = url.toString();

    let res: Response;
    try {
      res = await fetch(requestUrl, {
        method: "GET",
        headers: { Accept: "application/json" }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        success: false,
        error: `network: ${msg}`,
        diagnostics: { httpStatus: 0, requestUrl, retMsg: msg }
      };
    }

    const httpStatus = res.status;
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      return {
        success: false,
        error: `invalid JSON body (HTTP ${httpStatus})`,
        diagnostics: { httpStatus, requestUrl, retMsg: "json_parse_error" }
      };
    }

    const bybit = parsed as Partial<BybitV5Response<unknown>> | null;
    const retCode = typeof bybit?.retCode === "number" ? bybit.retCode : undefined;
    const retMsg = typeof bybit?.retMsg === "string" ? bybit.retMsg : undefined;
    const diagnostics: BybitPublicDiagnostics = { httpStatus, requestUrl, retCode, retMsg };

    if (!res.ok) {
      return {
        success: false,
        error: `HTTP ${httpStatus} ${res.statusText}`,
        diagnostics,
        json: parsed
      };
    }

    if (retCode !== undefined && retCode !== 0) {
      return {
        success: false,
        error: `Bybit retCode ${retCode} ${retMsg ?? ""}`.trim(),
        diagnostics,
        json: parsed
      };
    }

    return { success: true, json: parsed as T, diagnostics };
  }
}
