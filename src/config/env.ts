import * as path from "node:path";
import * as dotenv from "dotenv";

import type { EngineConfig, MarketSymbol } from "../models/types";
import { ENTRY_GATE_CONFIG } from "../strategy/entry-gate-config";

export type EnvInput = NodeJS.ProcessEnv;

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  const x = v.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(x)) return true;
  if (["0", "false", "no", "n", "off"].includes(x)) return false;
  return fallback;
}

function parseNumber(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseIntClamped(v: string | undefined, fallback: number, min: number, max: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseLogLevel(v: string | undefined): EngineConfig["logLevel"] {
  const x = (v ?? "info").trim().toLowerCase();
  if (x === "debug" || x === "info" || x === "warn" || x === "error") return x;
  return "info";
}

function parseSymbols(v: string | undefined): MarketSymbol[] {
  const raw = (v ?? "BTCUSDT,ETHUSDT").split(",").map((s) => s.trim()).filter(Boolean);
  return raw.length > 0 ? (raw as MarketSymbol[]) : (["BTCUSDT", "ETHUSDT"] as MarketSymbol[]);
}

export function loadEnv(envFilePath?: string): void {
  const p = envFilePath ?? path.resolve(process.cwd(), ".env");
  dotenv.config({ path: p });
}

export function getEngineConfig(env: EnvInput = process.env): EngineConfig {
  const dataDir = (env.DATA_DIR ?? "./data").trim();
  const paperTakerFeeRaw = env.ORBITALPHA_PAPER_FUTURES_TAKER_FEE_RATE ?? env.TAKER_FEE_RATE;
  const fundingIntervalRaw = env.ORBITALPHA_PAPER_FUTURES_FUNDING_INTERVAL_HOURS;
  const paperEntryRelaxed = parseBool(env.ORBITALPHA_PAPER_ENTRY_RELAXED, false);
  const defaultMoveMult = paperEntryRelaxed ? 1.05 : ENTRY_GATE_CONFIG.minMoveVsCostMultiplier;
  const paperGateMinMoveMultiplier = parseNumber(env.ORBITALPHA_PAPER_GATE_MOVE_MULT, defaultMoveMult);
  const paperRequireHigherTfAlign = parseBool(env.ORBITALPHA_PAPER_GATE_REQUIRE_HIGHER_TF, !paperEntryRelaxed);
  const defaultQualityMin = paperEntryRelaxed ? 60 : 75;
  const paperQualityMinScore = parseNumber(env.ORBITALPHA_PAPER_QUALITY_MIN_SCORE, defaultQualityMin);
  const paperMaxOpenPositions = parseIntClamped(env.ORBITALPHA_PAPER_MAX_OPEN_POSITIONS, 3, 1, 3);

  return {
    symbols: parseSymbols(env.SYMBOLS),
    leverage: parseNumber(env.LEVERAGE, 2),
    longOnly: parseBool(env.LONG_ONLY, true),
    fees: {
      taker: parseNumber(env.TAKER_FEE_RATE, 0.0006),
      maker: parseNumber(env.MAKER_FEE_RATE, 0.0002)
    },
    paperTakerFeeRate: parseNumber(paperTakerFeeRaw, 0.0006),
    paperFundingIntervalHours: parseNumber(fundingIntervalRaw, 8),
    dataDir,
    logLevel: parseLogLevel(env.LOG_LEVEL),
    paperEntryRelaxed,
    paperGateMinMoveMultiplier,
    paperRequireHigherTfAlign,
    paperQualityMinScore,
    paperMaxOpenPositions
  };
}

