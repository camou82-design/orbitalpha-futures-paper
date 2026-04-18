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
import { loadFuturesPaperBundleFromDiskRoot } from "../src/lib/futuresPaperBundleCore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monitorDir = path.join(__dirname, "..", "monitor");

const app = express();
const PORT = Number(process.env.PORT ?? 3991);
const secret = process.env.ORBITALPHA_FUTURES_PAPER_API_SECRET?.trim();
const root = process.env.ORBITALPHA_FUTURES_PAPER_ROOT?.trim();

if (!secret || secret === "REPLACE_WITH_STRONG_SECRET" || secret === "PLACEHOLDER_CHANGE_ME") {
  console.warn("!! CRITICAL: Placeholder secret or NO secret detected in ORBITALPHA_FUTURES_PAPER_API_SECRET.");
}
if (!root) {
  console.warn("!! CRITICAL: ORBITALPHA_FUTURES_PAPER_ROOT is NOT set.");
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
    status: (secret && root) ? "ok" : "misconfigured",
    service: "lightsail-futures-paper-api",
    timestamp: Date.now()
  });
});

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
    const bundle = await loadFuturesPaperBundleFromDiskRoot(root);
    res.json(bundle);
  } catch (e) {
    console.error("[lightsail-futures-paper-api]", e);
    res.status(500).json({ error: "bundle_failed" });
  }
});

app.listen(PORT, () => {
  console.log(`lightsail-futures-paper-api listening on :${PORT}`);
});
