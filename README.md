# POS System — Backend (API)

The API of a multi-store point of sale for shops and cafés: checkout, stock, transfers, loyalty, wallet cards,
coupons and vouchers, café orders and online ordering, member app, bakery production, cashier controls, riel cash,
X/Z reports, an **integration API** for other systems, and **monitoring with ML anomaly detection** and Telegram
alerts.

| Part | Technology |
|---|---|
| API | Node.js 22, **NestJS 11**, TypeScript |
| Database | **PostgreSQL 16** with Prisma ORM |
| Background jobs and cache | **Redis 7** with BullMQ (webhook delivery) |
| Logs and monitoring | JSON logs (pino), ML anomaly detector (Python, FastAPI, scikit-learn), Telegram alerts |
| Deployment | Docker, Cloudflare Tunnel (`deploy/`) |

The web app is the separate **pos-frontend** project (Vue 3, hosted on Cloudflare Workers). The full feature guide
(how the POS, café mode, wallet, riel cash, X/Z reports… work) is in pos-frontend `docs/FEATURES.md`.

```
pos-backend/
├── prisma/            schema.prisma, migrations, seed.ts (demo data), bootstrap.mjs (first admin)
├── src/               one folder per area: auth, users, stores, products, inventory, sales, shifts, reports,
│                      customers, wallet, coupons, vouchers, promotions, payments (KHQR), kitchen, recipes,
│                      production, online, member, audit, registers (X/Z), integrations, webhooks, common,
│                      logging (JSON logs), monitoring (status, metrics), chaos (test faults, development only)
├── monitoring/        ml-detector: the log anomaly detector (Python); TESTING.md: the 15-minute alert test
├── scripts/           load.mjs (till traffic), chaos.mjs (switch a test fault on / off)
├── test/smoke.mjs     end-to-end test of the whole API
├── deploy/            production: Docker stack, Cloudflare Tunnel, nightly backups (see deploy/README.md)
└── docker-compose.yml PostgreSQL + Redis (+ the detector with --profile monitoring) for development
```

## Deploy to production

See **[deploy/README.md](deploy/README.md)**: one server with Docker (database, API, nightly backups) and Cloudflare
Tunnel for `api.yourcafe.com` with HTTPS, no open ports. The first super admin comes from `ADMIN_EMAIL` /
`ADMIN_PASSWORD`; demo data is not loaded in production.

## Quick start (development)

Requirements: Node.js 20+ and Docker (for PostgreSQL and Redis).

```bash
docker compose up -d
```

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

```bash
npm run dev
```

- API: http://localhost:3000/api/v1
- **Interactive API docs (Swagger): http://localhost:3000/docs**
- Health check: http://localhost:3000/health

The web app (POS, admin, online ordering, member app) is the separate **pos-frontend** project: run it with
`npm run dev` there; it calls this API on `localhost:3000`.

Demo logins (password `Password@123`):

| Email | Role | Stores |
|---|---|---|
| admin@pos.local | SUPER_ADMIN | all |
| manager.pp@pos.local | STORE_MANAGER | PP01, PP02 |
| manager.sr@pos.local | STORE_MANAGER | SR01 |
| cashier1@pos.local / cashier2@ / cashier3@ | CASHIER | PP01 / PP02 / SR01 |

Demo manager approval PINs: manager.pp **2580**, manager.sr **1397**, admin **9024**.

## After pulling new code

