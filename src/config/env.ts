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

  const rangeRebalanceMinHoldMsRaw = env.ORBITALPHA_RANGE_REBALANCE_MIN_HOLD_MS;
  const rangeRebalanceMinHoldMsParsed =
    rangeRebalanceMinHoldMsRaw === undefined || String(rangeRebalanceMinHoldMsRaw).trim() === ""
      ? 600_000
      : parseInt(String(rangeRebalanceMinHoldMsRaw), 10);
  const rangeRebalanceMinHoldMs =
    !Number.isFinite(rangeRebalanceMinHoldMsParsed) || rangeRebalanceMinHoldMsParsed < 0
      ? 600_000
      : Math.min(86_400_000, rangeRebalanceMinHoldMsParsed);

  const rangeRebalanceBoxBreakConfirmTicks = parseIntClamped(
    env.ORBITALPHA_RANGE_REBALANCE_BOX_BREAK_CONFIRM_TICKS,
    3,
    1,
    8
  );

  const rangeRebalanceProfitArmPnlPct = parseNumber(env.ORBITALPHA_RANGE_PROFIT_ARM_PNL_PCT, 0.0012);
  const rangeRebalanceSecuredMinPnlPct = parseNumber(env.ORBITALPHA_RANGE_SECURED_MIN_PNL_PCT, 0);
  const rangeRebalanceTrailPullbackSpanFrac = parseNumber(env.ORBITALPHA_RANGE_TRAIL_PULLBACK_SPAN_FRAC, 0.08);
  const rangeRebalanceTrailPullbackMinPriceFrac = parseNumber(env.ORBITALPHA_RANGE_TRAIL_PULLBACK_MIN_PRICE_FRAC, 0.0005);
  const rangeRebalanceTrailAtrMult = parseNumber(env.ORBITALPHA_RANGE_TRAIL_ATR_MULT, 0.35);
  const rangeRebalanceTrailMaxArmedNoLockMsRaw = env.ORBITALPHA_RANGE_TRAIL_MAX_ARMED_NO_LOCK_MS;
  const rangeRebalanceTrailMaxArmedNoLockMsParsed =
    rangeRebalanceTrailMaxArmedNoLockMsRaw === undefined || String(rangeRebalanceTrailMaxArmedNoLockMsRaw).trim() === ""
      ? 0
      : parseInt(String(rangeRebalanceTrailMaxArmedNoLockMsRaw), 10);
  const rangeRebalanceTrailMaxArmedNoLockMs =
    !Number.isFinite(rangeRebalanceTrailMaxArmedNoLockMsParsed) || rangeRebalanceTrailMaxArmedNoLockMsParsed < 0
      ? 0
      : Math.min(86_400_000, rangeRebalanceTrailMaxArmedNoLockMsParsed);

  const paperSlippageBps = parseNumber(env.ORBITALPHA_PAPER_SLIPPAGE_BPS, 2);
  const paperDailyLossLimitUsd = parseNumber(env.ORBITALPHA_PAPER_DAILY_LOSS_LIMIT_USD, 40);
  const paperLast10NetDegradeThresholdUsd = parseNumber(env.ORBITALPHA_PAPER_LAST10_NET_DEGRADE_USD, 15);
  const paperDegradeSizeMultiplier = parseNumber(env.ORBITALPHA_PAPER_DEGRADE_SIZE_MULT, 0.6);
  let paperModeLossStreakSoftCount = parseIntClamped(env.ORBITALPHA_PAPER_SOFT_LOSS_STREAK, 3, 2, 12);
  let paperModeLossStreakSuspendCount = parseIntClamped(env.ORBITALPHA_PAPER_MODE_SUSPEND_LOSS_STREAK, 7, 4, 16);
  if (paperModeLossStreakSuspendCount <= paperModeLossStreakSoftCount) {
    paperModeLossStreakSuspendCount = paperModeLossStreakSoftCount + 1;
  }
  const paperModeHardSuspendMsRaw = env.ORBITALPHA_PAPER_HARD_SUSPEND_MS;
  const paperModeHardSuspendMsParsed =
    paperModeHardSuspendMsRaw === undefined || String(paperModeHardSuspendMsRaw).trim() === ""
      ? 1_200_000
      : parseInt(String(paperModeHardSuspendMsRaw), 10);
  const paperModeHardSuspendMs =
    !Number.isFinite(paperModeHardSuspendMsParsed) || paperModeHardSuspendMsParsed < 0
      ? 1_200_000
      : Math.min(86_400_000, Math.max(300_000, paperModeHardSuspendMsParsed));
  const paperModeSuspendMsRaw = env.ORBITALPHA_PAPER_MODE_SUSPEND_MS;
  const paperModeSuspendMsParsed =
    paperModeSuspendMsRaw === undefined || paperModeSuspendMsRaw.trim() === "" ? 3_600_000 : parseInt(paperModeSuspendMsRaw, 10);
  const paperModeSuspendMs =
    !Number.isFinite(paperModeSuspendMsParsed) || paperModeSuspendMsParsed < 0 ? 3_600_000 : Math.min(86_400_000, paperModeSuspendMsParsed);
  const paperBaseSizeUsd = parseNumber(env.ORBITALPHA_PAPER_BASE_SIZE_USD ?? env.DEFAULT_PAPER_SIZE_USD, 100);
  const paperAccountEquityUsdRaw = env.ORBITALPHA_PAPER_ACCOUNT_EQUITY_USD;
  let paperAccountEquityUsd: number | null = null;
  if (paperAccountEquityUsdRaw !== undefined && String(paperAccountEquityUsdRaw).trim() !== "") {
    const eq = Number(paperAccountEquityUsdRaw);
    if (Number.isFinite(eq) && eq > 0) paperAccountEquityUsd = Math.min(1_000_000_000, Math.max(0.01, eq));
  }
  let paperEntryNotionalTargetFrac = parseNumber(env.ORBITALPHA_PAPER_ENTRY_NOTIONAL_TARGET_FRAC, 1);
  if (!Number.isFinite(paperEntryNotionalTargetFrac) || paperEntryNotionalTargetFrac <= 0) paperEntryNotionalTargetFrac = 1;
  paperEntryNotionalTargetFrac = Math.min(1, paperEntryNotionalTargetFrac);

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
  const paperFeeDragWeakShortfallPctMin = parseNumber(env.ORBITALPHA_PAPER_FEE_DRAG_WEAK_SHORTFALL_PCT_MIN, 0.038);
  const paperFeeDragWeakEmRatioMax = parseNumber(env.ORBITALPHA_PAPER_FEE_DRAG_WEAK_EM_RATIO_MAX, 0.55);
  let paperFeeDragTailSizeMult = parseNumber(env.ORBITALPHA_PAPER_FEE_DRAG_TAIL_SIZE_MULT, 0.72);
  if (!Number.isFinite(paperFeeDragTailSizeMult) || paperFeeDragTailSizeMult <= 0) paperFeeDragTailSizeMult = 0.72;
  paperFeeDragTailSizeMult = Math.min(1, paperFeeDragTailSizeMult);
  const paperFeeDragBlockEmRatioMax = parseNumber(env.ORBITALPHA_PAPER_FEE_DRAG_BLOCK_EM_RATIO_MAX, 0.3);
  const paperFeeDragBlockShortfallUsdMin = parseNumber(env.ORBITALPHA_PAPER_FEE_DRAG_BLOCK_SHORTFALL_USD_MIN, 6.5);
  const paperFeeDragBlockShortfallPctMin = parseNumber(env.ORBITALPHA_PAPER_FEE_DRAG_BLOCK_SHORTFALL_PCT_MIN, 0.065);

  const paperFixedTotalCostUsdRaw = env.PAPER_FIXED_TOTAL_COST_USD ?? env.ORBITALPHA_PAPER_FIXED_TOTAL_COST_USD;
  let paperFixedTotalCostUsd: number | null = null;
  if (paperFixedTotalCostUsdRaw !== undefined && String(paperFixedTotalCostUsdRaw).trim() !== "") {
    const x = Number(paperFixedTotalCostUsdRaw);
    if (Number.isFinite(x) && x > 0) paperFixedTotalCostUsd = Math.min(1_000_000, Math.max(0.01, x));
  }
  const okxDemoEnvRequested = parseBool(env.OKX_DEMO_ENABLED, false);
  const okxExchangeAuthOptIn = parseBool(env.ORBITALPHA_OKX_EXCHANGE_ENABLED, false);
  const okxDemoEnabled = okxDemoEnvRequested && okxExchangeAuthOptIn;
  const okxDemoBaseUrl = (env.OKX_DEMO_BASE_URL ?? "https://www.okx.com").trim();
  const okxDemoApiKey = (env.OKX_DEMO_API_KEY ?? "").trim();
  const okxDemoApiSecret = (env.OKX_DEMO_API_SECRET ?? "").trim();
  const okxDemoPassphrase = (env.OKX_DEMO_PASSPHRASE ?? "").trim();

  return {
    symbols: parseSymbols(env.SYMBOLS),
    leverage: parseNumber(env.LEVERAGE, 2),
    longOnly: parseBool(env.LONG_ONLY, false),
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
    paperQualityMinScoreWeak,
    paperMaxOpenPositions,
    paperStrongEmaGapThreshold,
    paperSidewaysEmaGapThreshold,
    paperReentryCooldownMs,
    rangeRebalanceMinHoldMs,
    rangeRebalanceBoxBreakConfirmTicks,
    rangeRebalanceProfitArmPnlPct,
    rangeRebalanceSecuredMinPnlPct,
    rangeRebalanceTrailPullbackSpanFrac,
    rangeRebalanceTrailPullbackMinPriceFrac,
    rangeRebalanceTrailAtrMult,
    rangeRebalanceTrailMaxArmedNoLockMs,
    paperBaseSizeUsd,
    paperAccountEquityUsd,
    paperEntryNotionalTargetFrac,
    paperSlippageBps,
    paperDailyLossLimitUsd,
    paperLast10NetDegradeThresholdUsd,
    paperDegradeSizeMultiplier,
    paperModeLossStreakSuspendCount,
    paperModeLossStreakSoftCount,
    paperModeSuspendMs,
    paperModeHardSuspendMs,
    aiBlockGoodThresholdPct,
    aiBlockMissedThresholdPct,
    aiBlockEvaluationHorizonPriorityMins,
    paperEngineMode,
    paperMinEdgeRr,
    paperMinEdgeVolatilityMove,
    paperFeeDragWeakShortfallPctMin,
    paperFeeDragWeakEmRatioMax,
    paperFeeDragTailSizeMult,
    paperFeeDragBlockEmRatioMax,
    paperFeeDragBlockShortfallUsdMin,
    paperFeeDragBlockShortfallPctMin,
    paperFixedTotalCostUsd,
    okxDemoEnvRequested,
    okxExchangeAuthOptIn,
    okxDemoEnabled,
    okxDemoBaseUrl,
    okxDemoApiKey,
    okxDemoApiSecret,
    okxDemoPassphrase
  };
}

