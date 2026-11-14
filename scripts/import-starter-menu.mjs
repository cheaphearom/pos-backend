#!/usr/bin/env node
// Starter café menu through the API, as a super admin: categories, drink options (with how they change the recipe),
// ingredients, 20 products with recipes, promotions, and staff accounts for a few stores.
//
//   API_URL=https://your-pos/api/v1  ADMIN_EMAIL=...  ADMIN_PASSWORD=...  STAFF_PASSWORD=...  node scripts/import-starter-menu.mjs
//
// STAFF_STORES  store codes that get a manager and a cashier (default B008,B001); STAFF_PASSWORD is their first
//               password (8+ characters; they can change it). Leave STAFF_PASSWORD empty to skip accounts.
// DRY_RUN=1     only shows what would be created.
// Safe to run again: categories, options, products (by SKU), promotions and users that already exist are skipped.
// Prices are a starting point: change them on the Products page (or per store: Products > Stores).

const API = (process.env.API_URL ?? 'http://localhost:3000/api/v1').replace(/\/+$/, '');
const DRY = process.env.DRY_RUN === '1';
const STAFF_STORES = (process.env.STAFF_STORES ?? 'B008,B001').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const STAFF_PASSWORD = process.env.STAFF_PASSWORD ?? '';

// ── The menu ─────────────────────────────────────────────────────────────────────────────────────
const CATEGORIES = [
  ['Coffee', 'កាហ្វេ'],
  ['Tea & Matcha', 'តែ និងម៉ាចា'],
  ['Frappé', 'ហ្វ្រាប៉េ'],
  ['Soda & Juice', 'សូដា និងទឹកផ្លែឈើ'],
  ['Bakery', 'នំ'],
  ['Ingredients', 'គ្រឿងផ្សំ'],
];

// name, min, max, options [name, extra price, default?]
const OPTION_GROUPS = [
  ['Size', 1, 1, [['Small', -0.3], ['Medium', 0, true], ['Large', 0.5]]],
  ['Sugar', 1, 1, [['0%', 0], ['30%', 0], ['50%', 0], ['70%', 0], ['100%', 0, true]]],
  ['Ice', 1, 1, [['Normal ice', 0, true], ['Less ice', 0], ['No ice', 0]]],
  ['Milk', 0, 1, [['Fresh milk', 0, true], ['Oat milk', 0.6], ['Soy milk', 0.4]]],
  ['Extras', 0, 3, [['Extra shot', 0.5], ['Whipped cream', 0.3], ['Caramel syrup', 0.3]]],
];

// sku, name, unit, cost per unit
const INGREDIENTS = [
  ['IN-001', 'Coffee beans', 'g', 0.025], ['IN-002', 'Fresh milk', 'ml', 0.0016], ['IN-003', 'Oat milk', 'ml', 0.004],
  ['IN-004', 'Soy milk', 'ml', 0.003], ['IN-005', 'Condensed milk', 'ml', 0.004], ['IN-006', 'Sugar syrup', 'ml', 0.002],
  ['IN-007', 'Matcha powder', 'g', 0.09], ['IN-008', 'Cocoa powder', 'g', 0.02], ['IN-009', 'Black tea', 'g', 0.015],
  ['IN-010', 'Coconut cream', 'ml', 0.004], ['IN-011', 'Caramel syrup', 'ml', 0.006], ['IN-012', 'Whipped cream', 'g', 0.01],
  ['IN-013', 'Passion fruit syrup', 'ml', 0.006], ['IN-014', 'Lemon', 'pcs', 0.1], ['IN-015', 'Soda water', 'ml', 0.0008],
  ['IN-016', 'Cup 12oz', 'pcs', 0.05], ['IN-017', 'Cup 16oz', 'pcs', 0.06], ['IN-018', 'Lid', 'pcs', 0.02], ['IN-019', 'Straw', 'pcs', 0.01],
];

