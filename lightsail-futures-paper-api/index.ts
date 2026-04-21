/**
 * Read-only HTTP API: serves JSON from this repo's `data/` on disk (Lightsail).
 *
 * Env:
 *   ORBITALPHA_FUTURES_PAPER_ROOT — absolute path to orbitalpha-futures-paper clone (contains data/)
 *   ORBITALPHA_FUTURES_PAPER_API_SECRET — shared with Vercel homepage
 *   PORT — default 3991
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
const LATEST_SNAPSHOT_PATH = path.join("data", "snapshots", "latest.json");
const SUMMARY_PATH = path.join("data", "reports", "summary.json");
const SUMMARY_WINDOW_PATH = path.join("data", "reports", "summary-window.json");
const SUMMARY_HEALTH_PATH = path.join("data", "reports", "summary-health.json");

type DataBundle = Readonly<{
  configured: boolean;
  configHint: string | null;
  summary: unknown | null;
  summaryWindow: unknown | null;
  summaryHealth: unknown | null;
  latestSnapshot: unknown | null;
  generatedAt: number;
}>;

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

app.disable("x-powered-by");

/** 실시간 판단형 모니터 (정적 UI, 기존 JSON 번들만 사용) */
app.use("/monitor", express.static(monitorDir));

app.get("/health", (_req: Request, res: Response) => {
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    console.error("[lightsail-futures-paper-api] health_hit timeout", {
      elapsedMs: Date.now() - startedAt,
      timeoutMs: HEALTH_ROUTE_TIMEOUT_MS
    });
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
    const body = {
      ok: true,
      alive: true,
      service: "lightsail-futures-paper-api",
      timestamp: Date.now()
    };
    res.json(body);
    console.info("[lightsail-futures-paper-api] health_hit", {
      elapsedMs: Date.now() - startedAt
    });
  } finally {
    clearTimeout(timer);
  }
});

function timeoutPromise<T>(ms: number, message: string): Promise<T> {
  return new Promise<T>((_, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    t.unref();
  });
}

async function readJsonSafe(projectRoot: string, relPath: string): Promise<{ file: string; value: unknown | null }> {
  const fullPath = path.join(projectRoot, relPath);
  try {
    const raw = await fs.readFile(fullPath, "utf8");
    if (!raw.trim()) return { file: relPath, value: null };
    return { file: relPath, value: JSON.parse(raw) as unknown };
  } catch {
    return { file: relPath, value: null };
  }
}

async function loadDataBundleFromStaticFiles(projectRoot: string): Promise<{ bundle: DataBundle; readFiles: string[] }> {
  const [latestSnapshot, summary, summaryWindow, summaryHealth] = await Promise.all([
    readJsonSafe(projectRoot, LATEST_SNAPSHOT_PATH),
    readJsonSafe(projectRoot, SUMMARY_PATH),
    readJsonSafe(projectRoot, SUMMARY_WINDOW_PATH),
    readJsonSafe(projectRoot, SUMMARY_HEALTH_PATH)
  ]);
  const readFiles = [latestSnapshot.file, summary.file, summaryWindow.file, summaryHealth.file];
  const bundle: DataBundle = {
    configured: true,
    configHint: null,
    latestSnapshot: latestSnapshot.value,
    summary: summary.value,
    summaryWindow: summaryWindow.value,
    summaryHealth: summaryHealth.value,
    generatedAt: Date.now()
  };
  return { bundle, readFiles };
}

app.get("/api/futures-paper/data", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  console.info("[lightsail-futures-paper-api] data_route_start", { startedAt });
  const token = requestPaperToken(req);
  if (!secret || token !== secret) {
    console.error("[lightsail-futures-paper-api] data_route_fail", {
      reason: "unauthorized",
      elapsedMs: Date.now() - startedAt
    });
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!root) {
    console.error("[lightsail-futures-paper-api] data_route_fail", {
      reason: "misconfigured_root",
      elapsedMs: Date.now() - startedAt
    });
    res.status(500).json({ error: "ORBITALPHA_FUTURES_PAPER_ROOT not set" });
    return;
  }
  try {
    const { bundle, readFiles } = await Promise.race([
      loadDataBundleFromStaticFiles(root),
      timeoutPromise<{ bundle: DataBundle; readFiles: string[] }>(DATA_ROUTE_TIMEOUT_MS, "data_route_timeout")
    ]);
    lastKnownSafeBundle = bundle;
    res.setHeader("X-Orbitalpha-Futures-Paper-Source", "static-snapshot");
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
    console.error("[lightsail-futures-paper-api] data_route_fail", {
      elapsedMs: Date.now() - startedAt,
      reason: message,
      fallback: "none"
    });
    const status = message === "data_route_timeout" ? 503 : 500;
    res.status(status).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`lightsail-futures-paper-api listening on :${PORT}`);
});
