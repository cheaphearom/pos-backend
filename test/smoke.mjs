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
// Demo promotions would change the totals checked below; switch them off (promotions are tested later).
for (const pr of (await call('GET', '/promotions?limit=200', { token: admin })).j.data ?? []) {
  if (pr.isActive) await call('PATCH', `/promotions/${pr.id}`, { token: admin, body: { isActive: false } });
}
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

// Offline POS support
const cat = await call('GET', `/products/catalog?storeId=${pp01.id}`, { token: cashier });
ok(cat.s === 200 && cat.j.full && cat.j.products.length >= 30 && cat.j.products[0].price, `catalog download: ${cat.j.products?.length} products`);
const delta = await call('GET', `/products/catalog?storeId=${pp01.id}&since=${encodeURIComponent(cat.j.serverTime)}`, { token: cashier });
ok(delta.s === 200 && !delta.j.full && delta.j.products.length === 0, 'catalog since=now returns no changes');
const offRef = 'offline-' + Date.now();
const offAt = new Date(Date.now() - 3600_000).toISOString();
const off = await call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, clientRef: offRef, offlineCreatedAt: offAt, items: [{ productId: choc.id, quantity: 2 }], payments: [{ method: 'CASH', amount: 5 }] } });
ok(off.s === 201 && off.j.createdAt === offAt, 'offline sale accepted with its real time even though stock is 0');
const chocNeg = (await call('GET', `/products/lookup?code=SKU-0010&storeId=${pp01.id}`, { token: mgr })).j;
ok(Number(chocNeg.stock) === -2, `offline sale may push stock negative (${chocNeg.stock})`);
ok((await call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, offlineCreatedAt: offAt, items: [{ productId: water.id, quantity: 1 }], payments: [{ method: 'CASH', amount: 5 }] } })).s === 400, 'offline sale without clientRef rejected');
ok((await call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, clientRef: offRef + 'x', offlineCreatedAt: new Date(Date.now() - 10 * 86400_000).toISOString(), items: [{ productId: water.id, quantity: 1 }], payments: [{ method: 'CASH', amount: 5 }] } })).s === 400, 'offline sale older than 7 days rejected');
const dir = await call('GET', '/stores/directory', { token: cashier });
ok(dir.s === 200 && dir.j.length === 3, 'store directory lists all stores');

// ── Purchasing ──
const coke = (await call('GET', `/products/lookup?code=SKU-0002&storeId=${pp01.id}`, { token: mgr })).j;
const sup = await call('POST', '/suppliers', { token: mgr, body: { code: 'T-' + Date.now(), name: 'Test Supplier', paymentTermsDays: 7 } });
ok(sup.s === 201, 'supplier created');
const po = await call('POST', '/purchase-orders', { token: mgr, body: { supplierId: sup.j.id, storeId: pp01.id, items: [{ productId: coke.id, quantity: 24, unitCost: 0.3 }, { productId: water.id, quantity: 10 }] } });
ok(po.s === 201 && po.j.status === 'DRAFT' && po.j.subtotal === String(24 * 0.3 + 10 * Number(water.costPrice ?? 0.15)).replace(/0+$/, '').replace(/\.$/, '') || po.j.subtotal, `PO ${po.j.poNo} draft, subtotal ${po.j.subtotal}`);
ok((await call('POST', `/purchase-orders/${po.j.id}/receive`, { token: mgr, body: { items: [{ itemId: po.j.items[0].id, quantity: 1 }] } })).s === 400, 'cannot receive a draft');
ok((await call('POST', `/purchase-orders/${po.j.id}/order`, { token: mgr })).j.status === 'ORDERED', 'PO ordered');
const r1po = await call('POST', `/purchase-orders/${po.j.id}/receive`, { token: mgr, body: { reference: 'INV-77', items: [{ itemId: po.j.items[0].id, quantity: 12, unitCost: 0.32 }] } });
const cokeAfter = (await call('GET', `/products/lookup?code=SKU-0002&storeId=${pp01.id}`, { token: mgr })).j;
ok(r1po.j.status === 'PARTIALLY_RECEIVED' && Number(cokeAfter.stock) === Number(coke.stock) + 12, `partial delivery: status ${r1po.j.status}, stock ${coke.stock} -> ${cokeAfter.stock}`);
ok(cokeAfter.costPrice === '0.32', 'cost price updated to received cost');
ok((await call('POST', `/purchase-orders/${po.j.id}/receive`, { token: mgr, body: { items: [{ itemId: po.j.items[0].id, quantity: 13 }] } })).s === 400, 'cannot receive more than ordered');
const r2po = await call('POST', `/purchase-orders/${po.j.id}/receive`, { token: mgr, body: { items: [{ itemId: po.j.items[0].id, quantity: 12 }, { itemId: po.j.items[1].id, quantity: 10 }] } });
ok(r2po.j.status === 'RECEIVED' && r2po.j.receipts.length === 2, 'second delivery completes the PO');
ok((await call('POST', `/purchase-orders/${po.j.id}/cancel`, { token: mgr })).s === 400, 'cannot cancel a received PO');
ok((await call('GET', '/purchase-orders', { token: cashier })).s === 403, 'cashier cannot see purchase orders');
const sugg = await call('GET', `/purchase-orders/suggestions?storeId=${pp01.id}`, { token: mgr });
ok(sugg.s === 200 && sugg.j.some((x) => x.productId === choc.id), `reorder suggestions: ${sugg.j.length} item(s)`);