const HOT = ['Size', 'Sugar', 'Milk', 'Extras'];
const ICED = ['Size', 'Sugar', 'Ice', 'Milk', 'Extras'];
const ICED_NO_MILK = ['Size', 'Sugar', 'Ice', 'Extras'];
const TEA = ['Size', 'Sugar', 'Ice'];
const cupHot = [['Cup 12oz', 1], ['Lid', 1]];
const cupIced = [['Cup 16oz', 1], ['Lid', 1], ['Straw', 1]];
// sku, name, Khmer name, category, price, options, recipe [ingredient, quantity]
const PRODUCTS = [
  ['CF-001', 'Espresso', 'អេស្ប្រេស្សូ', 'Coffee', 1.8, ['Sugar', 'Extras'], [['Coffee beans', 18], ['Cup 12oz', 1]]],
  ['CF-002', 'Americano', 'អាមេរិកាណូ', 'Coffee', 2.0, ['Size', 'Sugar', 'Extras'], [['Coffee beans', 18], ['Sugar syrup', 15], ...cupHot]],
  ['CF-003', 'Iced Americano', 'អាមេរិកាណូទឹកកក', 'Coffee', 2.2, ICED_NO_MILK, [['Coffee beans', 18], ['Sugar syrup', 20], ...cupIced]],
  ['CF-004', 'Cappuccino', 'កាពូឈីណូ', 'Coffee', 2.5, HOT, [['Coffee beans', 18], ['Fresh milk', 150], ['Sugar syrup', 15], ...cupHot]],
  ['CF-005', 'Latte', 'ឡាតេ', 'Coffee', 2.5, HOT, [['Coffee beans', 18], ['Fresh milk', 200], ['Sugar syrup', 15], ...cupHot]],
  ['CF-006', 'Iced Latte', 'ឡាតេទឹកកក', 'Coffee', 2.75, ICED, [['Coffee beans', 18], ['Fresh milk', 180], ['Sugar syrup', 20], ...cupIced]],
  ['CF-007', 'Caramel Macchiato', 'ការ៉ាមែលម៉ាគីយ៉ាតូ', 'Coffee', 3.0, ICED, [['Coffee beans', 18], ['Fresh milk', 180], ['Caramel syrup', 20], ...cupIced]],
  ['CF-008', 'Iced Mocha', 'ម៉ូកាទឹកកក', 'Coffee', 3.0, ICED, [['Coffee beans', 18], ['Cocoa powder', 15], ['Fresh milk', 160], ['Sugar syrup', 15], ...cupIced]],
  ['CF-009', 'Khmer Iced Coffee', 'កាហ្វេទឹកដោះគោទឹកកក', 'Coffee', 2.0, ['Size', 'Sugar', 'Ice', 'Extras'], [['Coffee beans', 20], ['Condensed milk', 40], ...cupIced]],
  ['CF-010', 'Iced Coconut Coffee', 'កាហ្វេដូងទឹកកក', 'Coffee', 3.0, ICED_NO_MILK, [['Coffee beans', 18], ['Coconut cream', 80], ['Condensed milk', 20], ...cupIced]],
  ['TE-001', 'Iced Matcha Latte', 'ម៉ាចាឡាតេទឹកកក', 'Tea & Matcha', 3.0, ICED, [['Matcha powder', 4], ['Fresh milk', 200], ['Sugar syrup', 20], ...cupIced]],
  ['TE-002', 'Hot Matcha Latte', 'ម៉ាចាឡាតេក្តៅ', 'Tea & Matcha', 2.8, HOT, [['Matcha powder', 4], ['Fresh milk', 220], ['Sugar syrup', 15], ...cupHot]],
  ['TE-003', 'Iced Lemon Tea', 'តែក្រូចឆ្មាទឹកកក', 'Tea & Matcha', 2.0, TEA, [['Black tea', 5], ['Lemon', 0.5], ['Sugar syrup', 25], ...cupIced]],
  ['TE-004', 'Thai Milk Tea', 'តែទឹកដោះគោថៃ', 'Tea & Matcha', 2.5, TEA, [['Black tea', 6], ['Condensed milk', 30], ['Fresh milk', 80], ...cupIced]],
  ['FR-001', 'Caramel Frappé', 'ហ្វ្រាប៉េការ៉ាមែល', 'Frappé', 3.5, ['Size', 'Sugar', 'Milk', 'Extras'], [['Coffee beans', 18], ['Fresh milk', 150], ['Caramel syrup', 25], ['Whipped cream', 20], ...cupIced]],
  ['FR-002', 'Mocha Frappé', 'ហ្វ្រាប៉េម៉ូកា', 'Frappé', 3.5, ['Size', 'Sugar', 'Milk', 'Extras'], [['Coffee beans', 18], ['Cocoa powder', 20], ['Fresh milk', 150], ['Whipped cream', 20], ...cupIced]],
  ['SD-001', 'Passion Fruit Soda', 'សូដាផាសិន', 'Soda & Juice', 2.5, TEA, [['Passion fruit syrup', 40], ['Soda water', 250], ...cupIced]],
  ['BK-001', 'Butter Croissant', 'នំក្រូសង់ប៊ឺ', 'Bakery', 1.8, [], []],
  ['BK-002', 'Chocolate Muffin', 'នំម៉ាហ្វីនសូកូឡា', 'Bakery', 2.0, [], []],
  ['BK-003', 'Cheesecake', 'នំឈីសខេក', 'Bakery', 3.0, [], []],
];

