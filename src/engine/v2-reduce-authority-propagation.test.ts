import { evaluateV2ExitExecutionGate } from "../engine-v2/exit/exit-execution-gate";
import { resolveV2ExitAuthorityBooleans } from "./paper-engine";

function assertTrue(v: boolean, label: string): void {
  if (!v) throw new Error(`${label}: expected true`);
}

function assertFalse(v: boolean, label: string): void {
  if (v) throw new Error(`${label}: expected false`);
}

function assertEq<T>(a: T, b: T, label: string): void {
  if (a !== b) throw new Error(`${label}: expected ${String(b)}, got ${String(a)}`);
}

const buildCtx = (input: any) => resolveV2ExitAuthorityBooleans(input);

console.log("=== V2 REDUCE Authority Propagation Tests ===");

// Case A: shouldReduce=true, reason=SHOCK_PROTECTIVE_REDUCE → gate allowed=true
{
  const gate = evaluateV2ExitExecutionGate({
    symbol: "BTCUSDT",
    side: "short",
    requestedAction: "partial_close",
    requestedReason: "SHOCK_PROTECTIVE_REDUCE",
    isV2Managed: true,
    v2ShouldExit: false,
    v2ShouldReduce: true,
    v2ShouldPartial: false,
    actualStopBreached: false,
    actualPositionExists: true
  });
  assertTrue(gate.allowed, "Case A allowed");
}

// Case B1: shouldReduce=false, reason="shock_protective_reduce" (lowercase) → block properly
{
  const ctx = buildCtx({
    reason: "shock_protective_reduce",
    isPartial: true,
    v2ShouldReduce: false
  });
  assertFalse(ctx.v2ShouldReduce, "Case B1 ctx v2ShouldReduce");
}

// Case B2: shouldReduce=false, reason="reduce", isPartial=true → block properly
{
  const ctx = buildCtx({
    reason: "reduce",
    isPartial: true,
    v2ShouldReduce: false
  });
  assertFalse(ctx.v2ShouldReduce, "Case B2 ctx v2ShouldReduce");
}

// Case B3: shouldReduce=undefined, reason="reduce", isPartial=true → allowed (fallback)
{
  const ctx = buildCtx({
    reason: "reduce",
    isPartial: true,
    v2ShouldReduce: undefined
  });
  assertTrue(ctx.v2ShouldReduce, "Case B3 ctx v2ShouldReduce");
}

// Case Partial False: shouldPartial=false, reason="partial", isPartial=true → block properly
{
  const ctx = buildCtx({
    reason: "partial",
    isPartial: true,
    v2ShouldPartial: false
  });
  assertFalse(ctx.v2ShouldPartial, "Case Partial False ctx v2ShouldPartial");
}

// Case Exit False: shouldExit=false, reason="v2_exit" → block properly
{
  const ctx = buildCtx({
    reason: "v2_exit",
    v2ShouldExit: false
  });
  assertFalse(ctx.v2ShouldExit, "Case Exit False ctx v2ShouldExit");
}

// Case C: shouldPartial=true, reason=PARTIAL_TAKE_PROFIT → allowed
{
  const gate = evaluateV2ExitExecutionGate({
    symbol: "BTCUSDT",
    side: "short",
    requestedAction: "partial_close",
    requestedReason: "PARTIAL_TAKE_PROFIT",
    isV2Managed: true,
    v2ShouldExit: false,
    v2ShouldReduce: false,
    v2ShouldPartial: true,
    actualStopBreached: false,
    actualPositionExists: true
  });
  assertTrue(gate.allowed, "Case C allowed");
}

// Case D: shouldExit=true, reason=FULL_EXIT → allowed
{
  const gate = evaluateV2ExitExecutionGate({
    symbol: "BTCUSDT",
    side: "short",
    requestedAction: "close",
    requestedReason: "FULL_EXIT",
    isV2Managed: true,
    v2ShouldExit: true,
    v2ShouldReduce: false,
    v2ShouldPartial: false,
    actualStopBreached: false,
    actualPositionExists: true
  });
  assertTrue(gate.allowed, "Case D allowed");
}

// Case E: actualStopBreached=true → allowed even if shouldReduce/shouldExit=false
{
  const gate = evaluateV2ExitExecutionGate({
    symbol: "BTCUSDT",
    side: "short",
    requestedAction: "close",
    requestedReason: "stop_loss",
    isV2Managed: true,
    v2ShouldExit: false,
    v2ShouldReduce: false,
    v2ShouldPartial: false,
    actualStopBreached: true,
    actualPositionExists: true
  });
  assertTrue(gate.allowed, "Case E allowed");
}

// Case F: shouldExit=false, shouldReduce=false, requestedAction=close → blocked
{
  const gate = evaluateV2ExitExecutionGate({
    symbol: "BTCUSDT",
    side: "short",
    requestedAction: "close",
    requestedReason: "NONE",
    isV2Managed: true,
    v2ShouldExit: false,
    v2ShouldReduce: false,
    v2ShouldPartial: false,
    actualStopBreached: false,
    actualPositionExists: true
  });
  assertFalse(gate.allowed, "Case F allowed");
  assertEq(gate.blockReason, "v2_exit_sovereignty_hold", "Case F blockReason");
}

console.log("=== All Tests Passed! ===");
