# Deploy with Cloudflare

One small server runs the API, database and backups in Docker; **Cloudflare Tunnel** puts the API on your domain
(e.g. `api.yourcafe.com`) with HTTPS. No port is opened on the server: the tunnel connects out to Cloudflare.
The web app is the separate **pos-frontend** project on Cloudflare Workers; set its `API_ORIGIN` to this address.

```
 phones / tills / admin ──HTTPS──► pos-frontend (Cloudflare Worker) ──/api──► Cloudflare tunnel ──► cloudflared ──► api ──► postgres, redis
                                                                                                                  backup (nightly) ──► R2 (optional)
```

| Container | What it does |
|---|---|
| `api` | NestJS API. On start: database migrations, then the first admin (empty database only) |
| `postgres`, `redis` | Data and background jobs. Not reachable from outside |
| `cloudflared` | Cloudflare Tunnel (turned on with `COMPOSE_PROFILES=tunnel`) |
| `backup` | `pg_dump` every night into `deploy/backups`, kept 14 days |
| `backup-r2` | Optional hourly copy of the backups to Cloudflare R2 (`COMPOSE_PROFILES=tunnel,r2`) |

## 1. Server

Any VPS with Ubuntu 22.04 / 24.04, 2 CPU and 2–4 GB memory (DigitalOcean, Vultr, Hetzner, AWS Lightsail…).
A server in Singapore is close to Cambodia.

```bash
curl -fsSL https://get.docker.com | sh
```

```bash
git clone git@github.com:cheaphearom/pos-backend.git
```

```bash
cd pos-backend/deploy && cp .env.example .env
```

## 2. Cloudflare

1. Add your domain to Cloudflare (free plan is enough) and change the domain's name servers to the two Cloudflare
   shows you.
2. **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**, name it `pos`.
   On the "Install connector" step, copy the **token** (the long text after `--token`). You do not need to run the
   command shown there: Docker runs it.
3. **Public hostname**: subdomain `api`, your domain, **Service type `HTTP`, URL `api:3000`** → Save.
   Then in the **pos-frontend** Worker set `API_ORIGIN` = `https://api.yourcafe.com`.
4. Recommended (Cloudflare dashboard of the domain):
   - **SSL/TLS → Edge Certificates → Always Use HTTPS**: on.
   - **Caching → Cache Rules**: "Bypass cache" when *URI Path starts with* `/api/`.
   - **Security → WAF → Rate limiting rules** (optional): limit `/api/v1/auth/login` and `/api/v1/public/member/otp`
     to about 20 requests per minute per IP. The API limits them too.
   - Do not turn on "Under Attack" mode or Bot Fight Mode for `/api/`: tills and integrations call it without a browser
     challenge.

## 3. Settings: `deploy/.env`

Fill in at least:

| Setting | Value |
|---|---|
| `PUBLIC_URL` | `https://api.yourcafe.com` (this API) |
| `CORS_ORIGINS` | the web app's address(es), e.g. `https://pos.yourcafe.com` |
| `CLOUDFLARE_TUNNEL_TOKEN` | the token from step 2 |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `JWT_ACCESS_SECRET`, `MEMBER_JWT_SECRET` | `openssl rand -hex 32` (each a different value) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | the first super admin (password 10+ characters) |
| `MEMBER_OTP_WEBHOOK_URL` | your SMS gateway, for member app login codes (see the main README) |
| `KHQR_MODE`, `BAKONG_TOKEN` | `bakong` + token for automatic KHQR checks, or keep `manual` |

`deploy/.env` holds secrets: it is ignored by git, never commit it.

## 4. Start

```bash
docker compose up -d --build
```

```bash
docker compose ps
```

All containers should be `healthy` / `Up` within about a minute. Check `https://api.yourcafe.com/health`, then open
the web app (pos-frontend), log in with
`ADMIN_EMAIL`, **change the password**, and remove `ADMIN_PASSWORD` from `deploy/.env`.
Create your stores (Stores page: tax, riel rate, café mode, KHQR account…), users and products.

