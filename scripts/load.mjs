#!/usr/bin/env node
// Realistic till traffic for testing the monitoring and the anomaly detector.
//
//   node scripts/load.mjs --minutes 15
//
// Every seeded cashier logs in, opens a shift and sells: barcode scans, the odd product search or member
// lookup, a checkout paid in cash. Store managers look at the dashboard and refund a sale now and then; the
// admin restocks products that run out. Now and then someone mistypes a password.
// Needs the demo data (npm run db:seed). Options: --minutes N (default 10), --rate N (sales per minute per
// cashier, default 10), --api URL (default API_URL or http://localhost:3000/api/v1), --password P.
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? 'true' : all[i + 1]]] : acc), []),
);
const API = (args.api ?? process.env.API_URL ?? 'http://localhost:3000/api/v1').replace(/\/$/, '');
const MINUTES = Number(args.minutes ?? 10);
const RATE = Number(args.rate ?? 10);
const PASSWORD = args.password ?? 'Password@123';
const CASHIERS = ['cashier1@pos.local', 'cashier2@pos.local', 'cashier3@pos.local'];
const MANAGERS = ['manager.pp@pos.local', 'manager.sr@pos.local'];
const ADMIN = 'admin@pos.local';

const end = Date.now() + MINUTES * 60_000;
const stats = { requests: 0, errors5xx: 0, rejected4xx: 0, sales: 0, refunds: 0, restocks: 0, durations: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// exponential think time, never past the end of the run
const pause = (meanMs) => sleep(Math.min(-Math.log(1 - Math.random()) * meanMs, Math.max(0, end - Date.now())));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

async function call(method, path, { token, body } = {}) {
  const start = Date.now();
  let status = 0;
  let json = null;
  try {
    const r = await fetch(API + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    status = r.status;
    json = await r.json().catch(() => null);
  } catch {
    status = 0; // timeout / connection refused
  }
  stats.requests++;
  stats.durations.push(Date.now() - start);
  if (status >= 500 || status === 0) stats.errors5xx++;
  else if (status >= 400) stats.rejected4xx++;
  return { status, json };
}

async function login(email, password = PASSWORD) {
  const r = await call('POST', '/auth/login', { body: { email, password } });
  if (r.status !== 200 && r.status !== 201) return null;
  return r.json?.accessToken ?? null;
}

/** Runs `step` until the end; a failed request (e.g. during a test fault) never stops the traffic. */
async function loop(who, meanPauseMs, step) {
  while (Date.now() < end) {
    await pause(meanPauseMs);
    if (Date.now() >= end) break;
    try {
      await step();
    } catch (e) {
      stats.scriptErrors = (stats.scriptErrors ?? 0) + 1;
      if (stats.scriptErrors <= 5) console.error(`${who}: ${e.message} (continuing)`);
    }
  }
}

/** Logs in (again every ~10 minutes, as tills do when the access token expires). */
function session(email) {
  let token = null;
  let at = 0;
  return async () => {
    if (!token || Date.now() - at > 10 * 60_000) {
      if (Math.random() < 0.05) await login(email, 'wrong-password'); // a typo first
      token = await login(email);
      at = Date.now();
    }
    return token;
  };
}

let adminToken = null;
async function restock(storeId, productId) {
  adminToken ??= await login(ADMIN);
  const r = await call('POST', '/inventory/adjustments', {
    token: adminToken,
    body: { storeId, type: 'PURCHASE', reference: 'load-test restock', items: [{ productId, quantity: 50 }] },
  });
  if (r.status < 300) stats.restocks++;
  else adminToken = null; // log in again next time
}

async function cashier(email) {
  const auth = session(email);
  let storeId = null;
  let products = [];
  await loop(email, 60_000 / RATE, async () => {
    const token = await auth();
    if (!token) return;
    if (!products.length) {
      // first time (or after a failed start): store, shift, catalogue
      storeId = (await call('GET', '/auth/me', { token })).json?.stores?.[0]?.id;
      if (!storeId) return;
      await call('POST', '/shifts/open', { token, body: { storeId, openingCash: 50 } }); // 400 if already open
      products = ((await call('GET', `/products?storeId=${storeId}&limit=100`, { token })).json?.data ?? [])
        .filter((p) => p.barcode && p.isActive && !p.isIngredient);
      if (!products.length) return;
    }
    const basket = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => pick(products));
    for (const p of basket) await call('GET', `/products/lookup?code=${p.barcode}&storeId=${storeId}`, { token });
    if (Math.random() < 0.15) await call('GET', `/products?storeId=${storeId}&search=${encodeURIComponent(pick(products).name.slice(0, 4))}&limit=10`, { token });
    if (Math.random() < 0.1) await call('GET', '/customers?limit=5&search=0', { token });
    const items = [...new Map(basket.map((p) => [p.id, { productId: p.id, quantity: 1 + Math.floor(Math.random() * 2) }])).values()];
    const r = await call('POST', '/sales', { token, body: { storeId, items, payments: [{ method: 'CASH', amount: 200 }] } });
    if (r.status === 201) stats.sales++;
    else if (r.status === 400 && /Not enough stock/.test(r.json?.message ?? '')) for (const i of items) await restock(storeId, i.productId);
  });
}

async function manager(email) {
  const auth = session(email);
  await loop(email, 45_000, async () => {
    const token = await auth();
    if (!token) return;
    const stores = (await call('GET', '/auth/me', { token })).json?.stores;
    if (!stores?.length) return;
    const storeId = pick(stores).id;
    await call('GET', `/reports/dashboard?storeId=${storeId}`, { token });
    if (Math.random() < 0.4) {
      const sales = (await call('GET', `/sales?storeId=${storeId}&limit=20`, { token })).json?.data ?? [];
      const sale = sales.find((s) => s.status === 'COMPLETED');
      if (sale) {
        const full = (await call('GET', `/sales/${sale.id}`, { token })).json;
        const item = full?.items?.[0];
        if (item) {
          const r = await call('POST', `/sales/${sale.id}/refunds`, { token, body: { items: [{ saleItemId: item.id, quantity: 1 }], method: 'CASH', reason: 'Customer changed mind' } });
          if (r.status === 201) stats.refunds++;
        }
      }
    }
  });
}

function report() {
  const d = stats.durations.sort((a, b) => a - b);
  const p95 = d.length ? d[Math.floor(d.length * 0.95)] : 0;
  const left = Math.max(0, Math.round((end - Date.now()) / 1000));
  console.log(
    `${new Date().toLocaleTimeString()}  requests ${stats.requests}  5xx/failed ${stats.errors5xx}  4xx ${stats.rejected4xx}  ` +
      `sales ${stats.sales}  refunds ${stats.refunds}  restocks ${stats.restocks}  p95 ${p95} ms  (${left} s left)`,
  );
  stats.durations = [];
}

console.log(`Load on ${API} for ${MINUTES} min: ${CASHIERS.length} cashiers (~${RATE} sales/min each), ${MANAGERS.length} managers`);
const timer = setInterval(report, 30_000);
await Promise.all([...CASHIERS.map(cashier), ...MANAGERS.map(manager)]);
clearInterval(timer);
report();
