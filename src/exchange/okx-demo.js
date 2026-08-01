"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OkxDemoClient = void 0;
exports.toOkxSwapInstId = toOkxSwapInstId;
const node_crypto_1 = require("node:crypto");
function parseOptionalFiniteNumber(raw) {
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
}
function selectUsdtDetail(details) {
    for (const d of details) {
        const ccy = String(d.ccy ?? "").toUpperCase();
        if (ccy === "USDT")
            return d;
    }
    return details.length > 0 ? details[0] : null;
}
function mustFiniteNumber(raw, ctx) {
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isFinite(n))
        throw new Error(`Invalid number for ${ctx}: ${String(raw)}`);
    return n;
}
function timeframeToOkxBar(tf) {
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
            const _exhaustive = tf;
            return _exhaustive;
        }
    }
}
function toOkxSwapInstId(symbol) {
    const x = String(symbol).trim().toUpperCase();
    if (x.endsWith("USDT")) {
        return `${x.slice(0, -4)}-USDT-SWAP`;
    }
    return `${x}-SWAP`;
}
class OkxDemoClient {
    cfg;
    minRequestIntervalMs = 120;
    nextRequestAtMs = 0;
    tickerCache = new Map();
    candleCache = new Map();
    fundingCache = new Map();
    instrumentCache = new Map();
    constructor(cfg) {
        this.cfg = cfg;
    }
    sign(ts, method, requestPath, body) {
        const prehash = `${ts}${method}${requestPath}${body}`;
        return (0, node_crypto_1.createHmac)("sha256", this.cfg.apiSecret).update(prehash).digest("base64");
    }
    async signedRequest(method, requestPath, query, body) {
        const q = query && Array.from(query.keys()).length > 0 ? `?${query.toString()}` : "";
        const pathWithQuery = `${requestPath}${q}`;
        const bodyRaw = body ? JSON.stringify(body) : "";
        const ts = new Date().toISOString();
        const requestUrl = `${this.cfg.baseUrl}${pathWithQuery}`;
        const requestPayloadForLog = method === "POST"
            ? body
            : query && Array.from(query.keys()).length > 0
                ? Object.fromEntries(query.entries())
                : null;
        const headers = {
            "Content-Type": "application/json"
        };
        if (this.cfg.simulatedTradingHeaderEnabled === true) {
            headers["x-simulated-trading"] = "1";
        }
        if (!this.cfg.apiKey) {
            return {
                ok: false,
                error: "apiKey_missing",
                diagnostics: {
                    httpStatus: 0,
                    requestUrl,
                    method,
                    endpointPath: requestPath,
                    requestPayload: requestPayloadForLog ?? undefined,
                    retMsg: "No API key configured for signed request"
                }
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
            let json;
            try {
                json = text.length > 0 ? JSON.parse(text) : null;
            }
            catch {
                return {
                    ok: false,
                    error: `invalid_json_http_${httpStatus}`,
                    diagnostics: {
                        httpStatus,
                        requestUrl,
                        method,
                        endpointPath: requestPath,
                        requestPayload: requestPayloadForLog ?? undefined,
                        responseBodyText: text.length > 16_000 ? `${text.slice(0, 16_000)}…(truncated)` : text,
                        retMsg: "Failed to parse JSON response"
                    }
                };
            }
            const diagnostics = {
                httpStatus,
                requestUrl,
                method,
                endpointPath: requestPath,
                requestPayload: requestPayloadForLog ?? undefined,
                retCode: json?.code != null ? String(json.code) : undefined,
                retMsg: json?.msg != null ? String(json.msg) : undefined,
                okxData: json?.data,
                fullResponse: json
            };
            if (!res.ok) {
                const detail = diagnostics.retMsg && diagnostics.retMsg.length > 0
                    ? diagnostics.retMsg
                    : diagnostics.retCode && String(diagnostics.retCode).length > 0
                        ? String(diagnostics.retCode)
                        : text.length > 0 && text.length <= 500
                            ? text
                            : "request_failed";
                return { ok: false, error: `okx_http_${httpStatus}:${detail}`, diagnostics };
            }
            if (json?.code !== "0") {
                const codeStr = json?.code != null ? String(json.code) : "unknown";
                const msgStr = json?.msg != null && String(json.msg).trim().length > 0
                    ? String(json.msg)
                    : (() => {
                        try {
                            const s = JSON.stringify(json);
                            return s.length > 800 ? `${s.slice(0, 800)}…` : s;
                        }
                        catch {
                            return "request_failed";
                        }
                    })();
                return { ok: false, error: `okx_api_${codeStr}:${msgStr}`, diagnostics };
            }
            return { ok: true, value: json.data, diagnostics };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
                ok: false,
                error: `signed_request_network_error: ${msg}`,
                diagnostics: {
                    httpStatus: 0,
                    requestUrl,
                    method,
                    endpointPath: requestPath,
                    requestPayload: requestPayloadForLog ?? undefined,
                    retMsg: msg
                }
            };
        }
    }
    /** Signed GET /api/v5/account/config — `acctLv`, `posMode`, etc. */
    getAccountConfig() {
        return this.signedRequest("GET", "/api/v5/account/config", null, null);
    }
    getBalance(ccy) {
        const q = new URLSearchParams();
        if (ccy)
            q.set("ccy", ccy);
        return this.signedRequest("GET", "/api/v5/account/balance", q, null);
    }
    getPositions(instType = "SWAP") {
        const q = new URLSearchParams();
        q.set("instType", instType);
        return this.signedRequest("GET", "/api/v5/account/positions", q, null);
    }
    getLeverage(instId, mgnMode = "isolated") {
        const q = new URLSearchParams();
        q.set("instId", instId);
        q.set("mgnMode", mgnMode);
        return this.signedRequest("GET", "/api/v5/account/leverage-info", q, null);
    }
    setLeverage(input) {
        const payload = {
            instId: input.instId,
            lever: input.lever,
            mgnMode: input.mgnMode ?? "isolated",
            posSide: input.posSide
        };
        return this.signedRequest("POST", "/api/v5/account/set-leverage", null, payload);
    }
    submitOrder(input) {
        const payload = {
            instId: input.instId,
            tdMode: input.tdMode ?? "isolated",
            side: input.side,
            ...(input.posSide !== undefined ? { posSide: input.posSide } : {}),
            ordType: input.ordType ?? "market",
            sz: input.sz,
            ...(input.px ? { px: input.px } : {}),
            ...(input.clOrdId ? { clOrdId: input.clOrdId } : {}),
            ...(input.reduceOnly === true ? { reduceOnly: "true" } : {}),
            ...(input.attachAlgoOrds ? { attachAlgoOrds: input.attachAlgoOrds } : {})
        };
        if (payload.ordType === "limit" && !payload.px) {
            return Promise.resolve({
                ok: false,
                error: "limit_price_missing",
                diagnostics: { httpStatus: 0, requestUrl: "/api/v5/trade/order", retMsg: "px is required for limit orders" }
            });
        }
        return this.signedRequest("POST", "/api/v5/trade/order", null, payload);
    }
    getOrder(instId, ordId, clOrdId) {
        const q = new URLSearchParams();
        q.set("instId", instId);
        if (ordId)
            q.set("ordId", ordId);
        if (clOrdId)
            q.set("clOrdId", clOrdId);
        return this.signedRequest("GET", "/api/v5/trade/order", q, null);
    }
    cancelOrder(instId, ordId, clOrdId) {
        const payload = { instId };
        if (ordId)
            payload.ordId = ordId;
        if (clOrdId)
            payload.clOrdId = clOrdId;
        return this.signedRequest("POST", "/api/v5/trade/cancel-order", null, payload);
    }
    submitAlgoOrder(input) {
        const mode = String(input.accountPosMode ?? "").trim().toLowerCase();
        const isLongShortMode = mode === "long_short_mode";
        // [VALIDATOR] Mandatory field check before calling OKX
        const missing = [];
        if (!input.instId)
            missing.push("instId");
        if (!input.side)
            missing.push("side");
        if (!input.tdMode)
            missing.push("tdMode");
        if (!input.ordType)
            missing.push("ordType");
        if (!input.sz)
            missing.push("sz");
        // ordType validation
        const allowedAlgoTypes = ["conditional", "oco", "trigger", "move_order_stop", "twap"];
        if (input.ordType && !allowedAlgoTypes.includes(input.ordType)) {
            return Promise.resolve({
                ok: false,
                error: "PROTECTIVE_ORDER_PAYLOAD_INVALID_PROOF",
                diagnostics: {
                    httpStatus: 0,
                    requestUrl: "/api/v5/trade/order-algo",
                    retMsg: `Invalid ordType: ${input.ordType}. Must be one of ${allowedAlgoTypes.join(", ")}`
                }
            });
        }
        if (missing.length > 0) {
            return Promise.resolve({
                ok: false,
                error: "PROTECTIVE_ORDER_PAYLOAD_INVALID_PROOF",
                diagnostics: {
                    httpStatus: 0,
                    requestUrl: "/api/v5/trade/order-algo",
                    retMsg: `Missing required fields: ${missing.join(", ")}`
                }
            });
        }
        const payload = {
            instId: input.instId,
            tdMode: input.tdMode,
            side: input.side,
            ...(isLongShortMode && input.posSide ? { posSide: input.posSide } : {}),
            ordType: input.ordType,
            sz: input.sz,
            ...(input.reduceOnly === true ? { reduceOnly: "true" } : {}),
            ...(input.slTriggerPx ? { slTriggerPx: input.slTriggerPx } : {}),
            ...(input.slOrdPx ? { slOrdPx: input.slOrdPx } : {}),
            ...(input.tpTriggerPx ? { tpTriggerPx: input.tpTriggerPx } : {}),
            ...(input.tpOrdPx ? { tpOrdPx: input.tpOrdPx } : {}),
            ...(input.slTriggerPxType ? { slTriggerPxType: input.slTriggerPxType } : {}),
            ...(input.tpTriggerPxType ? { tpTriggerPxType: input.tpTriggerPxType } : {}),
            ...(input.algoClOrdId ? { algoClOrdId: input.algoClOrdId } : {})
        };
        return this.signedRequest("POST", "/api/v5/trade/order-algo", null, payload);
    }
    cancelAlgoOrder(args) {
        return this.signedRequest("POST", "/api/v5/trade/cancel-algos", null, args);
    }
    /** Pending ordinary swap orders (incl. limit/market working). Diagnostics only unless paired with algo. */
    getOrdersPending(args) {
        const q = new URLSearchParams();
        q.set("instType", args.instType);
        if (args.instId)
            q.set("instId", args.instId);
        return this.signedRequest("GET", "/api/v5/trade/orders-pending", q, null);
    }
    /** Pending TP/SL / conditional / trigger algos — reduce-only protective stops live here. */
    getOrdersAlgoPending(args) {
        const q = new URLSearchParams();
        q.set("instType", args.instType);
        if (args.instId)
            q.set("instId", args.instId);
        if (args.ordType)
            q.set("ordType", args.ordType);
        return this.signedRequest("GET", "/api/v5/trade/orders-algo-pending", q, null);
    }
    async checkSignedReady() {
        const [cfg, bal, pos] = await Promise.all([
            this.getAccountConfig(),
            this.getBalance(),
            this.getPositions()
        ]);
        const balancePayload = bal.ok ? bal.value?.[0] : undefined;
        const details = Array.isArray(balancePayload?.details) ? balancePayload.details : [];
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
            if (fromTotalEq != null)
                return fromTotalEq;
            const fromEq = selectedDetail ? parseOptionalFiniteNumber(selectedDetail.eq) : null;
            if (fromEq != null)
                return fromEq;
            return null;
        })();
        const availableBalanceUsdt = (() => {
            if (selectedDetail) {
                const byAvailEq = parseOptionalFiniteNumber(selectedDetail.availEq);
                if (byAvailEq != null)
                    return byAvailEq;
                const byAvailBal = parseOptionalFiniteNumber(selectedDetail.availBal);
                if (byAvailBal != null)
                    return byAvailBal;
                const byEq = parseOptionalFiniteNumber(selectedDetail.eq);
                if (byEq != null)
                    return byEq;
            }
            for (const d of details) {
                const byAvailEq = parseOptionalFiniteNumber(d.availEq);
                if (byAvailEq != null)
                    return byAvailEq;
                const byAvailBal = parseOptionalFiniteNumber(d.availBal);
                if (byAvailBal != null)
                    return byAvailBal;
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
    async publicRequest(method, requestPath, query) {
        const q = query && Array.from(query.keys()).length > 0 ? `?${query.toString()}` : "";
        const pathWithQuery = `${requestPath}${q}`;
        const requestUrl = `${this.cfg.baseUrl}${pathWithQuery}`;
        let res;
        try {
            await this.acquireRateLimitSlot();
            res = await fetch(requestUrl, {
                method,
                headers: {
                    "Content-Type": "application/json",
                    ...(this.cfg.simulatedTradingHeaderEnabled === true ? { "x-simulated-trading": "1" } : {})
                }
            });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
                success: false,
                error: `network: ${msg}`,
                diagnostics: { httpStatus: 0, requestUrl, retMsg: msg }
            };
        }
        const httpStatus = res.status;
        const text = await res.text();
        let parsed;
        try {
            parsed = text.length > 0 ? JSON.parse(text) : null;
        }
        catch {
            return {
                success: false,
                error: `invalid JSON body (HTTP ${httpStatus})`,
                diagnostics: { httpStatus, requestUrl, retMsg: "json_parse_error" }
            };
        }
        const json = parsed;
        const retCode = json?.code;
        const retMsg = json?.msg;
        const diagnostics = { httpStatus, requestUrl, retCode, retMsg };
        if (!res.ok) {
            return { success: false, error: `HTTP ${httpStatus} ${res.statusText}`, diagnostics };
        }
        if (retCode !== "0") {
            return { success: false, error: `OKX code ${retCode} ${retMsg ?? ""}`.trim(), diagnostics };
        }
        return { success: true, json: parsed, diagnostics };
    }
    async getTicker(symbol) {
        const r = await this.tryGetTicker(symbol);
        if (!r.ok)
            throw new Error(r.error);
        return r.value;
    }
    async getCandles(symbol, timeframe, limit = 200) {
        const r = await this.tryGetCandles(symbol, timeframe, limit);
        if (!r.ok)
            throw new Error(r.error);
        return r.value;
    }
    async getFundingRate(symbol) {
        const r = await this.tryGetFundingRate(symbol);
        if (!r.ok)
            throw new Error(r.error);
        return r.value;
    }
    async tryGetTicker(symbol) {
        const instId = toOkxSwapInstId(symbol);
        const cacheKey = `${instId}`;
        const hit = this.tickerCache.get(cacheKey);
        if (hit && hit.expiresAt > Date.now())
            return hit.value;
        const q = new URLSearchParams();
        q.set("instId", instId);
        const res = await this.publicRequest("GET", "/api/v5/market/ticker", q);
        if (!res.success || !res.json) {
            return { ok: false, error: res.error || "unknown_error", diagnostics: res.diagnostics };
        }
        try {
            const item = res.json.data?.[0];
            if (!item)
                throw new Error(`OKX ticker empty result for ${instId}`);
            const fetchedAt = Date.now();
            const last = mustFiniteNumber(item.last, `${instId}.last`);
            const bid = item.bidPx ? mustFiniteNumber(item.bidPx, `${instId}.bidPx`) : undefined;
            const ask = item.askPx ? mustFiniteNumber(item.askPx, `${instId}.askPx`) : undefined;
            const out = { ok: true, value: { symbol, ts: fetchedAt, last, bid, ask }, diagnostics: res.diagnostics };
            this.tickerCache.set(cacheKey, { expiresAt: Date.now() + 1000, value: out });
            return out;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { ok: false, error: msg, diagnostics: res.diagnostics };
        }
    }
    async tryGetCandles(symbol, timeframe, limit = 200) {
        const instId = toOkxSwapInstId(symbol);
        const bar = timeframeToOkxBar(timeframe);
        const cacheKey = `${instId}:${bar}:${limit}`;
        const hit = this.candleCache.get(cacheKey);
        if (hit && hit.expiresAt > Date.now())
            return hit.value;
        const q = new URLSearchParams();
        q.set("instId", instId);
        q.set("bar", bar);
        q.set("limit", String(limit));
        const res = await this.publicRequest("GET", "/api/v5/market/candles", q);
        if (!res.success || !res.json) {
            return { ok: false, error: res.error || "unknown_error", diagnostics: res.diagnostics };
        }
        try {
            const rows = res.json.data || [];
            const parsed = rows.map((r, idx) => {
                if (!Array.isArray(r) || r.length < 6)
                    throw new Error(`Invalid kline row at ${instId}[${idx}]`);
                const ts = mustFiniteNumber(r[0], `${instId}.kline.ts`);
                const open = mustFiniteNumber(r[1], `${instId}.kline.open`);
                const high = mustFiniteNumber(r[2], `${instId}.kline.high`);
                const low = mustFiniteNumber(r[3], `${instId}.kline.low`);
                const close = mustFiniteNumber(r[4], `${instId}.kline.close`);
                const volume = mustFiniteNumber(r[5], `${instId}.kline.volume`);
                return { ts, open, high, low, close, volume };
            });
            // OKX returns newest first, so we reverse it to oldest first
            const out = { ok: true, value: parsed.reverse(), diagnostics: res.diagnostics };
            const ttlMs = timeframe === "1m" ? 2500 : timeframe === "3m" ? 4000 : timeframe === "5m" ? 7000 : 12000;
            this.candleCache.set(cacheKey, { expiresAt: Date.now() + ttlMs, value: out });
            return out;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { ok: false, error: msg, diagnostics: res.diagnostics };
        }
    }
    async tryGetFundingRate(symbol) {
        const instId = toOkxSwapInstId(symbol);
        const cacheKey = `${instId}`;
        const hit = this.fundingCache.get(cacheKey);
        if (hit && hit.expiresAt > Date.now())
            return hit.value;
        const q = new URLSearchParams();
        q.set("instId", instId);
        const res = await this.publicRequest("GET", "/api/v5/public/funding-rate", q);
        if (!res.success || !res.json) {
            return { ok: false, error: res.error || "unknown_error", diagnostics: res.diagnostics };
        }
        try {
            const item = res.json.data?.[0];
            const fetchedAt = Date.now();
            if (!item) {
                const out = { ok: true, value: { symbol, ts: fetchedAt, rate: 0 }, diagnostics: res.diagnostics };
                this.fundingCache.set(cacheKey, { expiresAt: Date.now() + 30000, value: out });
                return out;
            }
            const rate = mustFiniteNumber(item.fundingRate, `${instId}.fundingRate`);
            const tsRaw = item.fundingTime || item.nextFundingTime;
            const ts = tsRaw !== undefined ? mustFiniteNumber(tsRaw, `${instId}.fundingTime`) : fetchedAt;
            const out = { ok: true, value: { symbol, ts, rate }, diagnostics: res.diagnostics };
            this.fundingCache.set(cacheKey, { expiresAt: Date.now() + 30000, value: out });
            return out;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { ok: false, error: msg, diagnostics: res.diagnostics };
        }
    }
    async acquireRateLimitSlot() {
        const now = Date.now();
        if (this.nextRequestAtMs > now) {
            await new Promise((resolve) => setTimeout(resolve, this.nextRequestAtMs - now));
        }
        this.nextRequestAtMs = Date.now() + this.minRequestIntervalMs;
    }
    async tryGetInstrument(instId) {
        const cacheKey = instId;
        const hit = this.instrumentCache.get(cacheKey);
        if (hit && hit.expiresAt > Date.now())
            return hit.value;
        const q = new URLSearchParams();
        q.set("instType", "SWAP");
        q.set("instId", instId);
        const res = await this.publicRequest("GET", "/api/v5/public/instruments", q);
        if (!res.success || !res.json) {
            return { ok: false, error: res.error || "unknown_error", diagnostics: res.diagnostics };
        }
        try {
            const item = res.json.data?.[0];
            if (!item)
                throw new Error(`OKX instrument not found: ${instId}`);
            const out = { ok: true, value: item, diagnostics: res.diagnostics };
            this.instrumentCache.set(cacheKey, { expiresAt: Date.now() + 3600_000, value: out }); // Cache for 1 hour
            return out;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { ok: false, error: msg, diagnostics: res.diagnostics };
        }
    }
    /** Bulk instruments (e.g. SWAP) for ctVal / ctValCcy hydration. */
    async getInstruments(instType) {
        const q = new URLSearchParams();
        q.set("instType", instType);
        const res = await this.publicRequest("GET", "/api/v5/public/instruments", q);
        if (!res.success || !res.json) {
            return { ok: false, error: res.error || "unknown_error", diagnostics: res.diagnostics };
        }
        const data = res.json.data;
        if (!Array.isArray(data)) {
            return { ok: false, error: "invalid_instruments_payload", diagnostics: res.diagnostics };
        }
        return { ok: true, value: data, diagnostics: res.diagnostics };
    }
}
exports.OkxDemoClient = OkxDemoClient;