// ── Promotions ──
const b2g1 = await call('POST', '/promotions', { token: admin, body: { name: 'Coke 2+1', type: 'BUY_X_GET_Y', buyQty: 2, getQty: 1, productIds: [coke.id], storeIds: [pp01.id] } });
ok(b2g1.s === 201, 'buy 2 get 1 promotion created');
ok((await call('POST', '/promotions', { token: admin, body: { name: 'bad', type: 'PERCENT_OFF', value: 10 } })).s === 400, 'promotion without products rejected');
const nowMin = (() => { const t = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Phnom_Penh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':'); return Number(t[0]) * 60 + Number(t[1]); })();
await call('POST', '/promotions', { token: admin, body: { name: 'Not now', type: 'PERCENT_OFF', value: 50, productIds: [coke.id], startMinute: (nowMin + 120) % 1440, endMinute: (nowMin + 180) % 1440 } });
const active = await call('GET', `/promotions/active?storeId=${pp01.id}`, { token: cashier });
ok(active.s === 200 && active.j.promotions.some((x) => x.id === b2g1.j.id) && active.j.timeZone, 'POS can download active promotions');
const promoSale = await call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, items: [{ productId: coke.id, quantity: 3 }], payments: [{ method: 'CASH', amount: 5 }] } });
// 3 x 0.65 = 1.95, one free (0.65) -> 1.30 + 10% tax = 1.43
ok(promoSale.s === 201 && promoSale.j.total === '1.43' && promoSale.j.items[0].promoDiscount === '0.65' && promoSale.j.items[0].promotion?.name === 'Coke 2+1',
  `buy 2 get 1 applied: total ${promoSale.j.total}, promo ${promoSale.j.items?.[0]?.promoDiscount} (happy hour outside window not applied)`);
const prRep = await call('GET', '/reports/promotions', { token: mgr });
ok(prRep.s === 200 && prRep.j.data.some((x) => x.name === 'Coke 2+1' && x.discount === 0.65), 'promotion report shows usage');
await call('PATCH', `/promotions/${b2g1.j.id}`, { token: admin, body: { isActive: false } });

// ── KHQR ──
ok((await call('POST', '/payments/khqr', { token: admin, body: { storeId: pp02.id, amount: 1 } })).s === 400, 'KHQR refused for a store without a Bakong account');
const kq = await call('POST', '/payments/khqr', { token: cashier, body: { storeId: pp01.id, amount: 1.43 } });
ok(kq.s === 201 && kq.j.qr.startsWith('000201010212') && kq.j.qr.includes('54041.43') && /^[0-9a-f]{32}$/.test(kq.j.md5), `dynamic KHQR created (mode ${kq.j.mode})`);
ok((await call('GET', `/payments/khqr/${kq.j.md5}`, { token: cashier })).j.status === 'PENDING', 'KHQR status pending');
const kqSaleBody = { storeId: pp01.id, items: [{ productId: coke.id, quantity: 2 }], payments: [{ method: 'KHQR', amount: 1.43, reference: kq.j.md5 }] };
ok((await call('POST', '/sales', { token: cashier, body: kqSaleBody })).s === 400, 'sale with unpaid KHQR rejected');
ok((await call('POST', `/payments/khqr/${kq.j.md5}/confirm`, { token: cashier })).j.status === 'PAID', 'cashier confirms payment (manual mode)');
const kqSale = await call('POST', '/sales', { token: cashier, body: kqSaleBody });
ok(kqSale.s === 201, 'sale paid by KHQR ' + (kqSale.j.receiptNo ?? JSON.stringify(kqSale.j)));
ok((await call('POST', '/sales', { token: cashier, body: kqSaleBody })).s === 400, 'same KHQR cannot pay a second sale');
ok((await call('GET', `/payments/khqr/${kq.j.md5}`, { token: mgr })).s === 200 && (await call('GET', `/payments/khqr/${'0'.repeat(32)}`, { token: mgr })).s === 404, 'unknown KHQR -> 404');