Check the server alone, without Cloudflare: `curl http://127.0.0.1:3000/health` on the server.

## ML anomaly detector (optional)

The `ml-detector` container reads the API's JSON logs (`deploy/logs`, read-only), scores the newest 30-second window
every 10 s with fixed rules, Isolation Forest and PCA, and can send alerts to Telegram. It has no published port:
only the API reaches it, on the internal Docker network. It needs about 200 MB, plus about 600 MB while training on
one day of logs (limit: 1.5 GB). Check that the server has room: `free -h`.

1. In `deploy/.env`: add `monitoring` to `COMPOSE_PROFILES` (e.g. `COMPOSE_PROFILES=tunnel,monitoring`), set
   `DETECTOR_API_KEY` (`openssl rand -hex 24`) and, for alerts, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
2. Start it:

```bash
docker compose up -d --build
```

3. Until it is trained only the rules run (5xx share, slow responses, ERROR lines, failed payments, webhooks given
   up). **Train after at least 1 day of normal traffic**, choosing a period without incidents. Windows where the
   rules fire are left out of the training automatically:

```bash
docker compose exec ml-detector python -m detector.cli train --hours 24
```

   The running detector loads the new models within 10 seconds; they are kept in `deploy/models`. Train on 24–48
   hours (a week needs more memory than the container is given). Train again after big changes: a new store,
   new opening hours, a much busier season.

4. Status:

```bash
docker compose exec ml-detector python -c "import json,urllib.request,os; r=urllib.request.Request('http://127.0.0.1:8000/health',headers={'X-API-Key':os.environ.get('DETECTOR_API_KEY','')}); print(json.dumps(json.load(urllib.request.urlopen(r)),indent=1))"
```

Alerts go to Telegram once when a problem starts and once when it is resolved (no alert for
`NOTIFY_RESOLVE_AFTER_S`, default 60 s), with the suspected service (`pos-api` or `pos-worker`), the kind of problem,
the strongest signals, example log lines and, when most failures come from one store, the store. Times are in `TZ`.
If Telegram cannot be reached the detector keeps running and sends the message later. Test it:

```bash
docker compose exec ml-detector python -c "import os,urllib.request; r=urllib.request.Request('http://127.0.0.1:8000/notify/test',method='POST',headers={'X-API-Key':os.environ.get('DETECTOR_API_KEY','')}); print(urllib.request.urlopen(r).read().decode())"
```

(or the "Send test Telegram message" button on the System monitor page of the web app).

Stopping it (`docker compose stop ml-detector`) has no effect on the POS.

## Updating to a new version

```bash
cd ~/pos-backend && git pull
```

```bash
cd deploy && docker compose up -d --build
```

Database changes are applied automatically when the API starts.

## Backups

- Every night at `BACKUP_TIME` (03:30 Cambodia time by default) into `deploy/backups/pos-YYYYMMDD-HHMMSS.sql.gz`,
  kept `BACKUP_KEEP_DAYS` days.
- **Copy to Cloudflare R2** (recommended, so a backup survives losing the server): create a bucket, then
  *R2 → Manage API tokens → Create API token* (Object Read & Write, that bucket). Put `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` in `deploy/.env` and set `COMPOSE_PROFILES=tunnel,r2`.
- Backup now:

```bash
docker compose exec backup sh /backup.sh once
```

- Restore (replaces **all** current data with the backup; stop the tills first):

```bash
docker compose exec backup sh /backup.sh restore /backups/pos-20260101-033000.sql.gz
```

## Useful commands

```bash
docker compose logs -f api
```

```bash
docker compose restart api
```

```bash
docker compose exec postgres psql -U pos -d pos
```

## Notes

- **HTTPS is required** for customers' phones (online ordering, member app) and for the POS to work offline (service
  worker). Cloudflare gives you HTTPS automatically.
- The database stores times in UTC; reports and Z reports use `REPORT_TIMEZONE`.
- Tested: the image builds, a fresh database gets its migrations and first admin, every container becomes healthy, the
  whole backend test passes, and backup + restore work. The Cloudflare Tunnel itself needs your Cloudflare account.