// How options change the recipe (applies to every drink that offers the option)
const EFFECTS = {
  'Size/Small': [{ type: 'SCALE', percent: -20 }],
  'Size/Large': [{ type: 'SCALE', percent: 30 }, { type: 'REPLACE', ingredient: 'Cup 12oz', replaceWith: 'Cup 16oz' }],
  'Milk/Oat milk': [{ type: 'REPLACE', ingredient: 'Fresh milk', replaceWith: 'Oat milk' }],
  'Milk/Soy milk': [{ type: 'REPLACE', ingredient: 'Fresh milk', replaceWith: 'Soy milk' }],
  'Extras/Extra shot': [{ type: 'ADD', ingredient: 'Coffee beans', quantity: 18 }],
  'Extras/Whipped cream': [{ type: 'ADD', ingredient: 'Whipped cream', quantity: 20 }],
  'Extras/Caramel syrup': [{ type: 'ADD', ingredient: 'Caramel syrup', quantity: 15 }],
  'Sugar/0%': [{ type: 'SCALE', ingredient: 'Sugar syrup', percent: -100 }],
  'Sugar/30%': [{ type: 'SCALE', ingredient: 'Sugar syrup', percent: -70 }],
  'Sugar/50%': [{ type: 'SCALE', ingredient: 'Sugar syrup', percent: -50 }],
  'Sugar/70%': [{ type: 'SCALE', ingredient: 'Sugar syrup', percent: -30 }],
};

// Promotions (times in the POS's report time zone)
const PROMOTIONS = [
  { name: 'Happy Hour Frappé 15%', description: 'Every day 2-5 pm', type: 'PERCENT_OFF', value: 15, categories: ['Frappé'], startMinute: 14 * 60, endMinute: 17 * 60 },
  { name: 'Morning Americano -$0.50', description: 'Before 9 am', type: 'AMOUNT_OFF', value: 0.5, products: ['CF-002', 'CF-003'], startMinute: 6 * 60, endMinute: 9 * 60 },
  { name: 'Croissant Buy 2 Get 1', description: 'Weekends', type: 'BUY_X_GET_Y', buyQty: 2, getQty: 1, products: ['BK-001'], daysOfWeek: [0, 6] },
];

// ── API helpers ──────────────────────────────────────────────────────────────────────────────────
let token;
async function call(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${typeof json === 'object' ? [json.message].flat().join('; ') : String(json).slice(0, 200)}`);
  return json;
}
async function all(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const r = await call('GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}&limit=100`);
    out.push(...r.data);
    if (page >= r.meta.totalPages) return out;
  }
}
const log = (what, name, note = '') => console.log(`${what.padEnd(8)} ${name}${note ? ' ' + note : ''}`);
let created = 0, skipped = 0;
const skip = (name, why = 'already exists') => { log('skip', name, `(${why})`); skipped++; };
const make = async (name, fn) => {
  if (DRY) { log('would', name); created++; return null; }
  const r = await fn();
  log('created', name);
  created++;
  return r;
};

