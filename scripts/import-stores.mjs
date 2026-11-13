#!/usr/bin/env node
// Import stores (outlets) from a JSON file through the API, as a super admin.
//
//   API_URL=https://your-pos/api/v1  ADMIN_EMAIL=you@example.com  ADMIN_PASSWORD=...  node scripts/import-stores.mjs outlets.json
//
// The file is a JSON array of outlets: { bc_outlet_no, name, address, phone, status } (other fields are ignored).
//   code    <- bc_outlet_no (capital letters and digits only), e.g. B061
//   active  <- status "3"; any other status is imported as an inactive store
// Stores whose code already exists are skipped, so running it twice is safe.
// DRY_RUN=1 only shows what would be created. Options: TAX_PERCENT (default 10), KHR_RATE (default 4100),
// CAFE_MODE (default 1: queue numbers and barista screen), COPY_PRODUCTS_FROM (a store code; default: every product).
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const API = (process.env.API_URL ?? 'http://localhost:3000/api/v1').replace(/\/+$/, '');
const DRY = process.env.DRY_RUN === '1';
const TAX = Number(process.env.TAX_PERCENT ?? 10);
const KHR = process.env.KHR_RATE === '' ? null : Number(process.env.KHR_RATE ?? 4100);
const CAFE = process.env.CAFE_MODE !== '0';
if (!file) {
  console.error('Usage: node scripts/import-stores.mjs outlets.json');
  process.exit(1);
}

/** "#25 st. 57,   Sangkat X,   _,   Cambodia" -> "#25 st. 57, Sangkat X, Cambodia" */
export function cleanAddress(a) {
  const parts = String(a ?? '').split(',').map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p && p !== '_');
  return parts.length ? parts.join(', ') : undefined;
}
export function toStore(o) {
  const code = String(o.bc_outlet_no ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const phone = String(o.phone ?? '').replace(/\s+/g, ' ').trim();
  return {
    code,
    name: String(o.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 150),
    address: cleanAddress(o.address),
    phone: phone ? phone.slice(0, 30) : undefined,
    active: String(o.status) === '3',
  };
}

const outlets = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(outlets)) throw new Error('The file must contain a JSON array of outlets');
const stores = outlets.map(toStore);
const bad = stores.filter((s) => !/^[A-Z0-9]{2,20}$/.test(s.code) || !s.name);
if (bad.length) {
  console.error('These outlets have no usable code (bc_outlet_no) or name:', bad);
  process.exit(1);
}
const dup = stores.map((s) => s.code).filter((c, i, a) => a.indexOf(c) !== i);
if (dup.length) {
  console.error('The same code is used twice in the file:', [...new Set(dup)].join(', '));
  process.exit(1);
}

async function call(method, path, token, body) {
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

const email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD;
if (!email || !password) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (a super admin login).');
  process.exit(1);
}
const { accessToken: token } = await call('POST', '/auth/login', null, { email, password });
const existing = await call('GET', '/stores?includeInactive=true', token);
const known = new Map(existing.map((s) => [s.code, s]));
let copyFrom;
if (process.env.COPY_PRODUCTS_FROM) {
  copyFrom = known.get(process.env.COPY_PRODUCTS_FROM.toUpperCase())?.id;
  if (!copyFrom) throw new Error(`COPY_PRODUCTS_FROM: no store with code ${process.env.COPY_PRODUCTS_FROM}`);
}

let created = 0, skipped = 0, failed = 0;
for (const s of stores) {
  if (known.has(s.code)) {
    console.log(`skip    ${s.code.padEnd(6)} ${s.name} (code already exists)`);
    skipped++;
    continue;
  }
  const body = {
    code: s.code, name: s.name, address: s.address, phone: s.phone, currency: 'USD',
    taxRate: Number((TAX / 100).toFixed(4)), khrRate: KHR, hasKitchen: CAFE,
    ...(copyFrom && { copyProductsFrom: copyFrom }),
  };
  if (DRY) {
    console.log(`would create ${s.code.padEnd(6)} ${s.active ? 'active  ' : 'INACTIVE'} ${s.name} | ${s.phone ?? '-'} | ${s.address ?? '-'}`);
    created++;
    continue;
  }
  try {
    const store = await call('POST', '/stores', token, body);
    if (!s.active) await call('PATCH', `/stores/${store.id}`, token, { isActive: false });
    console.log(`created ${s.code.padEnd(6)} ${s.active ? '' : '(inactive) '}${s.name}`);
    created++;
  } catch (e) {
    console.log(`FAILED  ${s.code.padEnd(6)} ${s.name}: ${e.message}`);
    failed++;
  }
}
console.log(`\n${DRY ? 'Would create' : 'Created'} ${created}, skipped ${skipped}, failed ${failed} (of ${stores.length}).`);
process.exit(failed ? 1 : 0);
