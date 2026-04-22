/**
 * Read-only HTTP API: serves prebuilt paper bundle JSON (Lightsail).
 */
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import express, { Request, Response } from "express";

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
let lastKnownSafeBundle: DataBundle | null = null;

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

async function loadPublicBundle(projectRoot: string): Promise<{ bundle: DataBundle; readFiles: string[] }> {
  const fullPath = path.join(projectRoot, ...PUBLIC_BUNDLE_REL.split("/"));
  let raw: string;
  try {
    raw = await fs.readFile(fullPath, "utf8");
  } catch (err: unknown) {
    const code = err && typeof err === "object" && "code" in err ? String((err as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      throw new Error("public_bundle_file_missing");
    }
    throw new Error("public_bundle_read_failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("public_bundle_invalid_json");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("public_bundle_invalid_shape");
  }
  return { bundle: parsed as DataBundle, readFiles: [PUBLIC_BUNDLE_REL] };
}

app.disable("x-powered-by");
app.use("/monitor", express.static(monitorDir));

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
    const { bundle, readFiles } = await Promise.race([
      loadPublicBundle(root),
      timeoutPromise<{ bundle: DataBundle; readFiles: string[] }>(DATA_ROUTE_TIMEOUT_MS, "data_route_timeout")
    ]);
    lastKnownSafeBundle = bundle;
    res.setHeader("X-Orbitalpha-Futures-Paper-Source", "public-bundle");
    res.setHeader("X-Orbitalpha-Futures-Paper-Read-Files", readFiles.join(","));
    res.json(bundle);
    logDataRouteLine({
      event: "data_route_success",
      elapsedMs: Date.now() - startedAt,
      readFiles,
      tokenPresent,
      remoteAddress: ra || undefined,
      userAgentSnippet: ua || undefined
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "bundle_failed";
    if (lastKnownSafeBundle) {
      res.setHeader("X-Orbitalpha-Futures-Paper-Source", "last-known-safe");
      res.json(lastKnownSafeBundle);
      logDataRouteLine({
        event: "data_route_fail",
        reason: message,
        elapsedMs: Date.now() - startedAt,
        fallback: "last-known-safe",
        tokenPresent,
        remoteAddress: ra || undefined,
        userAgentSnippet: ua || undefined,
        readFiles: [PUBLIC_BUNDLE_REL]
      });
      return;
    }
    const status = message === "data_route_timeout" ? 503 : 500;
    res.status(status).json({ error: message });
    logDataRouteLine({
      event: "data_route_fail",
      reason: message,
      elapsedMs: Date.now() - startedAt,
      fallback: "none",
      tokenPresent,
      remoteAddress: ra || undefined,
      userAgentSnippet: ua || undefined,
      readFiles: [PUBLIC_BUNDLE_REL]
    });
  }
});

app.listen(PORT, () => {
  console.log(`lightsail-futures-paper-api listening on :${PORT}`);
});
