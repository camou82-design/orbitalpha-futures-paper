import type { PaperOpenPositionRecord } from "../models/types";
import {
  computePaperCloseLegMetrics,
  resolveCloseLegMarginUsdForRecord,
  resolveCloseLegSizing,
  resolveOpenMarginUsd,
  resolveOpenNotionalUsd
} from "./paper-close-finalize";
import { deriveLiveBalanceAuthority } from "../engine-v2/live-account/balance-authority";

function assertNear(a: number, b: number, eps: number, label: string): void {
  if (Math.abs(a - b) > eps) {
    throw new Error(`${label}: expected ${b}, got ${a} (eps=${eps})`);
  }
}

function assertEq<T>(a: T, b: T, label: string): void {
  if (a !== b) throw new Error(`${label}: expected ${String(b)}, got ${String(a)}`);
}

function v2Open(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
  return {
    symbol: "BTCUSDT",
    side: "short",
    openedAt: 1_000_000,
    entryPrice: 64204.5,
    avgPx: 64204.5,
    sizeUsd: 102.7272,
    leverage: 10,
    isV2Authority: true,
    authoritySourceAtEntry: "v2",
    exchangeClOrdId: "pBTCUSDTsabc",
    strategyVersion: "paper-v2",
    ...overrides
  } as PaperOpenPositionRecord;
}

function legacyOpen(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
  return {
    symbol: "ETHUSDT",
    side: "long",
    openedAt: 1_000_000,
    entryPrice: 1900,
    avgPx: 1900,
    sizeUsd: 20,
    leverage: 10,
    isV2Authority: false,
    strategyVersion: "paper-v1",
    sourceSignal: "legacy",
    ...overrides
  } as PaperOpenPositionRecord;
}