// ── Wallet cards ──
const gen = await call('POST', '/wallet/cards', { token: admin, body: { count: 5 } });
ok(gen.s === 201 && gen.j.created === 5 && gen.j.cards[0].cardNumber.startsWith('8899') && gen.j.cards[0].cardNumber.length === 16, `generated 5 cards, e.g. ${gen.j.cards?.[0]?.cardNumber} / ${gen.j.cards?.[0]?.serialNumber}`);
ok((await call('POST', '/wallet/cards', { token: mgr, body: { count: 1 } })).s === 403, 'only super admin generates cards');
const c1 = (await call('GET', `/wallet/cards/lookup?code=${gen.j.cards[0].cardNumber}`, { token: cashier })).j;
ok(c1.status === 'INACTIVE' && c1.pinHash === undefined, 'lookup finds the new card (PIN hash never sent)');
ok((await call('POST', `/wallet/cards/${c1.id}/activate`, { token: cashier, body: { serialNumber: 'WRONG-SERIAL', name: 'Wallet Tester' } })).s === 400, 'activation with wrong serial rejected');
const act = await call('POST', `/wallet/cards/${c1.id}/activate`, { token: cashier, body: { serialNumber: gen.j.cards[0].serialNumber.toLowerCase(), name: 'Wallet Tester', phone: '099' + Date.now().toString().slice(-6), pin: '4321' } });
ok(act.s === 201 && act.j.status === 'ACTIVE' && act.j.hasPin && act.j.customer?.name === 'Wallet Tester', 'card activated for a new customer with a PIN');
const shift2 = await call('POST', '/shifts/open', { token: cashier, body: { storeId: pp01.id, openingCash: 10 } });
const topRef = 'top-' + Date.now();
const top1 = await call('POST', `/wallet/cards/${c1.id}/topup`, { token: cashier, body: { storeId: pp01.id, amount: 20, method: 'CASH', clientRef: topRef } });
const top2 = await call('POST', `/wallet/cards/${c1.id}/topup`, { token: cashier, body: { storeId: pp01.id, amount: 20, method: 'CASH', clientRef: topRef } });
ok(top1.s === 201 && top2.j.card.balance === '20' && top1.j.transaction.id === top2.j.transaction.id, 'top-up $20; retry with same clientRef not counted twice');
const shiftSum = (await call('GET', `/shifts/${shift2.j.id}`, { token: cashier })).j.summary;
ok(Number(shiftSum.expectedCash) === 30 && Number(shiftSum.walletTopups.CASH) === 20, `cash top-up counted in the drawer: expected cash ${shiftSum.expectedCash}`);
const walletSale = (pin, qty = 1) => call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, items: [{ productId: water.id, quantity: qty }], payments: [{ method: 'WALLET', amount: Math.round(0.385 * qty * 100) / 100, reference: c1.cardNumber, pin }] } });
const wsBad = await walletSale('0000');
ok(wsBad.s === 400 && /Wrong PIN/.test(wsBad.j.message), 'wrong PIN rejected: ' + wsBad.j.message);
ok((await walletSale(undefined)).s === 400, 'PIN required for a card that has one');
const ws = await walletSale('4321');
const balAfter = (await call('GET', `/wallet/cards/${c1.id}`, { token: mgr })).j.balance;
ok(ws.s === 201 && balAfter === '19.61', `paid $0.39 with wallet, balance now ${balAfter}`);
const waterBefore = (await call('GET', `/products/lookup?code=SKU-0001&storeId=${pp01.id}`, { token: mgr })).j.stock;
const tooMuch = await call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, items: [{ productId: water.id, quantity: 60 }], payments: [{ method: 'WALLET', amount: 23.1, reference: c1.cardNumber, pin: '4321' }] } });
const waterAfterFail = (await call('GET', `/products/lookup?code=SKU-0001&storeId=${pp01.id}`, { token: mgr })).j.stock;
ok(tooMuch.s === 400 && waterBefore === waterAfterFail, 'payment above balance rejected and stock untouched: ' + tooMuch.j.message);
// 5 tills spend the same card at once: $19.61 allows 3 sales of $5.39 (14 waters)
await call('POST', '/inventory/adjustments', { token: mgr, body: { storeId: pp01.id, type: 'PURCHASE', items: [{ productId: water.id, quantity: 200 }] } });
const par = await Promise.all(Array.from({ length: 5 }, () => walletSale('4321', 14)));
const parOk = par.filter((r) => r.s === 201).length;
const balPar = (await call('GET', `/wallet/cards/${c1.id}`, { token: mgr })).j.balance;
ok(parOk === 3 && Number(balPar) === Math.round((19.61 - 3 * 5.39) * 100) / 100, `5 parallel wallet payments: ${parOk} succeeded, balance ${balPar} (never negative)`);
const wref = await call('POST', `/sales/${ws.j.id}/refunds`, { token: mgr, body: { items: [{ saleItemId: ws.j.items[0].id, quantity: 1 }], method: 'WALLET' } });
const balRef = (await call('GET', `/wallet/cards/${c1.id}`, { token: mgr })).j.balance;
ok(wref.s === 201 && Number(balRef) === Math.round((Number(balPar) + 0.39) * 100) / 100, `refund back to the card: balance ${balRef}`);
ok((await call('POST', `/sales/${promoSale.j.id}/refunds`, { token: mgr, body: { items: [{ saleItemId: promoSale.j.items[0].id, quantity: 1 }], method: 'WALLET' } })).s === 400, 'cannot refund to wallet a sale not paid by wallet');
await call('POST', `/wallet/cards/${c1.id}/block`, { token: mgr, body: { reason: 'test' } });
ok((await walletSale('4321')).s === 400, 'blocked card cannot pay');
ok((await call('POST', `/wallet/cards/${c1.id}/topup`, { token: cashier, body: { storeId: pp01.id, amount: 5, method: 'CASH' } })).s === 400, 'blocked card cannot be topped up');
await call('POST', `/wallet/cards/${c1.id}/unblock`, { token: mgr });
for (let i = 0; i < 5; i++) await walletSale('9999');
ok((await call('GET', `/wallet/cards/${c1.id}`, { token: mgr })).j.status === 'BLOCKED', '5 wrong PINs block the card');
ok((await call('POST', `/wallet/cards/${c1.id}/pin`, { token: cashier, body: { pin: '1111' } })).s === 403, 'cashier cannot change an existing PIN');
const rep = await call('POST', `/wallet/cards/${c1.id}/replace`, { token: mgr, body: { newCardNumber: gen.j.cards[1].cardNumber, newSerialNumber: gen.j.cards[1].serialNumber } });
const oldCard = (await call('GET', `/wallet/cards/${c1.id}`, { token: mgr })).j;
ok(rep.s === 201 && rep.j.status === 'ACTIVE' && rep.j.balance === balRef && rep.j.customer?.name === 'Wallet Tester' && oldCard.status === 'CLOSED' && oldCard.balance === '0', `lost card replaced: balance ${rep.j.balance} moved, old card closed`);
const wtx = (await call('GET', `/wallet/cards/${rep.j.id}/transactions`, { token: mgr })).j;
ok(wtx.data[0].type === 'TRANSFER_IN', 'transfer recorded in the card history');
ok((await call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, clientRef: 'off-w-' + Date.now(), offlineCreatedAt: new Date().toISOString(), items: [{ productId: water.id, quantity: 1 }], payments: [{ method: 'WALLET', amount: 0.39, reference: rep.j.cardNumber }] } })).s === 400, 'wallet payments refused for offline sales');
const wrep = await call('GET', '/reports/wallet', { token: mgr });
ok(wrep.s === 200 && wrep.j.outstanding >= Number(rep.j.balance) && wrep.j.data.some((x) => x.type === 'TOPUP'), `wallet report: $${wrep.j.outstanding} held on ${wrep.j.activeCards} active card(s)`);
await call('POST', `/shifts/${shift2.j.id}/close`, { token: cashier, body: { closingCash: 30 } });

