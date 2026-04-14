# Minimal patch for EXIT_UNKNOWN crash close reasons

## Goal
Keep trading logic untouched and fix only the finalize/display layer so crash-defense close reasons do not fall through to `EXIT_UNKNOWN` / `기록 없음`.

## Target file
- `src/engine/paper-close-finalize.ts`

## Required changes

### 1) Broaden finalize/display input type
Add a local helper type near the imports:

```ts
type PaperCloseReasonLike = PaperClosedPositionRecord["closeReason"] | string;
```

Change these signatures:

```ts
export function derivePaperCloseSource(
  closeReason: PaperCloseReasonLike,
  exitType: PaperExitType
): PaperCloseSource
```

```ts
export function paperExitDisplayMeta(
  closeReason: PaperCloseReasonLike
): Readonly<{ exitType: PaperExitType; closeReasonLabel: string }>
```

```ts
type FinalizeClosedInput = Readonly<{
  // ...
  closeReason: PaperCloseReasonLike;
  // ...
}>;
```

### 2) Map crash-defense close reasons in `derivePaperCloseSource`
Add these cases:

```ts
case "EXIT_LONG_CRASH_FORCE":
case "EXIT_LONG_CRASH_REDUCE":
  return "CRASH_LONG_DEFENSE";
case "EXIT_SHORT_MOMENTUM_TRAIL":
  return "CRASH_SHORT_MOMENTUM";
case "EXIT_CRASH_FORCE":
case "EXIT_CRASH_REDUCE":
  return "CRASH";
```

### 3) Map crash-defense close reasons in `paperExitDisplayMeta`
Add these cases:

```ts
case "EXIT_LONG_CRASH_FORCE":
  return { exitType: "EXIT_LONG_CRASH_FORCE", closeReasonLabel: defaultLabelForExitType("EXIT_LONG_CRASH_FORCE") };
case "EXIT_LONG_CRASH_REDUCE":
  return { exitType: "EXIT_LONG_CRASH_REDUCE", closeReasonLabel: defaultLabelForExitType("EXIT_LONG_CRASH_REDUCE") };
case "EXIT_SHORT_MOMENTUM_TRAIL":
  return { exitType: "EXIT_SHORT_MOMENTUM_TRAIL", closeReasonLabel: defaultLabelForExitType("EXIT_SHORT_MOMENTUM_TRAIL") };
case "EXIT_CRASH_FORCE":
  return { exitType: "EXIT_CRASH_FORCE", closeReasonLabel: defaultLabelForExitType("EXIT_CRASH_FORCE") };
case "EXIT_CRASH_REDUCE":
  return { exitType: "EXIT_CRASH_REDUCE", closeReasonLabel: defaultLabelForExitType("EXIT_CRASH_REDUCE") };
```

### 4) Improve fallback label
Replace:

```ts
return { exitType: "EXIT_UNKNOWN", closeReasonLabel: "기록 없음" };
```

With:

```ts
const raw = typeof closeReason === "string" && closeReason.trim().length > 0 ? closeReason : "unknown";
return { exitType: "EXIT_UNKNOWN", closeReasonLabel: `미분류 청산 (${raw})` };
```

### 5) Keep output record shape compatible
In `finalizePaperClosedRecord`, keep the record shape and cast only at assignment:

```ts
closeReason: input.closeReason as PaperClosedPositionRecord["closeReason"],
```

## Why this is the minimum-safe fix
- No entry/exit decision logic touched
- No risk logic touched
- Only finalize/display/source mapping layer adjusted
- Unknown future reasons still remain traceable through the fallback label

## Optional follow-up after this patch
For strict type completeness later, add the same crash close reasons to `PaperClosedPositionRecord.closeReason` in `src/models/types.ts`.
That is not required for the immediate display/finalize hotfix if the engine is already casting these reasons into finalize.
