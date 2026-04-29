import { createHmac } from "node:crypto";
import type { Candle, FundingRate, MarketSymbol, Ticker, Timeframe } from "../models/types";

export type OkxDemoOrderSide = "buy" | "sell";
export type OkxDemoPositionSide = "long" | "short";

export type OkxDemoClientConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  simulatedTradingHeaderEnabled?: boolean;
}>;

type OkxApiEnvelope<T> = Readonly<{
  code: string;
  msg: string;
  data: T[];
}>;

export type OkxOrderSubmitInput = Readonly<{
  instId: string;
  side: OkxDemoOrderSide;
  posSide: OkxDemoPositionSide;
  sz: string;
  tdMode?: "isolated" | "cross";
  ordType?: "market" | "limit";
  clOrdId?: string;
}>;

export type OkxPublicDiagnostics = Readonly<{
  httpStatus: number;
  requestUrl: string;
  retCode?: string;
  retMsg?: string;
}>;

export type TryResult<T> =
  | Readonly<{ ok: true; value: T; diagnostics: OkxPublicDiagnostics }>
  | Readonly<{ ok: false; error: string; diagnostics: OkxPublicDiagnostics }>;

function parseOptionalFiniteNumber(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

function selectUsdtDetail(details: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> | null {
  for (const d of details) {
    const ccy = String(d.ccy ?? "").toUpperCase();
    if (ccy === "USDT") return d;
  }
  return details.length > 0 ? details[0] : null;
}

function mustFiniteNumber(raw: unknown, ctx: string): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${ctx}: ${String(raw)}`);
  return n;
}

function timeframeToOkxBar(tf: Timeframe): string {
  switch (tf) {
    case "1m": return "1m";
    case "3m": return "3m";
    case "5m": return "5m";
    case "15m": return "15m";
    case "30m": return "30m";
    case "1h": return "1H";
    case "4h": return "4H";
    case "1d": return "1D";
    default: {
      const _exhaustive: never = tf;
      return _exhaustive;
    }
  }
}

export function toOkxSwapInstId(symbol: string): string {
  const x = String(symbol).trim().toUpperCase();
  if (x.endsWith("USDT")) {
    return `${x.slice(0, -4)}-USDT-SWAP`;
  }
  return `${x}-SWAP`;
}

export class OkxDemoClient {
  private readonly minRequestIntervalMs = 120;
  private nextRequestAtMs = 0;
  private readonly tickerCache = new Map<string, { expiresAt: number; value: TryResult<Ticker> }>();
  private readonly candleCache = new Map<string, { expiresAt: number; value: TryResult<Candle[]> }>();
  private readonly fundingCache = new Map<string, { expiresAt: number; value: TryResult<FundingRate> }>();

  constructor(private readonly cfg: OkxDemoClientConfig) {}

  private sign(ts: string, method: string, requestPath: string, body: string): string {
    const prehash = `${ts}${method}${requestPath}${body}`;
    return createHmac("sha256", this.cfg.apiSecret).update(prehash).digest("base64");
  }

  private async signedRequest<T>(
    method: "GET" | "POST",
    requestPath: string,
    query: URLSearchParams | null,
    body: Record<string, unknown> | null
  ): Promise<TryResult<T[]>> {
    const q = query && Array.from(query.keys()).length > 0 ? `?${query.toString()}` : "";
    const pathWithQuery = `${requestPath}${q}`;
    const bodyRaw = body ? JSON.stringify(body) : "";
    const ts = new Date().toISOString();
    const requestUrl = `${this.cfg.baseUrl}${pathWithQuery}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (this.cfg.simulatedTradingHeaderEnabled === true) {
      headers["x-simulated-trading"] = "1";
    }
    if (!this.cfg.apiKey) {
      return {
        ok: false,
        error: "apiKey_missing",
        diagnostics: { httpStatus: 0, requestUrl, retMsg: "No API key configured for signed request" }
      };
    }

    headers["OK-ACCESS-KEY"] = this.cfg.apiKey;
    headers["OK-ACCESS-SIGN"] = this.sign(ts, method, pathWithQuery, bodyRaw);
    headers["OK-ACCESS-TIMESTAMP"] = ts;
    headers["OK-ACCESS-PASSPHRASE"] = this.cfg.passphrase;

    try {
      await this.acquireRateLimitSlot();
      const res = await fetch(requestUrl, {
        method,
        headers,
        body: method === "POST" ? bodyRaw : undefined
      });

      const httpStatus = res.status;
      const text = await res.text();
      let json: any;
      try {
        json = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        return {
          ok: false,
          error: `invalid_json_http_${httpStatus}`,
          diagnostics: { httpStatus, requestUrl, retMsg: "Failed to parse JSON response" }
        };
      }

      const diagnostics: OkxPublicDiagnostics = {
        httpStatus,
        requestUrl,
        retCode: json?.code,
        retMsg: json?.msg
      };

      if (!res.ok) {
        return { ok: false, error: `okx_http_${httpStatus}:${json?.msg || "request_failed"}`, diagnostics };
      }
      if (json?.code !== "0") {
        return { ok: false, error: `okx_api_${json?.code}:${json?.msg || "request_failed"}`, diagnostics };
      }

      return { ok: true, value: json.data as T[], diagnostics };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: `signed_request_network_error: ${msg}`,
        diagnostics: { httpStatus: 0, requestUrl, retMsg: msg }
      };
    }
  }

  getAccountConfig(): Promise<TryResult<Record<string, unknown>[]>> {
    return this.signedRequest<Record<string, unknown>>("GET", "/api/v5/account/config", null, null);
  }

  getBalance(ccy?: string): Promise<TryResult<Record<string, unknown>[]>> {
    const q = new URLSearchParams();
    if (ccy) q.set("ccy", ccy);
    return this.signedRequest<Record<string, unknown>>("GET", "/api/v5/account/balance", q, null);
  }

  getPositions(instType = "SWAP"): Promise<TryResult<Record<string, unknown>[]>> {
    const q = new URLSearchParams();
    q.set("instType", instType);
    return this.signedRequest<Record<string, unknown>>("GET", "/api/v5/account/positions", q, null);
  }

  submitOrder(input: OkxOrderSubmitInput): Promise<TryResult<Record<string, unknown>[]>> {
    const payload = {
      instId: input.instId,
      tdMode: input.tdMode ?? "isolated",
      side: input.side,
      posSide: input.posSide,
      ordType: input.ordType ?? "market",
      sz: input.sz,
      ...(input.clOrdId ? { clOrdId: input.clOrdId } : {})
    };
    return this.signedRequest<Record<string, unknown>>("POST", "/api/v5/trade/order", null, payload);
  }

  getOrder(instId: string, ordId?: string, clOrdId?: string): Promise<TryResult<Record<string, unknown>[]>> {
    const q = new URLSearchParams();
    q.set("instId", instId);
    if (ordId) q.set("ordId", ordId);
    if (clOrdId) q.set("clOrdId", clOrdId);
    return this.signedRequest<Record<string, unknown>>("GET", "/api/v5/trade/order", q, null);
  }

  async checkSignedReady(): Promise<{
    configOk: boolean;
    balanceOk: boolean;
    positionsOk: boolean;
    walletBalanceUsdt: number | null;
    availableBalanceUsdt: number | null;
    diagnostics: Record<string, OkxPublicDiagnostics>;
  }> {
    const [cfg, bal, pos] = await Promise.all([
      this.getAccountConfig(),
      this.getBalance(),
      this.getPositions()
    ]);

    const balancePayload = bal.ok ? (bal.value?.[0] as Record<string, unknown> | undefined) : undefined;
    const details = Array.isArray(balancePayload?.details) ? (balancePayload!.details as Record<string, unknown>[]) : [];
    const selectedDetail = selectUsdtDetail(details);

    if (balancePayload) {
      const proof = {
        event: "OKX_CHECK_SIGNED_READY_BALANCE_PROOF",
        totalEq: balancePayload.totalEq,
        adjEq: balancePayload.adjEq,
        usdt_eq: selectedDetail?.eq,
        usdt_cashBal: selectedDetail?.cashBal,
        usdt_availBal: selectedDetail?.availBal,
        usdt_availEq: selectedDetail?.availEq,
        usdt_frozenBal: selectedDetail?.frozenBal,
        usdt_ordFrozen: selectedDetail?.ordFrozen,
      };
      console.info(JSON.stringify(proof));
    }

    const walletBalanceUsdt = (() => {
      const fromTotalEq = balancePayload ? parseOptionalFiniteNumber(balancePayload.totalEq) : null;
      if (fromTotalEq != null) return fromTotalEq;
      const fromEq = selectedDetail ? parseOptionalFiniteNumber(selectedDetail.eq) : null;
      if (fromEq != null) return fromEq;
      return null;
    })();

    const availableBalanceUsdt = (() => {
      if (selectedDetail) {
        const byAvailEq = parseOptionalFiniteNumber(selectedDetail.availEq);
        if (byAvailEq != null) return byAvailEq;
        const byAvailBal = parseOptionalFiniteNumber(selectedDetail.availBal);
        if (byAvailBal != null) return byAvailBal;
        const byEq = parseOptionalFiniteNumber(selectedDetail.eq);
        if (byEq != null) return byEq;
      }
      for (const d of details) {
        const byAvailEq = parseOptionalFiniteNumber(d.availEq);
        if (byAvailEq != null) return byAvailEq;
        const byAvailBal = parseOptionalFiniteNumber(d.availBal);
        if (byAvailBal != null) return byAvailBal;
      }
      return null;
    })();

    return {
      configOk: cfg.ok,
      balanceOk: bal.ok,
      positionsOk: pos.ok,
      walletBalanceUsdt,
      availableBalanceUsdt,
      diagnostics: {
        config: cfg.diagnostics,
        balance: bal.diagnostics,
        positions: pos.diagnostics
      }
    };
  }

  private async publicRequest<T>(
    method: "GET",
    requestPath: string,
    query: URLSearchParams | null
  ): Promise<{ success: boolean; json?: OkxApiEnvelope<T>; error?: string; diagnostics: OkxPublicDiagnostics }> {
    const q = query && Array.from(query.keys()).length > 0 ? `?${query.toString()}` : "";
    const pathWithQuery = `${requestPath}${q}`;
    const requestUrl = `${this.cfg.baseUrl}${pathWithQuery}`;
    
    let res: Response;
    try {
      await this.acquireRateLimitSlot();
      res = await fetch(requestUrl, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(this.cfg.simulatedTradingHeaderEnabled === true ? { "x-simulated-trading": "1" } : {})
        }
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

    const json = parsed as Partial<OkxApiEnvelope<T>> | null;
    const retCode = json?.code;
    const retMsg = json?.msg;
    const diagnostics: OkxPublicDiagnostics = { httpStatus, requestUrl, retCode, retMsg };

    if (!res.ok) {
      return { success: false, error: `HTTP ${httpStatus} ${res.statusText}`, diagnostics };
    }
    if (retCode !== "0") {
      return { success: false, error: `OKX code ${retCode} ${retMsg ?? ""}`.trim(), diagnostics };
    }

    return { success: true, json: parsed as OkxApiEnvelope<T>, diagnostics };
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
    const instId = toOkxSwapInstId(symbol);
    const cacheKey = `${instId}`;
    const hit = this.tickerCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const q = new URLSearchParams();
    q.set("instId", instId);
    const res = await this.publicRequest<Record<string, unknown>>("GET", "/api/v5/market/ticker", q);
    
    if (!res.success || !res.json) {
      return { ok: false, error: res.error || "unknown_error", diagnostics: res.diagnostics };
    }

    try {
      const item = res.json.data?.[0];
      if (!item) throw new Error(`OKX ticker empty result for ${instId}`);

      const fetchedAt = Date.now();
      const last = mustFiniteNumber(item.last, `${instId}.last`);
      const bid = item.bidPx ? mustFiniteNumber(item.bidPx, `${instId}.bidPx`) : undefined;
      const ask = item.askPx ? mustFiniteNumber(item.askPx, `${instId}.askPx`) : undefined;

      const out: TryResult<Ticker> = { ok: true, value: { symbol, ts: fetchedAt, last, bid, ask }, diagnostics: res.diagnostics };
      this.tickerCache.set(cacheKey, { expiresAt: Date.now() + 1000, value: out });
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg, diagnostics: res.diagnostics };
    }
  }

  async tryGetCandles(symbol: MarketSymbol, timeframe: Timeframe, limit = 200): Promise<TryResult<Candle[]>> {
    const instId = toOkxSwapInstId(symbol);
    const bar = timeframeToOkxBar(timeframe);
    const cacheKey = `${instId}:${bar}:${limit}`;
    const hit = this.candleCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const q = new URLSearchParams();
    q.set("instId", instId);
    q.set("bar", bar);
    q.set("limit", String(limit));
    const res = await this.publicRequest<unknown[]>("GET", "/api/v5/market/candles", q);

    if (!res.success || !res.json) {
      return { ok: false, error: res.error || "unknown_error", diagnostics: res.diagnostics };
    }

    try {
      const rows = res.json.data || [];
      const parsed: Candle[] = rows.map((r, idx) => {
        if (!Array.isArray(r) || r.length < 6) throw new Error(`Invalid kline row at ${instId}[${idx}]`);
        const ts = mustFiniteNumber(r[0], `${instId}.kline.ts`);
        const open = mustFiniteNumber(r[1], `${instId}.kline.open`);
        const high = mustFiniteNumber(r[2], `${instId}.kline.high`);
        const low = mustFiniteNumber(r[3], `${instId}.kline.low`);
        const close = mustFiniteNumber(r[4], `${instId}.kline.close`);
        const volume = mustFiniteNumber(r[5], `${instId}.kline.volume`);
        return { ts, open, high, low, close, volume };
      });
      // OKX returns newest first, so we reverse it to oldest first
      const out: TryResult<Candle[]> = { ok: true, value: parsed.reverse(), diagnostics: res.diagnostics };
      const ttlMs = timeframe === "1m" ? 2500 : timeframe === "3m" ? 4000 : timeframe === "5m" ? 7000 : 12000;
      this.candleCache.set(cacheKey, { expiresAt: Date.now() + ttlMs, value: out });
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg, diagnostics: res.diagnostics };
    }
  }

  async tryGetFundingRate(symbol: MarketSymbol): Promise<TryResult<FundingRate>> {
    const instId = toOkxSwapInstId(symbol);
    const cacheKey = `${instId}`;
    const hit = this.fundingCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const q = new URLSearchParams();
    q.set("instId", instId);
    const res = await this.publicRequest<Record<string, unknown>>("GET", "/api/v5/public/funding-rate", q);

    if (!res.success || !res.json) {
      return { ok: false, error: res.error || "unknown_error", diagnostics: res.diagnostics };
    }

    try {
      const item = res.json.data?.[0];
      const fetchedAt = Date.now();
      if (!item) {
        const out: TryResult<FundingRate> = { ok: true, value: { symbol, ts: fetchedAt, rate: 0 }, diagnostics: res.diagnostics };
        this.fundingCache.set(cacheKey, { expiresAt: Date.now() + 30000, value: out });
        return out;
      }

      const rate = mustFiniteNumber(item.fundingRate, `${instId}.fundingRate`);
      const tsRaw = item.fundingTime || item.nextFundingTime;
      const ts = tsRaw !== undefined ? mustFiniteNumber(tsRaw, `${instId}.fundingTime`) : fetchedAt;

      const out: TryResult<FundingRate> = { ok: true, value: { symbol, ts, rate }, diagnostics: res.diagnostics };
      this.fundingCache.set(cacheKey, { expiresAt: Date.now() + 30000, value: out });
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg, diagnostics: res.diagnostics };
    }
  }

  private async acquireRateLimitSlot(): Promise<void> {
    const now = Date.now();
    if (this.nextRequestAtMs > now) {
      await new Promise((resolve) => setTimeout(resolve, this.nextRequestAtMs - now));
    }
    this.nextRequestAtMs = Date.now() + this.minRequestIntervalMs;
  }
}
