/**
 * Offline audit helper for live decisions/events jsonl.
 * Usage: npx tsx scripts/live-trading-authority-audit.ts [decisions.jsonl] [events.jsonl]
 */

import * as fs from "node:fs";
import * as readline from "node:readline";

type JsonLine = Record<string, unknown>;

async function readJsonl(path: string, limit = 5000): Promise<JsonLine[]> {
  if (!fs.existsSync(path)) return [];
  const rows: JsonLine[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as JsonLine);
    } catch {
      /* skip */
    }
    if (rows.length >= limit) break;
  }
  return rows;
}

function inc(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

async function main(): Promise<void> {
  const decisionsPath = process.argv[2] ?? "data/reports/decisions.jsonl";
  const eventsPath = process.argv[3] ?? "data/reports/events.jsonl";
  const decisions = await readJsonl(decisionsPath, 2000);
  const events = await readJsonl(eventsPath, 5000);

  const btcBlocks: Record<string, number> = {};
  const ethBlocks: Record<string, number> = {};
  let btcEnter = 0;
  let ethEnter = 0;

  for (const row of decisions) {
    const sym = String(row.symbol ?? "");
    const decision = String(row.final_decision ?? row.decision ?? row.v2_decision ?? "UNKNOWN");
    const block = String(
      row.reject_reason ??
        row.block_reason ??
        row.promotion_block_reason ??
        row.expected_missing_condition ??
        "none"
    );
    if (sym === "BTCUSDT") {
      if (decision === "ENTER") btcEnter++;
      else inc(btcBlocks, block);
    }
    if (sym === "ETHUSDT") {
      if (decision === "ENTER") ethEnter++;
      else inc(ethBlocks, block);
    }
  }

  const sizingProofs = events.filter((e) => e.event === "V2_EQUITY_ADAPTIVE_SIZING_PROOF").slice(-30);
  const takeoverProofs = events.filter((e) => e.event === "V2_MANUAL_TAKEOVER_AUTHORITY_PROOF").slice(-20);

  console.log(JSON.stringify({
    audit: "LIVE_TRADING_AUTHORITY_OFFLINE",
    decisions_path: decisionsPath,
    events_path: eventsPath,
    decisions_loaded: decisions.length,
    events_loaded: events.length,
    btc_enter_count: btcEnter,
    eth_enter_count: ethEnter,
    btc_block_reason_counts: btcBlocks,
    eth_block_reason_counts: ethBlocks,
    recent_sizing_proofs: sizingProofs.length,
    recent_takeover_proofs: takeoverProofs.length,
    note: decisions.length === 0 ? "NO_LOCAL_LOGS — deploy on server with data/reports/*.jsonl" : "loaded"
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