New versions often add database tables. Stop the running API first (on Windows the running server locks
Prisma's engine file), then:

```bash
npm install
```

```bash
npm run db:migrate
```

If TypeScript says things like `Property 'walletCard' does not exist on type 'PrismaService'`, the Prisma client is
out of date: stop the API and run `npm run db:generate`.

## Tests

```bash
npm test
```

```bash
npm run db:reset
```

```bash
npm run test:smoke
```

`npm test` runs the unit tests (prices, promotions, coupons, recipes, riel rounding, KHQR, logging and privacy,
monitoring, fault injection). `npm run test:smoke` is the end-to-end test of the whole API (about 300 checks); it
needs the API running on fresh demo data (`npm run db:reset`). The browser tests are in pos-frontend
(`npm run test:monitor` there checks the System monitor page).

The anomaly detector has its own tests (Python 3.12+):

```bash
cd monitoring/ml-detector && pip install -r requirements-dev.txt && pytest
```

## Rules shared with the frontend

The POS calculates prices offline with the same rules as this API. These files have an identical copy in
pos-frontend (`src/shared/`); change both together and run `npm run check:shared` in pos-frontend:

| Here | pos-frontend |
|---|---|
| `src/promotions/engine.ts` | `src/shared/promotions.ts` |
| `src/coupons/calc.ts` | `src/shared/coupons.ts` |
| `src/sales/cash.ts` | `src/shared/cash.ts` |

## KHQR payments (Bakong)

1. On **Stores**, enter the store's **Bakong account ID** (e.g. `myshop@aclb`), the name customers see, city and bank.
   Merchant accounts also enter their merchant ID.
2. At the POS, choose **KHQR → Show KHQR**. A dynamic KHQR for the exact amount appears (valid 5 minutes,
   `KHQR_EXPIRY_MINUTES`). The customer scans it with any Cambodian banking app.
3. Confirmation:
   - `KHQR_MODE=manual` (default): the cashier checks the money arrived and presses **"Customer has paid"**.
   - `KHQR_MODE=bakong` + `BAKONG_TOKEN`: the API asks the Bakong Open API (`/v1/check_transaction_by_md5`)
     every few seconds and the sale completes by itself. The amount and currency are checked.
     Get a token at https://api-bakong.nbc.gov.kh. Managers can still confirm by hand if the API is down.
4. A QR can pay for one sale only, and only after it is paid.

The KHQR payload follows the official NBC `bakong-khqr` SDK; the tests check our generator produces exactly the
same strings as the SDK's own test cases.

## Roles and access

| Role | Can do |
|---|---|
| **SUPER_ADMIN** | Everything in every store: stores, products, prices, users, API keys, webhooks |
| **STORE_MANAGER** | In their stores: stock, transfers, refunds, reports, store prices, manage cashiers |
| **CASHIER** | In their stores: sell, open and close their own shift, look up products and customers |

Every request is checked against the stores the user is assigned to. A cashier in PP01 cannot read or sell in SR01.

## How the important parts work

**Checkout is one database transaction.** `POST /sales` locks the stock rows, takes the items out of stock,
uses and earns loyalty points, assigns the receipt number and saves the payments. Either all of it succeeds or none of it does.

**No overselling.** Stock is reduced with a single atomic SQL `UPDATE ... WHERE quantity >= x`, so two cashiers
can never sell the last item twice. Rows are always locked in the same order, which prevents deadlocks.
Set `ALLOW_NEGATIVE_STOCK=true` to allow selling below zero.

**No double charging.** Send a unique `clientRef` with each sale. If the same sale arrives again
(a network retry or the offline POS syncing), the API returns the first sale instead of creating a new one.

**Stock ledger.** Every stock change (sale, refund, purchase, adjustment, transfer) is written to
`stock_movements` with the balance after it, so stock can always be audited.

**Prices.** Each product has one default price, and a store can override it (`PUT /inventory/:storeId/:productId`).
Prices exclude tax. Each store has its own tax rate, and products can be marked non-taxable.
A sale-level discount is spread across the lines so the tax stays correct (see `src/sales/pricing.ts`).

**Loyalty.** Customers are shared by all stores. They earn `LOYALTY_EARN_RATE` points per 1 currency unit paid,
and each point is worth `LOYALTY_POINT_VALUE` when redeemed. A refund takes back the earned points and returns
the redeemed points proportionally.

**Transfers.** `POST /transfers` takes the stock out of the source store (status IN_TRANSIT).
The destination store confirms with `/receive`, or `/cancel` puts the stock back.

**Shifts.** A cashier opens a shift with the opening cash and closes it with the counted cash.
The API calculates the expected cash (opening + cash sales − change − cash refunds) and the difference.

## Integration API (for other systems)

1. A super admin creates a key with `POST /api/v1/api-keys`:
   ```json
   { "name": "Online shop", "scopes": ["products:read", "inventory:read", "sales:write"], "storeId": "<optional>" }
   ```
   The key (`pos_...`) is shown **once**. Only its SHA-256 hash is stored.
2. The other system sends it in the header: `X-API-Key: pos_...`

Scopes: `stores:read`, `products:read`, `products:write`, `inventory:read`, `inventory:write`,
`customers:read`, `customers:write`, `sales:read`, `sales:write`, `sales:refund`, `reports:read`, `*`.
A key limited to one store cannot touch other stores.

Useful endpoints for integrations:

| Use | Endpoint |
|---|---|
| Sync the product catalogue (up to 1000 per call, matched by SKU) | `POST /products/bulk` |
| Read stock levels | `GET /inventory?storeId=` |
| Receive goods from an ERP | `POST /inventory/adjustments` (type `PURCHASE`) |
| Push online orders | `POST /sales` with `channel: "ONLINE"` and a `clientRef` |
| Export sales to accounting | `GET /sales?from=&to=&storeId=` and `GET /reports/sales-summary` |

### Webhooks

Register a URL with `POST /api/v1/webhooks` to receive events:
`sale.created`, `sale.refunded`, `stock.low`, `stock.adjusted`, `transfer.created`, `transfer.received`, `customer.created` (or `*`).

Deliveries run in the background via Redis and retry up to 6 times with exponential backoff.
Each request is signed so the receiver can verify it:

```
X-POS-Event: sale.created
X-POS-Timestamp: 1767225600
X-POS-Signature: sha256=HMAC_SHA256(secret, "<timestamp>.<raw body>")
```

Delivery history and retries: `GET /webhooks/:id/deliveries` and `POST /webhooks/deliveries/:id/retry`.

## API conventions

- Base path `/api/v1`. Breaking changes will go to `/api/v2`.
- Lists are paginated: `?page=1&limit=50` (max 200). The response is `{ data, meta: { page, limit, total, totalPages } }`.
- Money is returned as strings (`"12.50"`) to avoid floating-point errors. Quantities support 3 decimals (sold by weight).
- Dates are UTC ISO strings. Reports take `from`, `to` (dates) and `tz` (default `REPORT_TIMEZONE`).
- Errors use the format `{ statusCode, message }`.
- Rate limit: `RATE_LIMIT_PER_MINUTE` per login session or API key (not per IP, so many terminals behind one store router work),
  and 10 login attempts per minute per IP.

## Monitoring and anomaly detection

The API writes structured JSON logs; a small ML service reads them, scores every 10 seconds whether the last
30 seconds look normal, explains what is wrong and sends an alert to Telegram. Super admins see everything on the
**System monitor** page of the web app. The detector comes from the thesis project
[cheaphearom/e-commerce](https://github.com/cheaphearom/e-commerce) (`monitoring/ml-detector/ORIGIN.md`).

```
 tills / admin ──► pos-api ──writes──► logs/pos-api.log  (JSON lines, rotated daily / at 100 MB)
                   │  ▲                       │ read-only
                   │  │ /api/v1/monitoring/*  ▼
                   │  └──────────────── ml-detector :8000 (internal network only)
                   │                     │ every 10 s: newest 30-s window → rules, Isolation Forest, PCA
                   │                     │ explanation: service, kind of problem, signals, log lines, store
                   │                     └──► Telegram: one message when a problem starts, one when resolved
                   └──► System monitor page (pos-frontend): status, charts, anomaly scores, alerts
```

### Logs

Every line is JSON in the format of the e-commerce services (`@timestamp`, `level` INFO / WARN / ERROR, `service`
`pos-api` or `pos-worker`, `logger_name`, `message` with `key=value` pairs, the same values as fields, `traceId`):

```json
{"@timestamp":"2026-11-12T06:30:00.123Z","level":"INFO","service":"pos-api","logger_name":"HttpAccess",
 "message":"HTTP request event=http_request method=POST path=/api/v1/sales status=201 durationMs=42",
 "event":"http_request","method":"POST","path":"/api/v1/sales","status":201,"durationMs":42,"traceId":"…"}
```

| Event | Level | When |
|---|---|---|
| `http_request` | INFO / WARN 4xx / ERROR 5xx | every request (not `/health`, monitoring, chaos); ids in paths become `{id}`; `X-Request-Id` is reused or created and returned |
| `unhandled_exception` | ERROR | an unexpected error (with `exception`, `errorMessage`, `stack_trace`); the response is unchanged |
| `sale_completed`, `sale_refunded` | INFO | checkout, refund / void (store, amount, duration) |
| `sale_failed`, `payment_failed` | WARN | a checkout was refused (payment problems: KHQR, wallet, voucher, PIN, cash amount) |
| `stock_adjusted`, `stock_negative` | INFO / WARN | stock adjustment; not enough stock, or stock below zero |
| `shift_opened`, `shift_closed`, `cash_mismatch` | INFO / WARN | shifts; counted cash differs by more than `CASH_MISMATCH_THRESHOLD` |
| `online_order_created`, `login_failed` | INFO / WARN | online orders; wrong password (never the e-mail) |
| `message_processed`, `message_failed` | INFO / WARN | webhook worker (`service=pos-worker`), with `durationMs` |
| `webhook_delivered`, `webhook_failed`, `webhook_retries_exhausted` | INFO / WARN | webhook deliveries (only the receiver's host is logged) |
| `db_query_slow` | WARN | a database query slower than `DB_SLOW_QUERY_MS` (table and statement only, never the SQL values) |

**Privacy:** passwords, tokens, API keys, PINs, card and wallet numbers, phone numbers and e-mails are never
written: such fields are dropped, and e-mails, JWTs, keys and long numbers are masked in any text
(`src/logging/logging.spec.ts` checks this).

### The detector

- **Profile** `DETECTOR_PROFILE=pos`: services `pos-api` and `pos-worker`; per window it counts requests, errors,
  latency (mean, p95, max), webhook job durations, and the business events `sale_completed`, `sale_failed`,
  `payment_failed`, `stock_negative`, `cash_mismatch`, `webhook_failed`, `webhook_retries_exhausted`,
  `login_failed`, `db_query_slow`, plus `sale_success_ratio` and never-seen error messages.
- **Rules** (work without training; each must hold for 3 windows in a row, i.e. ~30 s): `pos-api` 5xx above 5 %
  (with at least 10 requests), `pos-api` p95 above 1500 ms, more than 5 ERROR lines in a service, more than 3
  failed payments, any webhook given up after all retries.
- **ML** (after training on normal traffic): Isolation Forest and PCA (reconstruction error and Hotelling's T²).
  The POS has no labelled faults, so the supervised models (Random Forest, Logistic Regression) stay off unless a
  labels file exists. By default only the **rules and PCA** send alerts (`NOTIFY_METHODS`); Isolation Forest is
  scored and shown, but in the POS a fault moves only a few features and it misses many of them.
- **Explanation**: the suspected service, the kind of problem (slow responses, errors, payment failures, webhook
  delivery failures, slow database, failed sales, many failed logins), the strongest signals against their normal
  level, real log lines, and the store when most failures come from one store.

### Monitoring API (super admins)

| Endpoint | |
|---|---|
| `GET /api/v1/monitoring/status` | API, PostgreSQL (`SELECT 1` time), Redis (PING time), webhook queue (waiting, running, retrying, failed) and detector (reachable, trained, last window), each ok / warn / fail |
| `GET /api/v1/monitoring/metrics?minutes=60` | per minute: requests, 5xx share, p95, sales, failed sales and payments (in memory, this API process) |
| `GET /api/v1/monitoring/scores?minutes=30` | anomaly score and threshold of every detector per window |
| `GET /api/v1/monitoring/alerts` | recent alerts with their explanation |
| `POST /api/v1/monitoring/notify-test` | sends a test message to Telegram |
| `GET /health` (public) | `database` and `redis`: ok / fail (HTTP 503 when one fails) |

The browser never talks to the detector; the API calls it at `DETECTOR_URL` with `DETECTOR_API_KEY`.

### Settings

| Variable | Where | Default | |
|---|---|---|---|
| `LOG_DIR` | API | `./logs` (production: `deploy/logs`) | JSON log files |
| `LOG_LEVEL`, `LOG_MAX_MB`, `LOG_MAX_FILES` | API | `info`, 100, 14 | rotation: daily or at `LOG_MAX_MB`; rolled files are gzipped |
| `DB_SLOW_QUERY_MS` | API | 500 | `db_query_slow` above this |
| `CASH_MISMATCH_THRESHOLD` | API | 1 | `cash_mismatch` above this difference |
| `DETECTOR_URL` | API | `http://localhost:8000` (production: `http://ml-detector:8000`) | |
| `DETECTOR_API_KEY` | API and detector | empty | shared key (`openssl rand -hex 24`); recommended in production |
| `DETECTOR_PROFILE` | detector | `pos` in the compose files | `ecommerce` is the thesis system |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | detector | empty = no Telegram | |
| `NOTIFY_METHODS` | detector | `rules,pca` | detectors that may send alerts |
| `NOTIFY_RESOLVE_AFTER_S` | detector | 60 | seconds without an alert before "resolved" |
| `NOTIFY_MIN_WINDOWS` | detector | 4 | an ML detector must alert this many windows in a row (~40 s) before a message, so one stray error does not page anyone |
| `NOTIFY_TIMEZONE` | detector | production: `TZ` | time zone of the times in the messages |
| `MIN_TRAIN_HOURS` | detector | 24 | warning when trained on less |
| `CHAOS_ENABLED` | API | `false` | test faults; development only (refused in production) |

Real values go in `.env` (development) or `deploy/.env` (production), which git ignores. Never commit them.

### Run it

Development: `docker compose --profile monitoring up -d --build` starts PostgreSQL, Redis and the detector (its
dashboard: http://localhost:8000); run the API with `npm run dev`. Production: add `monitoring` to
`COMPOSE_PROFILES` in `deploy/.env` (see [deploy/README.md](deploy/README.md)); the detector's port is not
published.

### Training

**Train after at least 1 day of normal traffic**, on a period without incidents (windows where the rules fire are
left out automatically). Until then only the rules run.

```bash
docker compose exec ml-detector python -m detector.cli train --hours 24
```

The running detector loads the new models within 10 seconds (kept in `./models`, production `deploy/models`).
Train on 24–48 hours (about 600 MB of memory for one day). Train again after big changes: a new store, new
opening hours, a much busier season. The System monitor shows when it was trained and warns when that was on too
little data.

### Telegram alerts

1. In Telegram, open **@BotFather**, send `/newbot` and follow the steps. Copy the **token**.
2. Open your new bot and send it any message (e.g. `hi`). For a group: add the bot to the group and send a message there.
3. Find the **chat id**: open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy the number at
   `"chat":{"id": ...}` (group ids start with `-`).
4. Put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `deploy/.env` (or `.env` in development).
5. Recreate the detector so it reads them, then press **Send test Telegram message** on the System monitor page:

```bash
docker compose up -d ml-detector
```

Each incident gives **one message when it starts and one when it is resolved**, never one per window. A message
is sent when the rules fire (3 windows in a row) or PCA has alerted for 4 windows in a row (about 40 s):

```
🚨 Anomaly detected in the POS (incident #1)
Time: 2026-11-12 16:09:30 Asia/Phnom_Penh
Detected by: PCA (reconstruction) (18.55)

Suspected service: pos-api
Suspected problem: slow responses
Strongest signals:
• pos-api: mean latency (ms) = 114 ms (normal ≈ 13 ms)
• system: slow database queries = 1 (normal ≈ 0)
ℹ️ the database is answering slowly
Example log lines:
• [pos-api] Slow database query event=db_query_slow model=raw action=SELECT durationMs=3737
```

If Telegram cannot be reached the detector logs a warning, keeps running and sends the message later (after
10 s, 30 s, 1, 2, then every 5 minutes, for up to 6 hours). A wrong token or chat id is reported and not retried.

An incident is resolved by new traffic without alerts: the detector follows the time of the log lines, so a
problem that starts just before closing time is marked resolved when the next requests arrive.

### Testing the alerts

The POS has a development-only fault switch (`CHAOS_ENABLED=true`, refused in production): `LATENCY`, `ERROR` and
`DB_TIMEOUT`, set with `npm run chaos`, while `npm run load` sends realistic till traffic. The 15-minute test
(start, load, train, inject a fault, check Telegram and the System monitor) is in
**[monitoring/TESTING.md](monitoring/TESTING.md)**.

## Scaling notes

- All hot queries are indexed (`store_id + created_at` on sales, stock movements, etc.).
- Large append-only tables (`stock_movements`, `loyalty_transactions`, `webhook_deliveries`) use BigInt ids.
- The API is stateless (JWT), so you can run several instances behind Nginx or a load balancer. Give each instance
  its own `LOG_DIR` (or file) for the detector; the per-minute metrics of the System monitor are per instance.
- When sales reach tens of millions of rows: partition `sales` and `sale_items` by month,
  and point the reports module at a read replica.