// ── Coupons ──
await call('POST', '/inventory/adjustments', { token: mgr, body: { storeId: pp01.id, type: 'PURCHASE', items: [{ productId: water.id, quantity: 200 }] } });
const shared = await call('POST', '/coupons', { token: admin, body: { name: 'Save 10', type: 'PERCENT', value: 10, minSpend: 2, maxDiscount: 1, sharedCode: 'SAVE10T' + Date.now().toString().slice(-4), usageLimit: 3 } });
ok(shared.s === 201 && shared.j._count.codes === 1, 'shared coupon campaign created');
const sharedCode = (await call('GET', `/coupons/${shared.j.id}/codes`, { token: mgr })).j.data[0].code;
const couponSale = (code, qty) => call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, couponCode: code, items: [{ productId: water.id, quantity: qty }], payments: [{ method: 'CASH', amount: 50 }] } });
ok((await couponSale(sharedCode, 2)).s === 400, 'coupon below minimum spend rejected');
const cs = await couponSale(sharedCode, 10); // 3.50 -> 10% = 0.35 off -> 3.15 + tax 0.32 = 3.47
ok(cs.s === 201 && cs.j.couponDiscount === '0.35' && cs.j.total === '3.47' && cs.j.couponName?.startsWith('Save 10'), `coupon 10% applied: discount ${cs.j.couponDiscount}, total ${cs.j.total}`);
const cs2 = await couponSale(sharedCode, 100); // 35.00 -> 10% = 3.50, capped at 1.00
ok(cs2.s === 201 && cs2.j.couponDiscount === '1', `percent coupon capped at max discount: ${cs2.j.couponDiscount}`);
await couponSale(sharedCode, 10);
const over = await couponSale(sharedCode, 10);
ok(over.s === 400 && /fully used/.test(over.j.message), 'campaign usage limit (3) enforced');
const uniq = await call('POST', '/coupons', { token: admin, body: { name: 'One-time $1', type: 'AMOUNT', value: 1, uniqueCount: 3, prefix: 'TST' } });
const uCodes = (await call('GET', `/coupons/${uniq.j.id}/codes?all=true`, { token: mgr })).j;
ok(uniq.s === 201 && uCodes.length === 3 && uCodes[0].code.startsWith('TST-'), `3 unique codes generated, e.g. ${uCodes[0]?.code}`);
const uPar = await Promise.all(Array.from({ length: 5 }, () => couponSale(uCodes[0].code, 10)));
ok(uPar.filter((r) => r.s === 201).length === 1, `5 tills use the same single-use code at once: ${uPar.filter((r) => r.s === 201).length} succeeded`);
ok((await couponSale(uCodes[0].code, 10)).j.message === 'This coupon code has already been used', 'used single-use code rejected');
const memberOnly = await call('POST', '/coupons', { token: admin, body: { name: 'Members once', type: 'AMOUNT', value: 0.5, sharedCode: 'MEM' + Date.now().toString().slice(-6), membersOnly: true, perCustomerLimit: 1 } });
const memCode = (await call('GET', `/coupons/${memberOnly.j.id}/codes`, { token: mgr })).j.data[0].code;
ok((await couponSale(memCode, 10)).s === 400, 'members-only coupon needs a customer');
const memSale = () => call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, couponCode: memCode, customerId: cust.id, items: [{ productId: water.id, quantity: 10 }], payments: [{ method: 'CASH', amount: 50 }] } });
ok((await memSale()).s === 201 && (await memSale()).s === 400, 'per-customer limit: second use by the same customer rejected');
ok((await call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, clientRef: 'off-c-' + Date.now(), offlineCreatedAt: new Date().toISOString(), couponCode: uCodes[1].code, items: [{ productId: water.id, quantity: 10 }], payments: [{ method: 'CASH', amount: 50 }] } })).s === 400, 'coupons refused for offline sales');

