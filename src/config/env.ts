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

function parseHorizonPriority(v: string | undefined, fallback: ReadonlyArray<5 | 15 | 30>): ReadonlyArray<5 | 15 | 30> {
  if (!v || v.trim() === "") return fallback;
  const parts = v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x))
    .filter((n): n is 5 | 15 | 30 => n === 5 || n === 15 || n === 30);
  const uniq: (5 | 15 | 30)[] = [];
  for (const n of parts) if (!uniq.includes(n)) uniq.push(n);
  return uniq.length > 0 ? uniq : fallback;
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
  const paperTestBypassLegacyRangeStage0 = parseBool(env.ORBITALPHA_PAPER_TEST_BYPASS_LEGACY_RANGE_STAGE0, false);
  const defaultMoveMult = paperEntryRelaxed ? 1.05 : ENTRY_GATE_CONFIG.minMoveVsCostMultiplier;
  const paperGateMinMoveMultiplier = parseNumber(env.ORBITALPHA_PAPER_GATE_MOVE_MULT, defaultMoveMult);
  const paperRequireHigherTfAlign = parseBool(env.ORBITALPHA_PAPER_GATE_REQUIRE_HIGHER_TF, !paperEntryRelaxed);
  const defaultQualityMin = paperEntryRelaxed ? 65 : 84;
  const paperQualityMinScore = parseNumber(env.ORBITALPHA_PAPER_QUALITY_MIN_SCORE, defaultQualityMin);
  const defaultQualityWeak = paperEntryRelaxed ? 50 : 75;
  const paperQualityMinScoreWeak = parseNumber(env.ORBITALPHA_PAPER_QUALITY_MIN_SCORE_WEAK, defaultQualityWeak);
  const paperMaxOpenPositions = parseIntClamped(env.ORBITALPHA_PAPER_MAX_OPEN_POSITIONS, 3, 1, 3);
  const paperStrongEmaGapThreshold = parseNumber(env.ORBITALPHA_PAPER_STRONG_EMA_GAP_THRESHOLD, 0.004);
  let paperSidewaysEmaGapThreshold = parseNumber(env.ORBITALPHA_PAPER_SIDEWAYS_EMA_GAP_THRESHOLD, 0.012);
  if (paperSidewaysEmaGapThreshold < paperStrongEmaGapThreshold) {
    paperSidewaysEmaGapThreshold = paperStrongEmaGapThreshold;
  }

  const paperReentryCooldownMsRaw = env.ORBITALPHA_PAPER_REENTRY_COOLDOWN_MS;
  const paperReentryCooldownMsParsed =
    paperReentryCooldownMsRaw === undefined || paperReentryCooldownMsRaw.trim() === ""
      ? 900_000
      : parseInt(paperReentryCooldownMsRaw, 10);
  const paperReentryCooldownMs =
    !Number.isFinite(paperReentryCooldownMsParsed) || paperReentryCooldownMsParsed < 0
      ? 900_000
      : Math.min(86_400_000, paperReentryCooldownMsParsed);

  const paperSlippageBps = parseNumber(env.ORBITALPHA_PAPER_SLIPPAGE_BPS, 2);
  const paperDailyLossLimitUsd = parseNumber(env.ORBITALPHA_PAPER_DAILY_LOSS_LIMIT_USD, 40);
  const paperLast10NetDegradeThresholdUsd = parseNumber(env.ORBITALPHA_PAPER_LAST10_NET_DEGRADE_USD, 15);
  const paperDegradeSizeMultiplier = parseNumber(env.ORBITALPHA_PAPER_DEGRADE_SIZE_MULT, 0.6);
  const paperModeLossStreakSuspendCount = parseIntClamped(env.ORBITALPHA_PAPER_MODE_SUSPEND_LOSS_STREAK, 3, 2, 6);
  const paperModeSuspendMsRaw = env.ORBITALPHA_PAPER_MODE_SUSPEND_MS;
  const paperModeSuspendMsParsed =
    paperModeSuspendMsRaw === undefined || paperModeSuspendMsRaw.trim() === "" ? 3_600_000 : parseInt(paperModeSuspendMsRaw, 10);
  const paperModeSuspendMs =
    !Number.isFinite(paperModeSuspendMsParsed) || paperModeSuspendMsParsed < 0 ? 3_600_000 : Math.min(86_400_000, paperModeSuspendMsParsed);

  const aiBlockGoodThresholdPct = parseNumber(env.ORBITALPHA_AI_BLOCK_GOOD_THRESHOLD_PCT, -0.25);
  const aiBlockMissedThresholdPct = parseNumber(env.ORBITALPHA_AI_BLOCK_MISSED_THRESHOLD_PCT, 0.35);
  const aiBlockEvaluationHorizonPriorityMins = parseHorizonPriority(
    env.ORBITALPHA_AI_BLOCK_EVAL_HORIZON_PRIORITY,
    [30, 15, 5]
  );

  const paperEngineModeRaw = (env.ORBITALPHA_PAPER_ENGINE_MODE ?? "PAPER_TEST").trim().toUpperCase();
  const paperEngineMode: "PAPER_TEST" | "SAFE" | "RESEARCH" =
    paperEngineModeRaw === "SAFE" || paperEngineModeRaw === "RESEARCH" ? (paperEngineModeRaw as "SAFE" | "RESEARCH") : "PAPER_TEST";
  const paperMinEdgeRr = parseNumber(env.ORBITALPHA_PAPER_MIN_EDGE_RR, 1);
  const paperMinEdgeVolatilityMove = parseNumber(env.ORBITALPHA_PAPER_MIN_EDGE_VOL_MOVE, 0.00003);

  const paperFixedTotalCostUsdRaw = env.PAPER_FIXED_TOTAL_COST_USD ?? env.ORBITALPHA_PAPER_FIXED_TOTAL_COST_USD;
  let paperFixedTotalCostUsd: number | null = null;
  if (paperFixedTotalCostUsdRaw !== undefined && String(paperFixedTotalCostUsdRaw).trim() !== "") {
    const x = Number(paperFixedTotalCostUsdRaw);
    if (Number.isFinite(x) && x > 0) paperFixedTotalCostUsd = Math.min(1_000_000, Math.max(0.01, x));
  }

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
    paperTestBypassLegacyRangeStage0,
    paperGateMinMoveMultiplier,
    paperRequireHigherTfAlign,
    paperQualityMinScore,
    paperQualityMinScoreWeak,
    paperMaxOpenPositions,
    paperStrongEmaGapThreshold,
    paperSidewaysEmaGapThreshold,
    paperReentryCooldownMs,
    paperSlippageBps,
    paperDailyLossLimitUsd,
    paperLast10NetDegradeThresholdUsd,
    paperDegradeSizeMultiplier,
    paperModeLossStreakSuspendCount,
    paperModeSuspendMs,
    aiBlockGoodThresholdPct,
    aiBlockMissedThresholdPct,
    aiBlockEvaluationHorizonPriorityMins,
    paperEngineMode,
    paperMinEdgeRr,
    paperMinEdgeVolatilityMove,
    paperFixedTotalCostUsd
  };
}

