# orbitalpha-futures-paper

Bybit USDT perpetual futures **paper trading (simulation-only)** engine skeleton.

## Scope

- **Paper trading only** (no live trading, no authenticated endpoints, no order sending)
- TypeScript 기반, 콘솔/로그 중심 (UI 없음)
- 기존 `orbitalpha-trading` 및 현물 엔진과 **완전 분리된 새 프로젝트**

## First milestone (1차 목표)

- BTCUSDT, ETHUSDT 선물 모의 감시
- 레버리지 2배 가정
- 롱 전용으로 먼저 시작
- 손절/익절/수수료/펀딩비 반영
- JSON 로그 저장

## Quick start

```bash
npm install
npm run build
npm start
```

## Project structure

See `docs/` and `src/` for placeholders and notes.

Snapshots are saved to `data/snapshots/{timestamp}.json` and also overwritten to `data/snapshots/latest.json`.
Metadata for the latest run is overwritten to `data/snapshots/latest-meta.json`.

`latest-meta.json` includes public API diagnostics (HTTP status, Bybit `retCode`/`retMsg`, full request URLs) per symbol and per endpoint type for faster failure triage.

`requestDiagnostics.bySymbol` groups ticker/kline/funding slices per symbol (e.g. `BTCUSDT`, `ETHUSDT`) so partial failures are easy to compare side-by-side.

When any symbol fails, `failureSummary` lists a short per-symbol entry (primary `failedEndpoint`, reason, and a `diagnosticRef` path into `requestDiagnostics`) for quick triage; it is empty `{}` when all symbols succeed.

Paper strategy v0 (`strategyVersion: paper-v0`) adds 1m EMA20/EMA60 trend + long-only entry hints on each snapshot row (`ema20`, `ema60`, `trendOk`, `entryCandidate`, `signal`); see `latest-meta.json` → `signalSummary`.

When any snapshot has `signal === "paper_long_candidate"`, an extra file is written under `data/runs/{timestamp}.json` (candidate runs only; no file if there are no candidates). That file may include `latestSnapshotPath`, `latestMetaPath`, and `timestampSnapshotPath` so related snapshot files are discoverable from one place.

`data/runs/index.json` is updated together with each new candidate run and lists the latest candidate runs (newest first, capped) for quick scanning without opening every run file.

Each index item may include `latestSnapshotPath` and `latestMetaPath` (absolute paths to `snapshots/latest.json` and `snapshots/latest-meta.json` at the time of that run) when those files were written successfully.

`timestampSnapshotPath` may point to the immutable `snapshots/{fetchedAt}.json` written for that same run.

Paper positions (simulated only): `data/positions/history.json` is ensured as `[]` on each run; `data/positions/open.json` is a JSON array of open long positions (up to `ORBITALPHA_PAPER_MAX_OPEN_POSITIONS`, default 3). When a `paper_long_candidate` is saved as a candidate run and capacity allows, new opens are appended per symbol. If a symbol’s signal is no longer `paper_long_candidate`, that leg is closed, appended to history, and removed from the array (or the file becomes `[]`).

On close, recorded `pnlUsd` / `pnlUsdNet` is **after** a simple round-trip **taker** fee (configurable via `ORBITALPHA_PAPER_FUTURES_TAKER_FEE_RATE`, default `0.0006`) applied to open and close notionals (`sizeUsd * leverage` each). `pnlUsdGross` is the raw mark-to-market before fees.

Funding uses **v3 avg_open_close_rate**: average of **open** `openFundingRate` and **close** snapshot `fundingRate` (if close is invalid, falls back to the open rate or 0), then `fundingUsd = sizeUsd × leverage × fundingRateAverage × fundingPeriods` with `fundingPeriods = holdingMs / (fundingIntervalHours × 3600000 ms)` (default 8h, env `ORBITALPHA_PAPER_FUTURES_FUNDING_INTERVAL_HOURS`). Still an approximation (no per-interval rate history).

Each `runOnce` overwrites `data/reports/summary.json` with aggregate stats (PnL, fees, funding, win rate, per-symbol counts, etc.) derived from the full `positions/history.json` (safe when history is empty). The same run also writes `data/reports/summary-daily.json`: the same metrics grouped by UTC calendar day using each trade’s `closedAt` (`days` keys are `YYYY-MM-DD`). `data/reports/summary-window.json` adds rolling windows (`last7d`, `last30d`, `monthToDate`, `all`) using `closedAt` against the same report `generatedAt` (UTC month for MTD). `data/reports/summary-health.json` derives a simple operational status (`healthy` / `weak` / `cold` / `insufficient-data`) from the window report plus fixed thresholds.

