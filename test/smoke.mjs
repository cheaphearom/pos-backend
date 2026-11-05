// End-to-end smoke test. Needs a running API with fresh seed data (npm run db:reset).
// Webhook checks expect a receiver on http://localhost:4555 (optional).
const B = process.env.API_URL ?? 'http://localhost:3000/api/v1';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
async function call(method, path, { token, key, body } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  if (key) h['X-API-Key'] = key;
  const r = await fetch(B + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: r.status, j };
}
const login = async (e) => (await call('POST', '/auth/login', { body: { email: e, password: 'Password@123' } })).j.accessToken;

const admin = await login('admin@pos.local');
const cashier = await login('cashier1@pos.local');
const mgr = await login('manager.pp@pos.local');
ok(admin && cashier && mgr, 'login for admin, manager, cashier');
ok((await call('POST', '/auth/login', { body: { email: 'admin@pos.local', password: 'wrongpass' } })).s === 401, 'wrong password -> 401');
ok((await call('GET', '/stores')).s === 401, 'no token -> 401');

const wh = await call('POST', '/webhooks', { token: admin, body: { url: 'http://localhost:4555/hook', events: ['*'] } });
ok(wh.s === 201 && wh.j.secret, 'webhook endpoint created');

const stores = (await call('GET', '/stores', { token: admin })).j;
ok(stores.length === 3, 'admin sees 3 stores');
const cStores = (await call('GET', '/stores', { token: cashier })).j;
ok(cStores.length === 1 && cStores[0].code === 'PP01', 'cashier sees only own store');
const pp01 = stores.find((s) => s.code === 'PP01'), pp02 = stores.find((s) => s.code === 'PP02'), sr01 = stores.find((s) => s.code === 'SR01');

const water = (await call('GET', `/products/lookup?code=885000000001&storeId=${pp01.id}`, { token: cashier })).j;
ok(water.name === 'Mineral Water 500ml' && water.price === '0.35', `barcode lookup (${water.name}, price ${water.price}, stock ${water.stock})`);
const srWater = (await call('GET', `/products/lookup?code=SKU-0001&storeId=${sr01.id}`, { token: admin })).j;
ok(srWater.price === '0.39', `store price override in SR01 = ${srWater.price}`);
ok((await call('GET', `/products/lookup?code=SKU-0001&storeId=${sr01.id}`, { token: cashier })).s === 403, 'cashier blocked from other store');

const cust = (await call('GET', '/customers/lookup?code=012345678', { token: cashier })).j;
ok(cust.points === 500, `customer lookup ${cust.name} with ${cust.points} points`);

const shift = await call('POST', '/shifts/open', { token: cashier, body: { storeId: pp01.id, openingCash: 50 } });
ok(shift.s === 201, 'cashier opened shift');

const bananas = (await call('GET', `/products/lookup?code=SKU-0015&storeId=${pp01.id}`, { token: cashier })).j;
// water x2 (0.70, taxable) + bananas 1.5kg (1.80, no tax); 10% tax on water = 0.07; total 2.57; redeem 100 pts = 1.00 -> due 1.57; pay 5 cash -> change 3.43
const saleBody = {
  storeId: pp01.id, customerId: cust.id, redeemPoints: 100, clientRef: 'test-' + Date.now(),
  items: [{ productId: water.id, quantity: 2 }, { productId: bananas.id, quantity: 1.5 }],
  payments: [{ method: 'CASH', amount: 5 }],
};
const sale = await call('POST', '/sales', { token: cashier, body: saleBody });
ok(sale.s === 201, 'sale created ' + (sale.j.receiptNo ?? JSON.stringify(sale.j)));
ok(sale.j.total === '2.57' && sale.j.amountDue === '1.57' && sale.j.changeDue === '3.43', `totals total=${sale.j.total} due=${sale.j.amountDue} change=${sale.j.changeDue}`);
ok(sale.j.pointsEarned === 1 && sale.j.customer.points === 401, `points: earned ${sale.j.pointsEarned}, balance ${sale.j.customer.points}`);
ok(sale.j.shiftId === shift.j.id, 'sale linked to shift');
const retry = await call('POST', '/sales', { token: cashier, body: saleBody });
ok(retry.j.id === sale.j.id, 'same clientRef returns same sale (no double charge)');

