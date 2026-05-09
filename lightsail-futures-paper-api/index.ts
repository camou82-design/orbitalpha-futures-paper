/**
 * Read-only HTTP API: serves prebuilt paper bundle JSON (Lightsail).
 */
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import express, { Request, Response } from "express";
import { deriveCurrentPositionsForDisplay } from "../src/lib/futuresPaperBundleCore.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monitorDir = path.join(__dirname, "..", "monitor");

const app = express();
const PORT = Number(process.env.PORT ?? 3991);
const secret = process.env.ORBITALPHA_FUTURES_PAPER_API_SECRET?.trim();
const root = process.env.ORBITALPHA_FUTURES_PAPER_ROOT?.trim();

const DATA_ROUTE_TIMEOUT_MS = Number(process.env.FUTURES_PAPER_DATA_ROUTE_TIMEOUT_MS ?? 2_500);
const HEALTH_ROUTE_TIMEOUT_MS = Number(process.env.FUTURES_PAPER_HEALTH_ROUTE_TIMEOUT_MS ?? 800);
/** Log / response header (always POSIX-style for grep across OS). */
const PUBLIC_BUNDLE_REL = "data/reports/public-futures-paper-bundle.json";

type DataBundle = Readonly<Record<string, unknown>>;
type TradeControlState = Readonly<{
  serverTradeEnabled: boolean;
  closeOnlyMode: boolean;
  killSwitch: boolean;
  updatedAt: number;
  updatedBy: string;
  reason: string | null;
}>;

interface CacheContext {
  bundle: DataBundle;
  mtimeMs: number;
  cachedAt: number;
  metrics?: {
    stat_ms?: number;
    read_ms?: number;
    parse_ms?: number;
  };
}
let memoryCache: CacheContext | null = null;
let inFlightLoad: Promise<CacheContext> | null = null;

const isProd = process.env.NODE_ENV === "production";
if (!isProd) {
  console.warn("!! WARNING: Running in non-production mode. Ensure this is intentional.");
}

const placeholders = ["PLACEHOLDER_CHANGE_ME", "REPLACE_WITH_STRONG_SECRET", "123456", "SECRET"];
if (!secret || placeholders.includes(secret.toUpperCase())) {
  console.error("!! FATAL: Insecure or missing ORBITALPHA_FUTURES_PAPER_API_SECRET. Boot aborted.");
  process.exit(1);
}
if (!root) {
  console.error("!! FATAL: ORBITALPHA_FUTURES_PAPER_ROOT is NOT set. Boot aborted.");
  process.exit(1);
}

function requestPaperToken(req: Request): string {
  const x = String(req.headers["x-orbitalpha-futures-paper-token"] ?? "").trim();
  if (x) return x;
  const auth = String(req.headers.authorization ?? "").trim();
  const m = /^Bearer\s+(\S+)/i.exec(auth);
  return m ? m[1].trim() : "";
}

function timeoutPromise<T>(ms: number, message: string): Promise<T> {
  return new Promise<T>((_, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    t.unref();
  });
}

function remoteAddress(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim().length > 0) {
    return xff.split(",")[0]!.trim().slice(0, 128);
  }
  const a = req.socket?.remoteAddress ?? req.ip;
  return typeof a === "string" ? a.slice(0, 128) : "";
}

function userAgentSnippet(req: Request): string {
  const ua = String(req.headers["user-agent"] ?? "");
  return ua.replace(/\s+/g, " ").trim().slice(0, 160);
}

/** One-line JSON for `grep` / journald (no multi-line object dumps). */
function logDataRouteLine(payload: Record<string, unknown>): void {
  const line = JSON.stringify({ service: "lightsail-futures-paper-api", ...payload });
  const ev = payload.event;
  if (ev === "data_route_fail") {
    console.error(line);
  } else {
    console.info(line);
  }
}

const NO_ENTRY_AUDIT_REL = "data/runtime/latest-no-entry-audit.json";

