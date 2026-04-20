/**
 * Read-only HTTP API: serves JSON from this repo's `data/` on disk (Lightsail).
 *
 * Env:
 *   ORBITALPHA_FUTURES_PAPER_ROOT — absolute path to orbitalpha-futures-paper clone (contains data/)
 *   ORBITALPHA_FUTURES_PAPER_API_SECRET — shared with Vercel homepage
 *   PORT — default 3991
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import express, { Request, Response } from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monitorDir = path.join(__dirname, "..", "monitor");

const app = express();
const PORT = Number(process.env.PORT ?? 3991);
const secret = process.env.ORBITALPHA_FUTURES_PAPER_API_SECRET?.trim();
const root = process.env.ORBITALPHA_FUTURES_PAPER_ROOT?.trim();

/** bundle cache TTL (ms); 5–15s 권장, 폴링 5s에서 upstream 재생성 폭주 완화 */
export const FUTURES_PAPER_DATA_CACHE_TTL_MS = 10_000;

type BundleCacheEntry = Readonly<{ bundle: unknown; ts: number }>;

let bundleCache: BundleCacheEntry | null = null;
let bundleRebuild: Promise<unknown> | null = null;

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
  res.json({
    ok: true,
    status: secret && root ? "ok" : "misconfigured",
    service: "lightsail-futures-paper-api",
    timestamp: Date.now()
  });
});

async function loadBundleFromDisk(projectRoot: string): Promise<unknown> {
  const bundleCore = await import("../src/lib/futuresPaperBundleCore.ts");
  const loadFuturesPaperBundleFromDiskRoot = (
    bundleCore as { loadFuturesPaperBundleFromDiskRoot?: (r: string) => Promise<unknown> }
  ).loadFuturesPaperBundleFromDiskRoot;
  if (typeof loadFuturesPaperBundleFromDiskRoot !== "function") {
    throw new Error("bundle_loader_unavailable");
  }
  return loadFuturesPaperBundleFromDiskRoot(projectRoot);
}

/**
 * TTL 안 캐시 반환, 만료 시 단일 in-flight rebuild(동시 요청 공유).
 * 실패 시 stale 캐시가 있으면 그걸 반환하는 Promise.
 */
async function getFuturesPaperDataBundleCached(projectRoot: string): Promise<{
  bundle: unknown;
  cache: "hit" | "miss" | "stale";
}> {
  const now = Date.now();
  if (bundleCache !== null && now - bundleCache.ts < FUTURES_PAPER_DATA_CACHE_TTL_MS) {
    return { bundle: bundleCache.bundle, cache: "hit" };
  }

  if (!bundleRebuild) {
    bundleRebuild = loadBundleFromDisk(projectRoot)
      .then((b) => {
        bundleCache = { bundle: b, ts: Date.now() };
        return b;
      })
      .finally(() => {
        bundleRebuild = null;
      });
  }

  try {
    const bundle = await bundleRebuild;
    return { bundle, cache: "miss" };
  } catch (e) {
    if (bundleCache !== null) {
      return { bundle: bundleCache.bundle, cache: "stale" };
    }
    throw e;
  }
}

app.get("/api/futures-paper/data", async (req: Request, res: Response) => {
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
    const { bundle, cache } = await getFuturesPaperDataBundleCached(root);
    res.setHeader("X-Orbitalpha-Futures-Paper-Bundle-Cache", cache);
    res.json(bundle);
  } catch (e) {
    console.error("[lightsail-futures-paper-api]", e);
    res.status(500).json({ error: "bundle_failed" });
  }
});

app.listen(PORT, () => {
  console.log(`lightsail-futures-paper-api listening on :${PORT}`);
});
