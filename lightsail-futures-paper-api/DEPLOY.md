# paper-api.orbitalpha.kr — Lightsail + Nginx + Vercel

This repository (`camou82-design/orbitalpha-futures-paper`) contains the paper engine **and** this API. `orbitalpha-trading` is unrelated.

## 0. Paths on Lightsail

- Repo clone: `/home/admin/orbitalpha-futures-paper`
- API app: `/home/admin/orbitalpha-futures-paper/lightsail-futures-paper-api`

## 1. DNS

| Name | Type | Value |
|------|------|--------|
| `paper-api` | A | `<LIGHTSAIL_PUBLIC_IP>` |

## 2. Lightsail firewall

Allow TCP **22, 80, 443**.

## 3. Install & PM2

```bash
cd /home/admin/orbitalpha-futures-paper
git pull origin main
cd lightsail-futures-paper-api
npm ci
```

Edit `ecosystem.config.cjs`: set `ORBITALPHA_FUTURES_PAPER_API_SECRET` (and `ORBITALPHA_FUTURES_PAPER_ROOT` if your clone path differs).

```bash
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup   # run the command it prints once
```

## 4. Nginx + Certbot

Use `nginx-paper-api.orbitalpha.kr.conf.example`. Issue TLS (e.g. `certbot --nginx -d paper-api.orbitalpha.kr`), then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 5. Vercel (orbitalpha.kr homepage)

Production env:

| Name | Value |
|------|--------|
| `ORBITALPHA_FUTURES_PAPER_API_URL` | `https://paper-api.orbitalpha.kr` |
| `ORBITALPHA_FUTURES_PAPER_API_SECRET` | same as `ecosystem.config.cjs` |

Redeploy homepage.

## 6. Verify

```bash
curl -sS https://paper-api.orbitalpha.kr/health
curl -sS -H "x-orbitalpha-futures-paper-token: <SECRET>" \
  https://paper-api.orbitalpha.kr/api/futures-paper/data | head -c 500
```