/** Fresh no-entry audit (small file); merged every data response so UI can poll faster than bundle writes. */
async function attachNoEntryAudit(projectRoot: string, bundle: DataBundle): Promise<DataBundle> {
  const auditPath = path.join(projectRoot, ...NO_ENTRY_AUDIT_REL.split("/"));
  try {
    const raw = await fs.readFile(auditPath, "utf8");
    const ne = JSON.parse(raw) as Record<string, unknown>;
    if (!ne || typeof ne !== "object") return bundle;
    const bySym = ne.bySymbol;
    return {
      ...bundle,
      noEntryAudit: ne,
      noEntryAuditBySymbol:
        bySym && typeof bySym === "object" && !Array.isArray(bySym) ? (bySym as Record<string, unknown>) : null
    };
  } catch {
    return bundle;
  }
}

async function doLoadBundle(projectRoot: string): Promise<CacheContext> {
  const fullPath = path.join(projectRoot, ...PUBLIC_BUNDLE_REL.split("/"));
  
  const t0 = Date.now();
  let stat: { mtimeMs: number };
  try {
    stat = await fs.stat(fullPath);
  } catch (err: unknown) {
    const code = err && typeof err === "object" && "code" in err ? String((err as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") throw new Error("public_bundle_file_missing");
    throw new Error("public_bundle_stat_failed");
  }
  const t1 = Date.now();

  if (memoryCache && stat.mtimeMs <= memoryCache.mtimeMs) {
    return {
      ...memoryCache,
      metrics: { stat_ms: t1 - t0 }
    };
  }

  let raw: string;
  try {
    raw = await fs.readFile(fullPath, "utf8");
  } catch {
    throw new Error("public_bundle_read_failed");
  }
  const t2 = Date.now();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("public_bundle_invalid_json");
  }
  const t3 = Date.now();

  if (!parsed || typeof parsed !== "object") {
    throw new Error("public_bundle_invalid_shape");
  }

  const o = parsed as Record<string, unknown>;
  const openPositions = Array.isArray(o.openPositions) ? o.openPositions : [];
  const bundleHydrated = {
    ...o,
    openPositions,
    currentPositions: deriveCurrentPositionsForDisplay(o.engineState ?? null, openPositions)
  } as DataBundle;

  return {
    bundle: bundleHydrated,
    mtimeMs: stat.mtimeMs,
    cachedAt: Date.now(),
    metrics: {
      stat_ms: t1 - t0,
      read_ms: t2 - t1,
      parse_ms: t3 - t2
    }
  };
}

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use("/monitor", express.static(monitorDir));

const CONTROL_FILE_REL = "data/control/trade-control.json";

function defaultTradeControlState(nowTs = Date.now()): TradeControlState {
  return {
    serverTradeEnabled: false,
    closeOnlyMode: false,
    killSwitch: false,
    updatedAt: nowTs,
    updatedBy: "bootstrap_default",
    reason: "default_off_until_operator_enable"
  };
}

function controlFilePath(projectRoot: string): string {
  return path.join(projectRoot, ...CONTROL_FILE_REL.split("/"));
}

function normalizeTradeControl(raw: unknown): TradeControlState {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const def = defaultTradeControlState();
  return {
    serverTradeEnabled: typeof o.serverTradeEnabled === "boolean" ? o.serverTradeEnabled : def.serverTradeEnabled,
    closeOnlyMode: typeof o.closeOnlyMode === "boolean" ? o.closeOnlyMode : def.closeOnlyMode,
    killSwitch: typeof o.killSwitch === "boolean" ? o.killSwitch : def.killSwitch,
    updatedAt: typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt) ? o.updatedAt : def.updatedAt,
    updatedBy: typeof o.updatedBy === "string" && o.updatedBy.trim() ? o.updatedBy.trim().slice(0, 120) : def.updatedBy,
    reason: typeof o.reason === "string" ? o.reason.slice(0, 240) : null
  };
}

async function readTradeControlState(projectRoot: string): Promise<{ state: TradeControlState; source: "file" | "bootstrap_default"; filePath: string }> {
  const filePath = controlFilePath(projectRoot);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return {
      state: normalizeTradeControl(JSON.parse(raw)),
      source: "file",
      filePath
    };
  } catch {
    const state = defaultTradeControlState();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
    return { state, source: "bootstrap_default", filePath };
  }
}