// ── Run ──────────────────────────────────────────────────────────────────────────────────────────
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (a super admin login).');
  process.exit(1);
}
if (STAFF_PASSWORD && STAFF_PASSWORD.length < 8) {
  console.error('STAFF_PASSWORD must have at least 8 characters.');
  process.exit(1);
}
token = (await call('POST', '/auth/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })).accessToken;

// Categories
const cats = new Map((await call('GET', '/categories')).map((c) => [c.name, c.id]));
for (const [name, nameKm] of CATEGORIES) {
  if (cats.has(name)) { skip(`category ${name}`); continue; }
  const c = await make(`category ${name}`, () => call('POST', '/categories', { name, nameKm }));
  if (c) cats.set(name, c.id);
}

// Drink options
const groups = new Map((await call('GET', '/modifiers')).map((g) => [g.name, g]));
for (const [i, [name, minSelect, maxSelect, options]] of OPTION_GROUPS.entries()) {
  if (groups.has(name)) { skip(`options ${name}`); continue; }
  const g = await make(`options ${name} (${options.map((o) => o[0]).join(', ')})`, () => call('POST', '/modifiers', {
    name, minSelect, maxSelect, sortOrder: i + 1, options: options.map(([n, priceDelta, isDefault]) => ({ name: n, priceDelta, isDefault: !!isDefault })),
  }));
  if (g) groups.set(name, g);
}

// Ingredients and products
const products = new Map((await all('/products?includeInactive=true')).map((p) => [p.sku, p]));
const ingId = {};
for (const [sku, name, unit, cost] of INGREDIENTS) {
  if (products.has(sku)) { skip(`ingredient ${sku} ${name}`); ingId[name] = products.get(sku).id; continue; }
  const p = await make(`ingredient ${sku} ${name}`, () => call('POST', '/products', {
    sku, name, unit, costPrice: cost, sellPrice: 0, isIngredient: true, taxable: false, trackStock: true, categoryId: cats.get('Ingredients'),
  }));
  if (p) ingId[name] = p.id;
}
for (const [sku, name, nameKm, cat, price, opts, recipe] of PRODUCTS) {
  if (products.has(sku)) { skip(`product ${sku} ${name}`); continue; }
  const cost = recipe.reduce((t, [ing, q]) => t + q * (INGREDIENTS.find((x) => x[1] === ing)?.[3] ?? 0), 0);
  const p = await make(`product ${sku} ${name} $${price.toFixed(2)}`, () => call('POST', '/products', {
    sku, name, nameKm, categoryId: cats.get(cat), unit: cat === 'Bakery' ? 'pcs' : 'cup', sellPrice: price,
    costPrice: Math.round((cost || price * 0.35) * 1e4) / 1e4, taxable: true, trackStock: false, onlineAvailable: true,
    modifierGroupIds: opts.map((g) => groups.get(g)?.id).filter(Boolean),
  }));
  if (p) products.set(sku, p);
  if (p && recipe.length) {
    await call('PUT', `/recipes/${p.id}`, { items: recipe.map(([ing, quantity]) => ({ ingredientId: ingId[ing], quantity })) });
    log('', `  recipe: ${recipe.map(([i, q]) => `${q} ${i}`).join(', ')}`);
  }
}

// How the options change recipes
if (!DRY) {
  for (const [key, effects] of Object.entries(EFFECTS)) {
    const [gName, oName] = key.split('/');
    const opt = groups.get(gName)?.options?.find((o) => o.name === oName);
    if (!opt) continue;
    // Setting the effects replaces them, so running again does not add them twice
    await call('PUT', `/recipes/options/${opt.id}/effects`, {
      effects: effects.map((e) => ({ type: e.type, ingredientId: e.ingredient && ingId[e.ingredient], replaceWithId: e.replaceWith && ingId[e.replaceWith], quantity: e.quantity, percent: e.percent })),
    });
    log('set', `recipe change ${key}`);
  }
}

// Promotions
const promos = new Set((await all('/promotions')).map((p) => p.name));
for (const pr of PROMOTIONS) {
  if (promos.has(pr.name)) { skip(`promotion ${pr.name}`); continue; }
  const { categories, products: skus, ...rest } = pr;
  await make(`promotion ${pr.name}`, () => call('POST', '/promotions', {
    ...rest, isActive: true,
    ...(categories && { categoryIds: categories.map((c) => cats.get(c)).filter(Boolean) }),
    ...(skus && { productIds: skus.map((s) => products.get(s)?.id).filter(Boolean) }),
  }));
}

// Staff accounts
if (STAFF_PASSWORD) {
  const stores = await call('GET', '/stores?includeInactive=true');
  const users = new Set((await all('/users')).map((u) => u.email.toLowerCase()));
  for (const code of STAFF_STORES) {
    const store = stores.find((s) => s.code === code);
    if (!store) { skip(`staff for ${code}`, 'no store with this code'); continue; }
    for (const [role, prefix, label] of [['STORE_MANAGER', 'manager', 'Manager'], ['CASHIER', 'cashier', 'Cashier']]) {
      const email = `${prefix}.${code.toLowerCase()}@pos.local`;
      if (users.has(email)) { skip(`user ${email}`); continue; }
      await make(`user ${email} (${label}, ${code} ${store.name})`, () => call('POST', '/users', {
        email, password: STAFF_PASSWORD, fullName: `${label} ${code}`, role, storeIds: [store.id],
      }));
    }
  }
} else {
  console.log('(no staff accounts: set STAFF_PASSWORD to create a manager and a cashier for ' + STAFF_STORES.join(', ') + ')');
}

console.log(`\n${DRY ? 'Would create' : 'Created'} ${created}, skipped ${skipped}.`);