// ── Gift vouchers ──
const vb = await call('POST', '/vouchers/batches', { token: admin, body: { name: 'Test $5', value: 5, count: 3, sold: true } });
ok(vb.s === 201 && vb.j.codes.length === 3 && vb.j.codes[0].code.startsWith('GV'), `3 vouchers created, e.g. ${vb.j.codes?.[0]?.code}`);
const vcode = vb.j.codes[0].code;
const voucherSale = (code, amount, qty = 1) => call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, items: [{ productId: water.id, quantity: qty }], payments: [{ method: 'VOUCHER', amount, reference: code }] } });
ok((await voucherSale(vcode, 0.39)).j.message === 'This voucher was not sold yet', 'unsold voucher cannot pay');
const shift3 = await call('POST', '/shifts/open', { token: cashier, body: { storeId: pp01.id, openingCash: 0 } });
const sold = await call('POST', `/vouchers/${vcode.toLowerCase()}/sell`, { token: cashier, body: { storeId: pp01.id, method: 'CASH' } });
ok(sold.s === 201 && sold.j.status === 'ACTIVE', 'voucher sold for cash and activated');
const sum3 = (await call('GET', `/shifts/${shift3.j.id}`, { token: cashier })).j.summary;
ok(Number(sum3.expectedCash) === 5, `voucher cash counted in the drawer: expected ${sum3.expectedCash}`);
ok((await call('POST', `/vouchers/${vcode}/sell`, { token: cashier, body: { storeId: pp01.id, method: 'CASH' } })).s === 400, 'cannot sell the same voucher twice');
const vs = await voucherSale(vcode, 0.39);
ok(vs.s === 201 && (await call('GET', `/vouchers/lookup?code=${vcode}`, { token: cashier })).j.balance === '4.61', 'voucher paid $0.39, $4.61 left on it');
ok((await voucherSale(vcode, 5.39, 14)).s === 400, 'voucher cannot pay more than its balance');
ok((await call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, items: [{ productId: water.id, quantity: 1 }], payments: [{ method: 'VOUCHER', amount: 1, reference: vcode }] } })).s === 400, 'no change is given on vouchers');
const vEnd = await voucherSale(vcode, 4.61, 12); // 12 x 0.35 = 4.20 + 0.42 tax = 4.62 > 4.61 -> rejected; use 4.61 split
const vSplit = await call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, items: [{ productId: water.id, quantity: 12 }], payments: [{ method: 'VOUCHER', amount: 4.61, reference: vcode }, { method: 'CASH', amount: 1 }] } });
const vAfter = (await call('GET', `/vouchers/lookup?code=${vcode}`, { token: cashier })).j;
ok(vEnd.s === 400 && vSplit.s === 201 && vAfter.status === 'USED' && vAfter.balance === '0', 'rest paid in cash; voucher fully used');
const vref = await call('POST', `/sales/${vs.j.id}/refunds`, { token: mgr, body: { items: [{ saleItemId: vs.j.items[0].id, quantity: 1 }], method: 'VOUCHER' } });
const vBack = (await call('GET', `/vouchers/lookup?code=${vcode}`, { token: cashier })).j;
ok(vref.s === 201 && vBack.status === 'ACTIVE' && vBack.balance === '0.39', 'refund back to the voucher re-opens it');
const fb = await call('POST', '/vouchers/batches', { token: admin, body: { name: 'Free $1', value: 1, count: 1, sold: false } });
ok((await voucherSale(fb.j.codes[0].code, 0.39)).s === 201, 'free promotional voucher works without selling');
const exp = await call('POST', '/vouchers/batches', { token: admin, body: { name: 'Expired', value: 1, count: 1, sold: false, expiresAt: '2020-01-01T00:00:00Z' } });
ok((await voucherSale(exp.j.codes[0].code, 0.39)).j.message === 'This voucher has expired', 'expired voucher rejected');
await call('POST', `/vouchers/${vb.j.codes[1].code}/void`, { token: mgr, body: { reason: 'lost' } });
ok((await call('POST', `/vouchers/${vb.j.codes[1].code}/sell`, { token: cashier, body: { storeId: pp01.id, method: 'CASH' } })).s === 400, 'void voucher cannot be sold');

