import { createHmac } from "node:crypto";

type OkxDemoOrderSide = "buy" | "sell";
type OkxDemoPositionSide = "long" | "short";

export type OkxDemoClientConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  passphrase: string;
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

export class OkxDemoClient {
  constructor(private readonly cfg: OkxDemoClientConfig) {}

  private sign(ts: string, method: string, requestPath: string, body: string): string {
    const prehash = `${ts}${method}${requestPath}${body}`;
    return createHmac("sha256", this.cfg.apiSecret).update(prehash).digest("base64");
  }

  private async request<T>(
    method: "GET" | "POST",
    requestPath: string,
    query: URLSearchParams | null,
    body: Record<string, unknown> | null
  ): Promise<OkxApiEnvelope<T>> {
    const q = query && Array.from(query.keys()).length > 0 ? `?${query.toString()}` : "";
    const pathWithQuery = `${requestPath}${q}`;
    const bodyRaw = body ? JSON.stringify(body) : "";
    const ts = new Date().toISOString();
    const sign = this.sign(ts, method, pathWithQuery, bodyRaw);
    const url = `${this.cfg.baseUrl}${pathWithQuery}`;
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": this.cfg.apiKey,
        "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": ts,
        "OK-ACCESS-PASSPHRASE": this.cfg.passphrase,
        "x-simulated-trading": "1"
      },
      body: method === "POST" ? bodyRaw : undefined
    });
    const json = (await res.json()) as OkxApiEnvelope<T>;
    if (!res.ok) {
      throw new Error(`okx_http_${res.status}:${json.msg || "request_failed"}`);
    }
    if (json.code !== "0") {
      throw new Error(`okx_api_${json.code}:${json.msg || "request_failed"}`);
    }
    return json;
  }

  getAccountConfig(): Promise<OkxApiEnvelope<Record<string, unknown>>> {
    return this.request<Record<string, unknown>>("GET", "/api/v5/account/config", null, null);
  }

  getBalance(ccy?: string): Promise<OkxApiEnvelope<Record<string, unknown>>> {
    const q = new URLSearchParams();
    if (ccy) q.set("ccy", ccy);
    return this.request<Record<string, unknown>>("GET", "/api/v5/account/balance", q, null);
  }

  getPositions(instType = "SWAP"): Promise<OkxApiEnvelope<Record<string, unknown>>> {
    const q = new URLSearchParams();
    q.set("instType", instType);
    return this.request<Record<string, unknown>>("GET", "/api/v5/account/positions", q, null);
  }

  submitOrder(input: OkxOrderSubmitInput): Promise<OkxApiEnvelope<Record<string, unknown>>> {
    const payload = {
      instId: input.instId,
      tdMode: input.tdMode ?? "isolated",
      side: input.side,
      posSide: input.posSide,
      ordType: input.ordType ?? "market",
      sz: input.sz,
      ...(input.clOrdId ? { clOrdId: input.clOrdId } : {})
    };
    return this.request<Record<string, unknown>>("POST", "/api/v5/trade/order", null, payload);
  }

  getOrder(instId: string, ordId?: string, clOrdId?: string): Promise<OkxApiEnvelope<Record<string, unknown>>> {
    const q = new URLSearchParams();
    q.set("instId", instId);
    if (ordId) q.set("ordId", ordId);
    if (clOrdId) q.set("clOrdId", clOrdId);
    return this.request<Record<string, unknown>>("GET", "/api/v5/trade/order", q, null);
  }
}

export function toOkxSwapInstId(symbol: string): string {
  const x = String(symbol).trim().toUpperCase();
  if (x.endsWith("USDT")) {
    return `${x.slice(0, -4)}-USDT-SWAP`;
  }
  return `${x}-SWAP`;
}
