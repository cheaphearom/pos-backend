# Testing the alerts in 15 minutes (development only)

The POS has a **development-only** fault switch so you can check that the anomaly detector, the System monitor
page and Telegram alerts work. It exists only when the API runs with `CHAOS_ENABLED=true`; the API refuses to
start with that in production (`NODE_ENV=production`), and `deploy/docker-compose.yml` forces it off.

| Fault | What happens to every API request | Defaults |
|---|---|---|
| `LATENCY` | waits about `latencyMs` (±25 %) | 2000 ms |
| `ERROR` | `errorRate` of the requests fail with an unexpected error (HTTP 500) | 30 % |
| `DB_TIMEOUT` | holds a database connection for about `latencyMs` (`SELECT pg_sleep`), and `errorRate` of the requests fail with Prisma's connection-pool timeout (P2024) | 3000 ms, 40 % |

A fault ends by itself after `durationSec` (default 120). The faults write no log lines of their own: the
detector only sees their effects (slow requests, 5xx, unhandled exceptions, slow queries), as in a real
incident. Login checks still apply, and `/health`, `/api/v1/monitoring/*` and `/api/v1/chaos` are never affected.

## Once: settings

In `.env` of this project (the API's development settings, from `.env.example`):

```
CHAOS_ENABLED=true
DETECTOR_URL=http://localhost:8000
DETECTOR_API_KEY=<a key>
```

In `.env` of the [ml-detector](https://github.com/cheaphearom/ml-detector) project: `GRAFANA_ADMIN_PASSWORD`, the same
`DETECTOR_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (how to get them: its README) and
`NOTIFY_TIMEZONE=Asia/Phnom_Penh`.

## The test

1. In the ml-detector folder, start Loki, Grafana and the detector, reachable from this computer:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

   Then here, start PostgreSQL, Redis and Alloy (which ships `./logs` to Loki):

```bash
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d
```

2. Fresh demo data (this **deletes** the development database):

```bash
npm run db:reset
```

3. Start the API (it writes its JSON logs to `./logs`; Alloy sends them to Loki, where the detector reads them):

```bash
npm run dev
```

4. Optional: start the web app (pos-frontend, `npm run dev`), log in as `admin@pos.local` / `Password@123`
   and open **System monitor**.

5. **Minute 0** – start 15 minutes of till traffic in a second terminal (3 cashiers selling, 2 managers
   refunding, restocks, the odd wrong password):

```bash
npm run load -- --minutes 15
```

6. **Minute 7** – train on the traffic so far, in the ml-detector folder. The warning about less than 24 hours is
   expected in a test:

```bash
docker compose exec ml-detector python -m detector.cli train --hours 1
```

7. **Minute 8** – a database problem for 2 minutes:

```bash
npm run chaos -- DB_TIMEOUT --duration 120
```

   Within about a minute Telegram gets **"🚨 Anomaly detected in the POS"** naming `pos-api`, "slow responses;
   slow database", the strongest signals (e.g. p95 3356 ms, normal ≈ 35 ms) and real error lines (Prisma's
   connection-pool timeout). The System monitor page shows the scores above their dashed line, the error rate and
   p95 charts jump, and the alert is in "Recent alerts".

8. **Minute 10** – the fault ends by itself. One to three minutes later Telegram gets **"✅ Resolved in the POS"**:
   the last slow requests of the fault still finish with errors for a short while, and with only 7 minutes of
   training PCA is very sensitive.

9. Optional, **minute 12** – errors for 90 seconds. It is a second incident only when the first one was already
   resolved; otherwise it is reported as part of it (one message per incident):

```bash
npm run chaos -- ERROR --rate 0.3 --duration 90
```

10. Afterwards: `npm run chaos -- off` stops a fault early, and `npm run chaos -- status` shows the current one.
    Set `CHAOS_ENABLED=false` again. The model in the ml-detector `./models` folder was trained on test traffic
    only: never copy it to a server (production trains on its own, real traffic). Grafana (http://localhost:3001,
    dashboard "POS logs") shows the same incident in the logs.

Other faults: `npm run chaos -- LATENCY --latency 2500 --duration 90`.

## A real run (12 November 2026)

| Time (UTC) | |
|---|---|
| 09:16:4x | load starts: 3 cashiers, 2 managers (≈ 26 sales per minute) |
| 09:23:2x | trained on 7 minutes of logs (66 windows) |
| 09:23:4x | `DB_TIMEOUT` for 120 s |
| 09:23:57 | 🚨 Telegram: `pos-api`, "slow responses; slow database", p95 3356 ms (normal ≈ 35 ms), pool-timeout error lines |
| 09:27:45 | `ERROR` 30 % for 90 s (the first incident was still open: same incident) |
| 09:30:38 | ✅ Telegram: resolved, alerting lasted 5.7 min, detected by PCA and the rules |

The load kept running through both faults: 1613 requests, 393 sales, 22 refunds, 85 failed requests. (The run
was before the 4-window wait for ML alerts; with it the first message comes about 30 s later.)
