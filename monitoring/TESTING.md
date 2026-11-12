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

In `.env` (the API's development settings, from `.env.example`):

```
CHAOS_ENABLED=true
DETECTOR_URL=http://localhost:8000
TELEGRAM_BOT_TOKEN=<your bot token>
TELEGRAM_CHAT_ID=<your chat id>
NOTIFY_TIMEZONE=Asia/Phnom_Penh
```

(How to get the token and chat id: see "Telegram alerts" in the README.)

## The test

1. Start PostgreSQL, Redis and the detector:

```bash
docker compose --profile monitoring up -d --build
```

2. Fresh demo data (this **deletes** the development database):

```bash
npm run db:reset
```

3. Start the API (it writes its JSON logs to `./logs`, which the detector reads):

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

6. **Minute 7** – train on the traffic so far. The warning about less than 24 hours is expected in a test:

```bash
docker compose exec ml-detector python -m detector.cli train --hours 1
```

7. **Minute 8** – a database problem for 2 minutes:

```bash
npm run chaos -- DB_TIMEOUT --duration 120
```

   Within about 30 seconds Telegram gets **"🚨 Anomaly detected in the POS"** naming `pos-api` and a database
   problem, with the strongest signals and real error lines. The System monitor page shows the scores above
   their dashed line and the alert in "Recent alerts".

8. **Minute 10** – the fault ends by itself. About a minute later Telegram gets **"✅ Resolved in the POS"**.

9. Optional, **minute 12** – errors for 90 seconds, a second incident:

```bash
npm run chaos -- ERROR --rate 0.3 --duration 90
```

10. Afterwards: `npm run chaos -- off` stops a fault early, and `npm run chaos -- status` shows the current one.
    Set `CHAOS_ENABLED=false` again. The model in `./models` was trained on test traffic only: never copy it to a
    server (production trains on its own, real traffic).

Other faults: `npm run chaos -- LATENCY --latency 2500 --duration 90`.