const water2 = (await call('GET', `/products/lookup?code=SKU-0001&storeId=${pp01.id}`, { token: cashier })).j;
ok(Number(water2.stock) === Number(water.stock) - 2, `stock went ${water.stock} -> ${water2.stock}`);

ok((await call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, items: [{ productId: water.id, quantity: 99999 }], payments: [{ method: 'CASH', amount: 99999 }] } })).s === 400, 'overselling rejected');
ok((await call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, items: [{ productId: water.id, quantity: 1 }], payments: [{ method: 'CASH', amount: 0.1 }] } })).s === 400, 'underpayment rejected');
ok((await call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, items: [{ productId: water.id, quantity: 1 }], payments: [{ method: 'CARD', amount: 5 }] } })).s === 400, 'card overpayment rejected');

// Concurrency: set stock of chocolate to 3 and fire 10 parallel sales of 1
const choc = (await call('GET', `/products/lookup?code=SKU-0010&storeId=${pp01.id}`, { token: mgr })).j;
await call('POST', '/inventory/adjustments', { token: mgr, body: { storeId: pp01.id, type: 'ADJUSTMENT', items: [{ productId: choc.id, quantity: 3 - Number(choc.stock) }], note: 'test' } });
const results = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, items: [{ productId: choc.id, quantity: 1 }], payments: [{ method: 'CASH', amount: 2 }] } })));
const won = results.filter((r) => r.s === 201).length;
const chocAfter = (await call('GET', `/products/lookup?code=SKU-0010&storeId=${pp01.id}`, { token: mgr })).j;
ok(won === 3 && Number(chocAfter.stock) === 0, `10 parallel sales on 3 in stock: ${won} succeeded, stock now ${chocAfter.stock}`);
const receipts = results.filter((r) => r.s === 201).map((r) => r.j.receiptNo);
ok(new Set(receipts).size === receipts.length, 'receipt numbers unique: ' + receipts.join(', '));

// Refunds
const water1 = sale.j.items.find((i) => i.name.startsWith('Mineral')).id, banana1 = sale.j.items.find((i) => i.name === 'Bananas').id;
ok(sale.j.items[0].lineNo === 1 && sale.j.items[0].name.startsWith('Mineral'), 'receipt lines keep scan order');
ok((await call('POST', `/sales/${sale.j.id}/refunds`, { token: cashier, body: { items: [{ saleItemId: water1, quantity: 1 }] } })).s === 403, 'cashier cannot refund');
const r1 = await call('POST', `/sales/${sale.j.id}/refunds`, { token: mgr, body: { items: [{ saleItemId: water1, quantity: 1 }], reason: 'test' } });
ok(r1.s === 201, `partial refund ${r1.j.refundNo} amount ${r1.j.amount}`);
const r2 = await call('POST', `/sales/${sale.j.id}/refunds`, { token: mgr, body: { items: [{ saleItemId: water1, quantity: 1 }, { saleItemId: banana1, quantity: 1.5 }] } });
ok(r2.s === 201, `final refund ${r2.j.refundNo} amount ${r2.j.amount}`);
const after = (await call('GET', `/sales/${sale.j.receiptNo}`, { token: mgr })).j;
ok(after.status === 'REFUNDED' && after.refundedTotal === after.amountDue, `sale REFUNDED, refunded ${after.refundedTotal} of ${after.amountDue}`);
const custAfter = (await call('GET', `/customers/${cust.id}`, { token: mgr })).j;
ok(custAfter.points === 500, `customer points restored to ${custAfter.points}`);
ok((await call('POST', `/sales/${sale.j.id}/refunds`, { token: mgr, body: { items: [{ saleItemId: water1, quantity: 1 }] } })).s === 400, 'cannot refund twice');