async function writeTradeControlState(projectRoot: string, state: TradeControlState): Promise<string> {
  const filePath = controlFilePath(projectRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
  return filePath;
}

app.get("/health", (_req: Request, res: Response) => {
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(503).json({
        ok: false,
        error: "health_timeout",
        service: "lightsail-futures-paper-api",
        timestamp: Date.now()
      });
    }
  }, HEALTH_ROUTE_TIMEOUT_MS);
  timer.unref();
  try {
    res.json({
      ok: true,
      alive: true,
      service: "lightsail-futures-paper-api",
      timestamp: Date.now()
    });
    console.info("[lightsail-futures-paper-api] health_hit", {
      elapsedMs: Date.now() - startedAt
    });
  } finally {
    clearTimeout(timer);
  }
});

app.get("/api/futures-paper/data", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const token = requestPaperToken(req);
  const tokenPresent = token.length > 0;
  const ra = remoteAddress(req);
  const ua = userAgentSnippet(req);

  if (!secret || token !== secret) {
    logDataRouteLine({
      event: "data_route_fail",
      reason: "unauthorized",
      elapsedMs: Date.now() - startedAt,
      fallback: "none",
      tokenPresent,
      remoteAddress: ra || undefined,
      userAgentSnippet: ua || undefined,
      readFiles: [PUBLIC_BUNDLE_REL]
    });
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!root) {
    logDataRouteLine({
      event: "data_route_fail",
      reason: "root_not_set",
      elapsedMs: Date.now() - startedAt,
      fallback: "none",
      tokenPresent,
      remoteAddress: ra || undefined,
      userAgentSnippet: ua || undefined,
      readFiles: [PUBLIC_BUNDLE_REL]
    });
    res.status(500).json({ error: "ORBITALPHA_FUTURES_PAPER_ROOT not set" });
    return;
  }
  try {
    if (!inFlightLoad) {
      inFlightLoad = doLoadBundle(root)
        .then(res => {
          memoryCache = res;
          return res;
        })
        .finally(() => {
          inFlightLoad = null;
        });
    }

    const timeoutMs = memoryCache ? 500 : DATA_ROUTE_TIMEOUT_MS;
    const result = await Promise.race([
      inFlightLoad,
      timeoutPromise<CacheContext>(timeoutMs, "data_route_timeout")
    ]);
    
    const total_ms = Date.now() - startedAt;
    let controlState: TradeControlState | null = null;
    if (root) {
      const control = await readTradeControlState(root);
      controlState = control.state;
    }
    const mergedAudit = await attachNoEntryAudit(root, result.bundle);
    const bundleWithControl = {
      ...(mergedAudit as Record<string, unknown>),
      tradeControl: controlState
    };
    res.setHeader("X-Orbitalpha-Futures-Paper-Source", "public-bundle");
    res.setHeader("X-Orbitalpha-Futures-Paper-Read-Files", [PUBLIC_BUNDLE_REL, NO_ENTRY_AUDIT_REL].join(","));
    res.json(bundleWithControl);
    
    logDataRouteLine({
      event: "data_route_success",
      elapsedMs: total_ms,
      readFiles: [PUBLIC_BUNDLE_REL],
      tokenPresent,
      remoteAddress: ra || undefined,
      userAgentSnippet: ua || undefined,
      cache_hit: !result.metrics?.read_ms,
      fallback_source: "file",
      bundle_file_mtime: result.mtimeMs,
      bundle_age_ms: Date.now() - result.cachedAt,
      stat_ms: result.metrics?.stat_ms,
      read_ms: result.metrics?.read_ms,
      parse_ms: result.metrics?.parse_ms,
      total_ms
    });

  } catch (e) {
    const message = e instanceof Error ? e.message : "bundle_failed";
    const total_ms = Date.now() - startedAt;
    
    if (memoryCache && root) {
      res.setHeader("X-Orbitalpha-Futures-Paper-Source", "memory-last-known-safe");
      const fallback = await attachNoEntryAudit(root, memoryCache.bundle);
      res.json({
        ...(fallback as Record<string, unknown>),
        tradeControl: (await readTradeControlState(root)).state
      });
      logDataRouteLine({
        event: "data_route_fail",
        reason: message,
        elapsedMs: total_ms,
        fallback: "last-known-safe",
        fallback_source: "memory",
        tokenPresent,
        remoteAddress: ra || undefined,
        userAgentSnippet: ua || undefined,
        readFiles: [PUBLIC_BUNDLE_REL],
        bundle_file_mtime: memoryCache.mtimeMs,
        bundle_age_ms: Date.now() - memoryCache.cachedAt,
        total_ms
      });
      return;
    }
    
    const status = message === "data_route_timeout" ? 503 : 500;
    res.status(status).json({ error: message });
    logDataRouteLine({
      event: "data_route_fail",
      reason: message,
      elapsedMs: total_ms,
      fallback: "none",
      fallback_source: "none",
      tokenPresent,
      remoteAddress: ra || undefined,
      userAgentSnippet: ua || undefined,
      readFiles: [PUBLIC_BUNDLE_REL],
      total_ms
    });
  }
});

