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
const PUBLIC_BUNDLE_PATH = path.join("data", "reports", "public-futures-paper-bundle.json");

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

async function loadPublicBundle(projectRoot: string): Promise<{ bundle: DataBundle; readFiles: string[] }> {
  const fullPath = path.join(projectRoot, PUBLIC_BUNDLE_PATH);
  const raw = await fs.readFile(fullPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("public_bundle_invalid_shape");
  }
  return { bundle: parsed as DataBundle, readFiles: [PUBLIC_BUNDLE_PATH] };
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
  if (!secret || token !== secret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!root) {
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
    console.info("[lightsail-futures-paper-api] data_route_success", {
      elapsedMs: Date.now() - startedAt,
      readFiles
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "bundle_failed";
    if (lastKnownSafeBundle) {
      res.setHeader("X-Orbitalpha-Futures-Paper-Source", "last-known-safe");
      res.json(lastKnownSafeBundle);
      console.error("[lightsail-futures-paper-api] data_route_fail", {
        elapsedMs: Date.now() - startedAt,
        reason: message,
        fallback: "last-known-safe"
      });
      return;
    }
    const status = message === "data_route_timeout" ? 503 : 500;
    res.status(status).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`lightsail-futures-paper-api listening on :${PORT}`);
});