function runCases(): void {
  const feeRate = 0.0006;
  const closedAt = 1_000_000 + 3_600_000;

  // 1. V2 round-trip fee
  {
    const open = v2Open();
    const m = computePaperCloseLegMetrics({
      open,
      closePrice: 64213.9,
      closedAt,
      snapFundingRate: 0,
      legSizeUsd: 102.7272,
      paperTakerFeeRate: feeRate,
      paperFundingIntervalHours: 8
    });
    assertNear(m.feeUsd, 0.12327264, 1e-9, "ACCT-1 fee");
  }

  // 2. BTC short gross/net
  {
    const open = v2Open();
    const m = computePaperCloseLegMetrics({
      open,
      closePrice: 64213.9,
      closedAt,
      snapFundingRate: 0,
      legSizeUsd: 102.7272,
      paperTakerFeeRate: feeRate,
      paperFundingIntervalHours: 8
    });
    assertNear(m.pnlUsdGross, -0.0150422997, 1e-5, "ACCT-2 gross");
    assertNear(m.pnlUsdNet, -0.1383149397, 1e-5, "ACCT-2 net");
  }

  // 3. V2 pnlPctNet uses margin denominator (leveraged ROI preserved)
  {
    const open = v2Open();
    const m = computePaperCloseLegMetrics({
      open,
      closePrice: 64213.9,
      closedAt,
      snapFundingRate: 0,
      legSizeUsd: 102.7272,
      paperTakerFeeRate: feeRate,
      paperFundingIntervalHours: 8
    });
    const margin = resolveOpenMarginUsd(open);
    assertNear(margin, 10.27272, 1e-6, "ACCT-3 margin");
    assertNear(m.pnlPctNet, m.pnlUsdNet / margin, 1e-12, "ACCT-3 pct identity");
    const wrongPct = m.pnlUsdNet / open.sizeUsd;
    assertTrue(m.pnlPctNet !== wrongPct, "ACCT-3 pct not notional denominator");
  }

  // 4. legacy margin-based case unchanged
  {
    const open = legacyOpen();
    const legacy = computePaperCloseLegMetrics({
      open,
      closePrice: 1920,
      closedAt,
      snapFundingRate: 0,
      marginUsd: 20,
      sizeUnit: "LEGACY_MARGIN",
      paperTakerFeeRate: 0.0005,
      paperFundingIntervalHours: 8
    });
    assertNear(legacy.feeUsd, (20 * 10 + 20 * 10) * 0.0005, 1e-9, "ACCT-4 legacy fee");
    assertNear(legacy.pnlUsdGross, ((1920 - 1900) / 1900) * 200, 1e-9, "ACCT-4 legacy gross");
    assertNear(legacy.pnlPctNet, legacy.pnlUsdNet / 20, 1e-12, "ACCT-4 legacy pct");
  }

  // 5. V2 partial 50%
  {
    const open = v2Open();
    const half = 102.7272 * 0.5;
    const m = computePaperCloseLegMetrics({
      open,
      closePrice: 64213.9,
      closedAt,
      snapFundingRate: 0,
      legSizeUsd: half,
      paperTakerFeeRate: feeRate,
      paperFundingIntervalHours: 8
    });
    const full = computePaperCloseLegMetrics({
      open,
      closePrice: 64213.9,
      closedAt,
      snapFundingRate: 0,
      legSizeUsd: 102.7272,
      paperTakerFeeRate: feeRate,
      paperFundingIntervalHours: 8
    });
    assertNear(m.feeUsd, full.feeUsd * 0.5, 1e-9, "ACCT-5 partial fee half");
    assertNear(m.pnlUsdGross, full.pnlUsdGross * 0.5, 1e-9, "ACCT-5 partial gross half");
    assertNear(resolveCloseLegSizing(open, half).legMarginUsd, resolveOpenMarginUsd(open) * 0.5, 1e-9, "ACCT-5 partial margin half");
  }

  // 6. two partial legs fee sum ~= one full close fee (no double leverage)
  {
    const open = v2Open();
    const half = 102.7272 * 0.5;
    const m1 = computePaperCloseLegMetrics({
      open,
      closePrice: 64210,
      closedAt,
      snapFundingRate: 0,
      legSizeUsd: half,
      paperTakerFeeRate: feeRate,
      paperFundingIntervalHours: 8
    });
    const m2 = computePaperCloseLegMetrics({
      open,
      closePrice: 64213.9,
      closedAt,
      snapFundingRate: 0,
      legSizeUsd: half,
      paperTakerFeeRate: feeRate,
      paperFundingIntervalHours: 8
    });
    const full = computePaperCloseLegMetrics({
      open,
      closePrice: 64213.9,
      closedAt,
      snapFundingRate: 0,
      legSizeUsd: 102.7272,
      paperTakerFeeRate: feeRate,
      paperFundingIntervalHours: 8
    });
    assertNear(m1.feeUsd + m2.feeUsd, full.feeUsd, 1e-9, "ACCT-6 partial fee sum");
    assertTrue(m1.feeUsd + m2.feeUsd < full.feeUsd * 1.01, "ACCT-6 no 10x fee inflation");
  }

  // 7. funding uses V2 notional 1x
  {
    const open = v2Open({ openFundingRate: 0.0001 });
    const m = computePaperCloseLegMetrics({
      open,
      closePrice: 64213.9,
      closedAt: 1_000_000 + 8 * 3_600_000,
      snapFundingRate: 0.0001,
      legSizeUsd: 102.7272,
      paperTakerFeeRate: feeRate,
      paperFundingIntervalHours: 8
    });
    const expectedFunding = 102.7272 * 0.0001 * 1;
    assertNear(m.fundingUsd, expectedFunding, 1e-9, "ACCT-7 funding notional 1x");
    const wrongFunding = 102.7272 * 10 * 0.0001;
    assertTrue(Math.abs(m.fundingUsd - wrongFunding) > 1e-6, "ACCT-7 funding not 10x");
  }

  // 8. gross - fee - funding == net
  {
    const open = v2Open({ openFundingRate: 0.00005 });
    const m = computePaperCloseLegMetrics({
      open,
      closePrice: 64213.9,
      closedAt: 1_000_000 + 4 * 3_600_000,
      snapFundingRate: 0.00005,
      legSizeUsd: 102.7272,
      paperTakerFeeRate: feeRate,
      paperFundingIntervalHours: 8
    });
    assertNear(m.pnlUsdGross - m.feeUsd - m.fundingUsd, m.pnlUsdNet, 1e-12, "ACCT-8 identity");
  }

  // 9. balance-authority and close-metrics share V2 notional authority
  {
    const open = v2Open();
    const notional = resolveOpenNotionalUsd(open);
    const bal = deriveLiveBalanceAuthority({
      okxAuthMode: "disabled",
      balancePayload: null,
      balanceFetchError: null,
      okxPositionsPayload: null,
      positions: [{ 
        symbol: "BTCUSDT", 
        side: "short", 
        sizeUsd: open.sizeUsd, 
        leverage: 10,
        isV2Authority: open.isV2Authority,
        authoritySourceAtEntry: open.authoritySourceAtEntry
      }]
    });
    assertNear(notional, 102.7272, 1e-9, "ACCT-9 open notional");
    assertNear(bal.paper_position_estimated_notional_usdt, 102.7272, 1e-9, "ACCT-9 balance notional");
    assertNear(bal.paper_position_estimated_used_margin_usdt, 10.27272, 1e-6, "ACCT-9 balance margin");
    const sizing = resolveCloseLegSizing(open, open.sizeUsd);
    assertNear(sizing.legNotionalUsd, notional, 1e-9, "ACCT-9 close leg notional");
    assertNear(resolveCloseLegMarginUsdForRecord(open, open.sizeUsd), 10.27272, 1e-6, "ACCT-9 close record margin");
  }
}

function assertTrue(v: boolean, label: string): void {
  if (!v) throw new Error(`${label}: expected true`);
}

runCases();
console.log("paper-close-metrics-cases: ALL PASS");
