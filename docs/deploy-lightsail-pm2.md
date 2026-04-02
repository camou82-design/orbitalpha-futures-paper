# Lightsail: orbitalpha-futures-paper (paper only)

**Do not** stop or restart existing Upbit (`orbitalpha-trading`) processes. **Do not** run `pm2 restart all`. Add this app only.

## 1. Deploy code (separate directory)

```bash
mkdir -p ~/orbitalpha-futures-paper
# copy or git clone this repo into ~/orbitalpha-futures-paper (not inside orbitalpha-trading)
cd ~/orbitalpha-futures-paper
npm install
npm run build
```

## 2. `.env` (futures-paper only — no Upbit keys)

Copy from `.env.example` and tune:

- `DATA_DIR=./data` (default; keeps state under this project)
- `ORBITALPHA_PAPER_LOOP_INTERVAL_MS` — e.g. `120000` (2 min) or `300000` (5 min); avoid very short intervals on small instances
- No exchange API secrets required (public Bybit endpoints only)

```bash
cp .env.example .env
nano .env   # set NODE_ENV=production, ORBITALPHA_PAPER_LOOP_INTERVAL_MS, LOG_LEVEL, etc.
```

## 3. pm2 (new process only)

```bash
cd ~/orbitalpha-futures-paper
pm2 start ecosystem.futures-paper.config.cjs
pm2 save
```

- App name: `orbitalpha-futures-paper-loop`
- Logs: `pm2 logs orbitalpha-futures-paper-loop`

## 4. Verify (read-only checks)

```bash
pm2 list
pm2 logs orbitalpha-futures-paper-loop --lines 80
ls -la data/reports/
```

Expected under `data/reports/`: `summary.json`, `summary-daily.json`, `summary-window.json`, `summary-health.json`, `dashboard.json`, `health-history.jsonl` updating over time.

## 5. Never

- `pm2 restart all`
- Editing `orbitalpha-trading` or its env for this app
- Sharing env files between Upbit trading and this project