// Transfers
const t = await call('POST', '/transfers', { token: mgr, body: { fromStoreId: pp01.id, toStoreId: pp02.id, items: [{ productId: water.id, quantity: 5 }] } });
ok(t.s === 201 && t.j.status === 'IN_TRANSIT', 'transfer created ' + t.j.transferNo);
const rec = await call('POST', `/transfers/${t.j.id}/receive`, { token: mgr });
ok(rec.j.status === 'RECEIVED', 'transfer received');
ok((await call('POST', `/transfers/${t.j.id}/receive`, { token: mgr })).s === 400, 'cannot receive twice');

// Shift close
const closed = await call('POST', `/shifts/${shift.j.id}/close`, { token: cashier, body: { closingCash: 55 } });
ok(closed.s === 201, `shift closed: expected cash ${closed.j.expectedCash}, difference ${closed.j.difference}, sales ${closed.j.summary?.salesCount}`);

// Reports
for (const r of ['dashboard', 'sales-summary', 'sales-summary?groupBy=store', 'top-products', 'payments', 'profit', 'cashiers', 'loyalty', 'inventory-value']) {
  const res = await call('GET', '/reports/' + r, { token: mgr });
  ok(res.s === 200, `report ${r}` + (r === 'sales-summary?groupBy=store' ? ' ' + JSON.stringify(res.j.data) : res.s !== 200 ? JSON.stringify(res.j) : ''));
}
ok((await call('GET', '/reports/dashboard', { token: cashier })).s === 403, 'cashier cannot see reports');
const low = (await call('GET', `/inventory?storeId=${pp01.id}&lowStock=true`, { token: mgr })).j;
ok(low.data.some((i) => i.productId === choc.id), `low-stock list has ${low.meta.total} item(s)`);

// API key integration
const k = await call('POST', '/api-keys', { token: admin, body: { name: 'E-commerce', scopes: ['products:read', 'sales:write'], storeId: pp02.id } });
ok(k.s === 201 && k.j.key.startsWith('pos_'), 'API key created');
ok((await call('GET', '/products?limit=5', { key: k.j.key })).s === 200, 'API key reads products');
ok((await call('GET', '/customers', { key: k.j.key })).s === 403, 'API key without scope blocked');
ok((await call('GET', '/users', { key: k.j.key })).s === 403, 'API key blocked from staff-only endpoint');
const apiSale = await call('POST', '/sales', { key: k.j.key, body: { storeId: pp02.id, channel: 'ONLINE', items: [{ productId: water.id, quantity: 1 }], payments: [{ method: 'BANK_TRANSFER', amount: 0.39 }] } });
ok(apiSale.s === 201 && apiSale.j.channel === 'ONLINE', 'integration created an ONLINE sale ' + (apiSale.j.receiptNo ?? JSON.stringify(apiSale.j)));
ok((await call('POST', '/sales', { key: k.j.key, body: { storeId: pp01.id, items: [{ productId: water.id, quantity: 1 }], payments: [{ method: 'CASH', amount: 1 }] } })).s === 403, 'store-limited key blocked from other store');
ok((await call('GET', '/products', { key: 'pos_fake' })).s === 401, 'bad API key -> 401');

// Validation & refresh
ok((await call('POST', '/sales', { token: cashier, body: { storeId: 'x' } })).s === 400, 'invalid body -> 400');
const lg = (await call('POST', '/auth/login', { body: { email: 'cashier1@pos.local', password: 'Password@123' } })).j;
const rf = await call('POST', '/auth/refresh', { body: { refreshToken: lg.refreshToken } });
ok(rf.s === 200 && rf.j.accessToken, 'refresh token works');
ok((await call('POST', '/auth/refresh', { body: { refreshToken: lg.refreshToken } })).s === 401, 'reused refresh token rejected');
ok((await call('POST', '/auth/refresh', { body: { refreshToken: rf.j.refreshToken } })).s === 401, 'after reuse, all sessions logged out');

await new Promise((r) => setTimeout(r, 2500));
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