// ── One lookup for the POS scanner ──
const lk = async (code) => (await call('GET', `/codes/lookup?code=${encodeURIComponent(code)}&storeId=${pp01.id}`, { token: cashier })).j;
ok((await lk(vb.j.codes[2].code)).kind === 'voucher' && (await lk(uCodes[2].code)).kind === 'coupon' && (await lk(rep.j.cardNumber)).kind === 'wallet', 'code lookup recognises voucher, coupon and wallet card');
ok((await call('GET', `/codes/lookup?code=NOPE123&storeId=${pp01.id}`, { token: cashier })).s === 404, 'unknown code -> 404');
const cvr = await call('GET', '/reports/coupons-vouchers', { token: mgr });
ok(cvr.s === 200 && cvr.j.coupons.some((c) => c.name === 'Save 10' && c.uses === 3) && cvr.j.vouchers.soldInPeriod.value >= 5, `report: coupons ${cvr.j.coupons.length} campaign(s), vouchers sold $${cvr.j.vouchers.soldInPeriod.value}, outstanding $${cvr.j.vouchers.outstandingSold.value}`);
await call('POST', `/shifts/${shift3.j.id}/close`, { token: cashier, body: { closingCash: 5 } });

await new Promise((r) => setTimeout(r, 2500));
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
