// Products per store, end to end. Needs a running API with fresh seed data (npm run db:reset), like smoke.mjs.
const B = process.env.API_URL ?? 'http://localhost:3000/api/v1';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
async function call(method, path, { token, body } = {}) {
  const h = { 'Content-Type': 'application/json' }; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(B + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j };
}
const login = async (e) => (await call('POST', '/auth/login', { body: { email: e, password: 'Password@123' } })).j.accessToken;
const admin = await login('admin@pos.local'), mgr = await login('manager.pp@pos.local'), cashier = await login('cashier1@pos.local');
const stores = (await call('GET', '/stores', { token: admin })).j;
const pp01 = stores.find((s) => s.code === 'PP01'), pp02 = stores.find((s) => s.code === 'PP02'), sr01 = stores.find((s) => s.code === 'SR01');
const sku = 'ST-' + Date.now();
const inCatalog = async (store, id, token = admin) => (await call('GET', `/products/catalog?storeId=${store.id}`, { token })).j.products.some((p) => p.id === id);

// 1. New product only in PP01 (own price) and SR01
const np = await call('POST', '/products', { token: admin, body: { sku, name: 'Store Test Juice', sellPrice: 2, stores: [{ storeId: pp01.id, price: 1.5 }, { storeId: sr01.id }] } });
ok(np.s === 201, 'admin creates a product for PP01 and SR01 only');
const id = np.j.id;
ok(await inCatalog(pp01, id) && await inCatalog(sr01, id) && !(await inCatalog(pp02, id)), 'it is in the PP01 and SR01 POS catalogues, not in PP02');
const l1 = (await call('GET', `/products/lookup?code=${sku}&storeId=${pp01.id}`, { token: admin })).j;
ok(l1.price === '1.5' && l1.listed === true, `PP01 has its own price (${l1.price})`);
ok((await call('GET', `/products/lookup?code=${sku}&storeId=${sr01.id}`, { token: admin })).j.price === '2', 'SR01 uses the normal price');
const l2 = await call('GET', `/products/lookup?code=${sku}&storeId=${pp02.id}`, { token: admin });
ok(l2.s === 404 && /not sold in this store/.test(l2.j.message), `PP02 scan: "${l2.j.message}"`);
const mine = (r) => r.data.filter((p) => p.sku === sku);
const listPP02 = (await call('GET', `/products?storeId=${pp02.id}&listing=listed&search=${sku}`, { token: admin })).j;
const unlistedPP02 = (await call('GET', `/products?storeId=${pp02.id}&listing=unlisted&search=${sku}`, { token: admin })).j;
const listedPP01 = (await call('GET', `/products?storeId=${pp01.id}&listing=listed&search=${sku}`, { token: admin })).j;
ok(mine(listPP02).length === 0 && mine(unlistedPP02).length === 1 && mine(unlistedPP02)[0].listed === false && mine(listedPP01)[0].listed === true, 'product list per store: listed / not listed');
const sale02 = await call('POST', '/sales', { token: admin, body: { storeId: pp02.id, items: [{ productId: id, quantity: 1 }], payments: [{ method: 'CASH', amount: 5 }] } });
ok(sale02.s === 400 && /not sold in this store/.test(sale02.j.message), 'a sale in PP02 is refused');
const detail = (await call('GET', `/products/${id}`, { token: admin })).j;
ok(detail.inventory.length === 2 && detail.inventory.every((i) => i.isListed && i.store), 'product detail lists its 2 stores');

// 2. Product without stores -> every store
const all = await call('POST', '/products', { token: admin, body: { sku: sku + '-ALL', name: 'Everywhere', sellPrice: 1 } });
ok(await inCatalog(pp01, all.j.id) && await inCatalog(pp02, all.j.id) && await inCatalog(sr01, all.j.id), 'no store list -> sold in every store (API clients unchanged)');
ok((await call('POST', '/products', { token: admin, body: { sku: sku + '-BAD', name: 'x', sellPrice: 1, stores: [{ storeId: '00000000-0000-0000-0000-000000000000' }] } })).s === 400, 'unknown store refused');