app.get("/api/futures-paper/control", async (req: Request, res: Response) => {
  const token = requestPaperToken(req);
  if (!secret || token !== secret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!root) {
    res.status(500).json({ error: "ORBITALPHA_FUTURES_PAPER_ROOT not set" });
    return;
  }
  const control = await readTradeControlState(root);
  res.json({
    ...control.state,
    controlSource: control.source,
    controlFilePath: control.filePath
  });
});

app.post("/api/futures-paper/control", async (req: Request, res: Response) => {
  const token = requestPaperToken(req);
  if (!secret || token !== secret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!root) {
    res.status(500).json({ error: "ORBITALPHA_FUTURES_PAPER_ROOT not set" });
    return;
  }
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const keys = ["serverTradeEnabled", "closeOnlyMode", "killSwitch"] as const;
  const hasControlField = keys.some((k) => k in body);
  if (!hasControlField) {
    res.status(400).json({ error: "missing_control_fields" });
    return;
  }
  for (const k of keys) {
    if (k in body && typeof body[k] !== "boolean") {
      res.status(400).json({ error: `invalid_${k}` });
      return;
    }
  }
  if ("updatedBy" in body && typeof body.updatedBy !== "string") {
    res.status(400).json({ error: "invalid_updatedBy" });
    return;
  }
  if ("reason" in body && body.reason != null && typeof body.reason !== "string") {
    res.status(400).json({ error: "invalid_reason" });
    return;
  }
  const current = await readTradeControlState(root);
  const next: TradeControlState = {
    serverTradeEnabled: "serverTradeEnabled" in body ? Boolean(body.serverTradeEnabled) : current.state.serverTradeEnabled,
    closeOnlyMode: "closeOnlyMode" in body ? Boolean(body.closeOnlyMode) : current.state.closeOnlyMode,
    killSwitch: "killSwitch" in body ? Boolean(body.killSwitch) : current.state.killSwitch,
    updatedAt: Date.now(),
    updatedBy:
      typeof body.updatedBy === "string" && body.updatedBy.trim()
        ? body.updatedBy.trim().slice(0, 120)
        : "api",
    reason:
      typeof body.reason === "string"
        ? body.reason.slice(0, 240)
        : current.state.reason
  };
  const filePath = await writeTradeControlState(root, next);
  console.info(JSON.stringify({
    event: "TRADE_CONTROL_UPDATED",
    serverTradeEnabled: next.serverTradeEnabled,
    closeOnlyMode: next.closeOnlyMode,
    killSwitch: next.killSwitch,
    updatedAt: next.updatedAt,
    updatedBy: next.updatedBy,
    reason: next.reason,
    controlFilePath: filePath
  }));
  res.json(next);
});

app.listen(PORT, () => {
  console.log(`lightsail-futures-paper-api listening on :${PORT}`);
});
