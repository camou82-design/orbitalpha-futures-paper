# lightsail-futures-paper-api

Read-only HTTP API that exposes `data/reports/*.json`, `data/snapshots/latest*.json`, and `health-history.jsonl` as one JSON bundle (same shape as orbitalpha.kr `/api/futures-paper/data`).

**Full deploy:** [DEPLOY.md](./DEPLOY.md)

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| GET | `/health` | none |
| GET | `/api/futures-paper/data` | Header `x-orbitalpha-futures-paper-token: <secret>` |

## Shared code

- `../src/lib/futuresPaperBundleCore.ts` — disk bundle builder
- `../src/lib/futuresPaperRead.ts` — same logic as homepage (remote fetch vs disk); used when copying into Next.js app