// 3. Manager turns a product off in own store; not in other stores
const water = (await call('GET', `/products/lookup?code=SKU-0001&storeId=${pp01.id}`, { token: admin })).j;
const before = new Date(Date.now() - 1000).toISOString();
ok((await call('PUT', `/inventory/${pp01.id}/${water.id}`, { token: mgr, body: { isListed: false } })).s === 200, 'PP manager stops selling water in PP01');
const delta = (await call('GET', `/products/catalog?storeId=${pp01.id}&since=${before}`, { token: cashier })).j;
const w = delta.products.find((p) => p.id === water.id);
ok(w && w.isActive === false, 'offline POS catalogue update removes it (isActive false)');
ok(!(await inCatalog(pp01, water.id, cashier)), 'not in the full PP01 catalogue');
ok(await inCatalog(sr01, water.id), 'still sold in SR01');
const inv = (await call('GET', `/inventory?storeId=${pp01.id}&search=SKU-0001`, { token: mgr })).j;
const invAll = (await call('GET', `/inventory?storeId=${pp01.id}&search=SKU-0001&includeUnlisted=true`, { token: mgr })).j;
ok(inv.meta.total === 0 && invAll.meta.total === 1 && invAll.data[0].isListed === false && Number(invAll.data[0].quantity) > 0, 'stock page hides it, stock kept');
ok((await call('PUT', `/inventory/${sr01.id}/${water.id}`, { token: mgr, body: { isListed: false } })).s === 403, 'PP manager cannot change SR01');
ok((await call('PUT', `/inventory/${pp01.id}/${water.id}`, { token: cashier, body: { isListed: true } })).s === 403, 'cashier cannot change what a store sells');

// 4. Offline sale made before it was turned off is kept
const shift = await call('POST', '/shifts/open', { token: cashier, body: { storeId: pp01.id, openingCash: 0 } });
const off = await call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, clientRef: 'off-' + Date.now(), offlineCreatedAt: new Date(Date.now() - 60000).toISOString(), items: [{ productId: water.id, quantity: 1 }], payments: [{ method: 'CASH', amount: 5 }] } });
ok(off.s === 201, `offline sale of it is still accepted (${off.s} ${off.j.message ?? ''})`);
const online = await call('POST', '/sales', { token: cashier, body: { storeId: pp01.id, items: [{ productId: water.id, quantity: 1 }], payments: [{ method: 'CASH', amount: 5 }] } });
ok(online.s === 400, 'a new sale of it is refused');
ok((await call('PUT', `/inventory/${pp01.id}/${water.id}`, { token: mgr, body: { isListed: true } })).s === 200 && await inCatalog(pp01, water.id, cashier), 'turned back on: in the catalogue again');
if (shift.j?.id) await call('POST', `/shifts/${shift.j.id}/close`, { token: cashier, body: { countedCash: 0 } });

// 5. New stores
const st = await call('POST', '/stores', { token: admin, body: { code: 'TS' + String(Date.now()).slice(-4), name: 'Test Store' } });
const nStore = (await call('GET', `/stores/${st.j.id}`, { token: admin })).j;
const activeCount = (await call('GET', '/products?limit=1', { token: admin })).j.meta.total;
ok(st.s === 201 && nStore.productCount === activeCount, `new store sells every active product (${nStore.productCount})`);
const st2 = await call('POST', '/stores', { token: admin, body: { code: 'TC' + String(Date.now()).slice(-4), name: 'Copy Store', copyProductsFrom: pp01.id } });
const cp = (await call('GET', `/products/lookup?code=${sku}&storeId=${st2.j.id}`, { token: admin })).j;
const ppCount = (await call('GET', `/stores/${pp01.id}`, { token: admin })).j.productCount;
ok(cp.price === '1.5' && (await call('GET', `/stores/${st2.j.id}`, { token: admin })).j.productCount === ppCount, 'copy from PP01: same products and prices');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
