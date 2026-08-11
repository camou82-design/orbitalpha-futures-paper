import { evaluateV2StopLossSubmitAuthority, isV2StopPriceBreached } from "../engine-v2/exit/stop-price-authority";
import {
  evaluateV2ExitSovereigntyGuard,
  type PaperExitCandidateAction
} from "../engine-v2/exit/exit-sovereignty-guard";

function assertTrue(v: boolean, label: string): void {
  if (!v) throw new Error(`${label}: expected true`);
}

function assertFalse(v: boolean, label: string): void {
  if (v) throw new Error(`${label}: expected false`);
}

function assertEq<T>(a: T, b: T, label: string): void {
  if (a !== b) throw new Error(`${label}: expected ${String(b)}, got ${String(a)}`);
}

// CASE A — V2 HOLD + stop not breached + pnl -1.6% → no stop submit
{
  const stop = evaluateV2StopLossSubmitAuthority({
    side: "long",
    mark: 64203.9,
    stopPrice: 64013.26665,
    pnlPctNet: -0.0164,
    slRegime: "TREND",
    isV2Authority: true
  });
  assertFalse(stop.actualStopBreached, "CASE A actual_stop_breached");
  assertFalse(stop.stopSubmitAllowed, "CASE A stop submit blocked");
}

// CASE B — stop price breach allows hard stop
{
  assertTrue(isV2StopPriceBreached("long", 64010, 64013.26665), "CASE B breach");
  const stop = evaluateV2StopLossSubmitAuthority({
    side: "long",
    mark: 64010,
    stopPrice: 64013.26665,
    pnlPctNet: -0.05,
    slRegime: "TREND",
    isV2Authority: true
  });
  assertTrue(stop.stopSubmitAllowed, "CASE B stop submit allowed");
}

// CASE I — legacy stop_loss blocked when V2 HOLD
{
  const guard = evaluateV2ExitSovereigntyGuard({
    symbol: "BTCUSDT",
    side: "long",
    isV2AuthorityPosition: true,
    v2ExitAuthorityAvailable: true,
    v2ShouldExit: false,
    v2ExitAction: "hold",
    paperCandidateAction: "close",
    paperCandidateReason: "stop_loss",
    actualStopBreached: false
  });
  assertFalse(guard.overrideAllowed, "CASE I override blocked");
  assertEq<PaperExitCandidateAction>(guard.effectiveAction, "hold", "CASE I effective hold");
}

// CASE I variant — actual stop breach allows override
{
  const guard = evaluateV2ExitSovereigntyGuard({
    symbol: "BTCUSDT",
    side: "long",
    isV2AuthorityPosition: true,
    v2ExitAuthorityAvailable: true,
    v2ShouldExit: false,
    v2ExitAction: "hold",
    paperCandidateAction: "close",
    paperCandidateReason: "stop_loss",
    actualStopBreached: true
  });
  assertTrue(guard.overrideAllowed, "CASE I breach override allowed");
}

console.log("v2-position-exit-authority-cases: ALL PASS");
