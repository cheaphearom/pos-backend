import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';
import { brownConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { BrownSyncDto } from './brown.dto';

/** One menu item, as the POS needs it */
export interface BrownItem {
  sku: string;
  name: string;
  category: string;
  imageUrl: string | null;
  /** Lowest size price (the price shown on the POS tile); sizes add the difference */
  price: number;
  /** true when the response has the item's detail (sizes, options, add-ons): the full POS menu */
  hasDetail: boolean;
  /** S / M / L with their full price in this store, cheapest first */
  sizes: { name: string; price: number; isDefault: boolean }[];
  /** Free choices, e.g. Sweetness: Less Sweet-50%, Extra Sweet-150% */
  modifiers: { group: string; options: string[] }[];
  /** Paid extras, e.g. Personalize: Extra Caramel Syrup +0.50 */
  addons: { group: string; options: { name: string; price: number }[] }[];
}

/** Name of the option group that holds the sizes */
export const SIZE_GROUP = 'Size';

const money = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};
const clean = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** "Sweetness 3" and "Sweetness" are the same choice for the cashier */
const groupName = (v: unknown) => clean(v, 60).replace(/\s+\d+$/, '');

/** Sizes, free options and paid add-ons from an item's `detail` (brown_pos_menu_listing, action list_item_menu_full). */
function parseDetail(d: any): Pick<BrownItem, 'sizes' | 'modifiers' | 'addons'> {
  const sizes = new Map<string, { name: string; price: number; isDefault: boolean }>();
  for (const pr of Array.isArray(d?.prices) ? d.prices : []) {
    const name = clean(pr?.size_name, 60) || 'Regular';
    const price = money(pr?.price);
    if (price === null || sizes.has(name)) continue;
    sizes.set(name, { name, price, isDefault: String(pr?.default_size ?? '').trim() === '1' });
  }
  const sizeList = [...sizes.values()].sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
  if (sizeList.length && !sizeList.some((x) => x.isDefault)) sizeList[0].isDefault = true;

  const modifiers = new Map<string, Set<string>>();
  for (const g of Array.isArray(d?.modifiers) ? d.modifiers : []) {
    const name = groupName(g?.modifier_group);
    if (!name) continue;
    const set = modifiers.get(name) ?? new Set<string>();
    for (const o of Array.isArray(g?.modifier_options) ? g.modifier_options : []) {
      const opt = clean(o?.modifier_item, 60);
      if (opt) set.add(opt);
    }
    if (set.size) modifiers.set(name, set);
  }
  const addons = new Map<string, Map<string, number>>();
  for (const g of Array.isArray(d?.addons) ? d.addons : []) {
    const name = groupName(g?.addon_group) || 'Add-ons';
    const map = addons.get(name) ?? new Map<string, number>();
    for (const o of Array.isArray(g?.addon_options) ? g.addon_options : []) {
      const opt = clean(o?.addon_item, 60);
      const price = money(o?.addon_price);
      if (opt && price !== null && !map.has(opt)) map.set(opt, price);
    }
    if (map.size) addons.set(name, map);
  }
  return {
    sizes: sizeList,
    modifiers: [...modifiers].map(([group, set]) => ({ group, options: [...set] })),
    addons: [...addons].map(([group, map]) => ({ group, options: [...map].map(([name, price]) => ({ name, price })) })),
  };
}

/** These "categories" depend on the app user (favourites, recent orders), not on the menu. */
const PERSONAL = new Set(['my menu', 'recent', 'todays offer', "today's offer"]);
/** Groups whose items are also in a real category: an item found there only keeps it if it is nowhere else. */
const LAST_RESORT = new Set(['personal menu', 'all menu update']);

/**
 * data_encryption for the menu listing:
 *   Base64(YYYYMM) + Base64(HMAC-SHA512("BROWN_COFFEE" + access token + "CATEGORIZE_MENU_ITEM", dev_kid))
 * The month is the BROWN server's (Asia/Phnom_Penh).
 */
export function brownDataEnc(accessToken: string, devKid: string, now = new Date()): string {
  const ym = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit' }).format(now).replace('-', '');
  const hash = createHmac('sha512', devKid).update('BROWN_COFFEE' + accessToken + 'CATEGORIZE_MENU_ITEM').digest('base64');
  return Buffer.from(ym).toString('base64') + hash;
}

/** Finds the `groups` list wherever the response puts it (result.groups, data.result.groups, ...). */
function findGroups(v: unknown, depth = 0): any[] | null {
  if (!v || typeof v !== 'object' || depth > 4) return null;
  if (Array.isArray((v as any).groups)) return (v as any).groups;
  for (const x of Object.values(v)) {
    const g = findGroups(x, depth + 1);
    if (g) return g;
  }
  return null;
}

/** The menu items of a BROWN response, one per SKU, each in its first real category. */
export function parseBrownMenu(response: unknown): BrownItem[] {
  const groups = findGroups(response);
  if (!groups) {
    const r = response as any;
    const msg = [r?.name, r?.description, r?.message].filter((x) => typeof x === 'string').join(' · ');
    throw new BadGatewayException(`BROWN did not send a menu${msg ? `: ${msg}` : ''} (code ${r?.code ?? '?'})`);
  }
  const rows: (BrownItem & { rank: number })[] = [];
  groups.forEach((g, gi) => {
    const lastResort = LAST_RESORT.has(String(g?.group_name ?? '').trim().toLowerCase());
    (Array.isArray(g?.categories) ? g.categories : []).forEach((c: any, ci: number) => {
      const category = String(c?.category_name ?? '').trim().slice(0, 100);
      if (!category || PERSONAL.has(category.toLowerCase())) return;
      for (const it of Array.isArray(c?.items) ? c.items : []) {
        const sku = String(it?.item_id ?? '').trim();
        const price = Number(it?.price);
        if (!sku || sku.length > 50 || !Number.isFinite(price) || price < 0) continue;
        const pic = typeof it?.item_picture === 'string' ? it.item_picture.trim() : '';
        const hasDetail = !!it?.detail && typeof it.detail === 'object';
        const detail = hasDetail ? parseDetail(it.detail) : { sizes: [], modifiers: [], addons: [] };
        rows.push({
          sku,
          name: String(it?.item_name ?? sku).trim().slice(0, 200) || sku,
          category,
          imageUrl: /^https?:\/\//.test(pic) && !/\/(null)?$/.test(pic) ? pic : null,
          price: detail.sizes.length ? detail.sizes[0].price : Math.round(price * 100) / 100,
          hasDetail,
          ...detail,
          rank: (lastResort ? 1_000_000 : 0) + gi * 1000 + ci,
        });
      }
    });
  });
  const best = new Map<string, BrownItem & { rank: number }>();
  for (const r of rows) if (!best.has(r.sku) || r.rank < best.get(r.sku)!.rank) best.set(r.sku, r);
  return [...best.values()].map(({ rank: _, ...item }) => item);
}

export interface BrownSyncResult {
  store: string;
  brownStoreId: string | null;
  items: number;
  categoriesCreated: number;
  productsCreated: number;
  productsUpdated: number;
  addedToStore: number;
  storePrices: number;
  /** Items whose sizes, options or add-ons changed in this store */
  optionsUpdated: number;
}

/** One store in a "sync all stores" run */
export interface BrownSyncAllRow { store: string; name: string; ok: boolean; items?: number; productsCreated?: number; productsUpdated?: number; optionsUpdated?: number; error?: string }

/** A "sync all stores" run. It runs in the background; the Stores page asks for its progress. */
export interface BrownSyncAllJob {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  running: boolean;
  total: number;
  done: number;
  stopped: string | null;
  results: BrownSyncAllRow[];
}

/** What a "sync all stores" run needs (the same for every store) */
export interface BrownSyncAllInput { devKid: string; accessToken: string; dataEncryption?: string; apiUrl?: string; username?: string; groupIds?: string }

/** "420160070859702031, 620160270825902196" -> the BROWN group ids to ask for (empty = all, group_id "") */
export function brownGroupIds(v?: string): string[] {
  return [...new Set((v ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
}

@Injectable()
export class BrownService {
  private readonly log = new Logger('BrownSync');
  /** Recent "sync all stores" runs (in memory; the last 5) */
  private readonly jobs = new Map<string, BrownSyncAllJob>();
  constructor(private readonly prisma: PrismaService) {}

  /** The address used when the Sync dialog leaves API URL empty. */
  settings() {
    return { menuUrl: brownConfig.menuUrl };
  }

  /**
   * Calls a BROWN menu API for one BROWN store, once per BROWN group id (or once with group_id "" when none are given),
   * and joins the groups of all answers into one menu.
   */
  async fetchMenu(brownStoreId: string, devKid: string, accessToken: string, dataEncryption?: string, apiUrl?: string, username?: string, groupIds: string[] = []): Promise<unknown> {
    const ids = groupIds.length ? groupIds : [''];
    if (ids.length === 1) return this.fetchMenuPart(brownStoreId, devKid, accessToken, dataEncryption, apiUrl, username, ids[0]);
    const groups: unknown[] = [];
    for (const gid of ids) {
      const part = await this.fetchMenuPart(brownStoreId, devKid, accessToken, dataEncryption, apiUrl, username, gid);
      const g = findGroups(part);
      if (!g) {
        parseBrownMenu(part); // throws the BROWN error message
      }
      groups.push(...(g ?? []));
    }
    return { code: 100, result: { groups } };
  }

  /**
   * One BROWN menu request. Request bodies, by address:
   *  - Client_API .../brown_pos_menu_listing/ (POS menu with sizes, options, add-ons; the default):
   *      { dev_kid, function: list_item_menu_full, datas: { data_encryption, access_token, action, group_id, store_id, service_type: pickup } }
   *  - API_V16 .../brown_pos_menu_listing/ or .../brown_app_menu_listing/ (flat fields with username)
   *  - Client_API .../item_menu/ (older): { dev_kid, function: list_item_menu, datas: { store_id, menu_id, action, access_token, data_encryption } }
   */
  private async fetchMenuPart(brownStoreId: string, devKid: string, accessToken: string, dataEncryption: string | undefined, apiUrl: string | undefined, username: string | undefined, groupId: string): Promise<unknown> {
    const url = this.checkUrl(apiUrl || brownConfig.menuUrl);
    const dataEnc = dataEncryption || brownDataEnc(accessToken, devKid);
    const posApi = /brown_pos_menu_listing/i.test(url.pathname);
    const action = posApi ? 'list_item_menu_full' : 'list_item_menu';
    const flat = /_menu_listing/i.test(url.pathname) && !/client_api/i.test(url.pathname);
    const body = flat
      ? {
          dev_kid: devKid, username: username ?? '', data_enc: dataEnc, user_access_token: accessToken,
          action, store_id: brownStoreId, service_type: posApi ? 'pickup' : '', ...(posApi && { group_id: groupId }),
        }
      : posApi
        ? {
            dev_kid: devKid,
            function: action,
            datas: { data_encryption: dataEnc, access_token: accessToken, action, group_id: groupId, store_id: brownStoreId, service_type: 'pickup' },
          }
        : {
            dev_kid: devKid,
            function: action,
            datas: { store_id: brownStoreId, menu_id: '', action, access_token: accessToken, data_encryption: dataEnc },
          };
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(brownConfig.timeoutMs),
      });
    } catch (e) {
      const why = (e as Error).name === 'TimeoutError' ? 'no answer in time' : ((e as any).cause?.code ?? (e as Error).message);
      throw new BadGatewayException(`Cannot reach the BROWN API (${url.host}): ${why}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new BadGatewayException(`The BROWN API answered ${res.status} but not with JSON: ${text.slice(0, 160)}`);
    }
  }

  /**
   * The API URL comes from an admin, but the POS server sends the request, so it must not point at the
   * POS itself or its own containers (database, Redis...). Office addresses such as 192.168.x.x are allowed.
   */
  private checkUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException('API URL is not a valid address');
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const blocked =
      !['http:', 'https:'].includes(url.protocol) ||
      ['localhost', 'api', 'web', 'postgres', 'redis', 'cloudflared', 'quicktunnel', 'loki', 'grafana', 'ml-detector', 'metadata.google.internal'].includes(host) ||
      host.endsWith('.localhost') ||
      /^(127\.|0\.|169\.254\.)/.test(host) ||
      host === '::1' || host === '0.0.0.0';
    if (blocked) throw new BadRequestException(`API URL cannot point at ${host}: use the BROWN server's address`);
    return url;
  }

  /** Adds new items, updates existing ones (same SKU), and lists all of them in the store. */
  async sync(storeId: string, dto: BrownSyncDto): Promise<BrownSyncResult> {
    const store = await this.prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { id: true, code: true, externalId: true } });
    const brownStoreId = dto.brownStoreId?.trim() || store.externalId;
    if (brownStoreId && brownStoreId !== store.externalId) {
      const other = await this.prisma.store.findFirst({ where: { externalId: brownStoreId, id: { not: storeId } }, select: { code: true } });
      if (other) throw new ConflictException(`BROWN store id ${brownStoreId} already belongs to store ${other.code}`);
    }

    let response: unknown = dto.response;
    if (!response) {
      if (!brownStoreId) throw new BadRequestException('Enter the BROWN store id');
      response = await this.fetchMenu(brownStoreId, dto.devKid!, dto.accessToken!, dto.dataEncryption, dto.apiUrl?.trim(), dto.username?.trim(), brownGroupIds(dto.groupIds));
    }
    const items = parseBrownMenu(response);
    if (!items.length) throw new BadGatewayException('The BROWN menu has no items for this store');

    const result = await this.prisma.$transaction(
      async (tx) => {
        if (brownStoreId && brownStoreId !== store.externalId) await tx.store.update({ where: { id: storeId }, data: { externalId: brownStoreId } });

        // Categories (top level), reused by name
        const names = [...new Set(items.map((i) => i.category))];
        const have = await tx.category.findMany({ where: { parentId: null, name: { in: names } }, select: { id: true, name: true } });
        const catId = new Map(have.map((c) => [c.name, c.id]));
        const missing = names.filter((n) => !catId.has(n));
        for (const name of missing) catId.set(name, (await tx.category.create({ data: { name }, select: { id: true } })).id);

        // Products: same SKU = update name, picture and category; new SKU = create (no stock tracking, no recipe yet)
        const existing = await tx.product.findMany({
          where: { sku: { in: items.map((i) => i.sku) } },
          select: { id: true, sku: true, name: true, imageUrl: true, categoryId: true, sellPrice: true },
        });
        const bySku = new Map(existing.map((p) => [p.sku, p]));
        let updated = 0;
        for (const i of items) {
          const p = bySku.get(i.sku);
          if (!p) continue;
          const data = {
            ...(p.name !== i.name && { name: i.name }),
            ...(i.imageUrl && p.imageUrl !== i.imageUrl && { imageUrl: i.imageUrl }),
            ...(p.categoryId !== catId.get(i.category) && { categoryId: catId.get(i.category) }),
          };
          if (Object.keys(data).length) {
            await tx.product.update({ where: { id: p.id }, data });
            updated++;
          }
        }
        const fresh = items.filter((i) => !bySku.has(i.sku));
        if (fresh.length) {
          await tx.product.createMany({
            data: fresh.map((i) => ({ sku: i.sku, name: i.name, categoryId: catId.get(i.category), sellPrice: i.price, imageUrl: i.imageUrl, trackStock: false, unit: 'pcs' })),
            skipDuplicates: true,
          });
        }
        const products = await tx.product.findMany({ where: { sku: { in: items.map((i) => i.sku) } }, select: { id: true, sku: true, sellPrice: true } });
        const prod = new Map(products.map((p) => [p.sku, p]));

        // The store sells every item; its price is saved as the store's own price when it differs from the base price
        const inv = await tx.inventory.findMany({ where: { storeId, productId: { in: products.map((p) => p.id) } }, select: { productId: true, isListed: true, priceOverride: true } });
        const invBy = new Map(inv.map((v) => [v.productId, v]));
        let added = 0;
        let storePrices = 0;
        const create: { storeId: string; productId: string; isListed: boolean; priceOverride: number | null }[] = [];
        for (const i of items) {
          const p = prod.get(i.sku)!;
          const override = Math.abs(Number(p.sellPrice) - i.price) < 0.005 ? null : i.price;
          if (override !== null) storePrices++;
          const v = invBy.get(p.id);
          if (!v) {
            create.push({ storeId, productId: p.id, isListed: true, priceOverride: override });
            added++;
          } else if (!v.isListed || (v.priceOverride === null ? override !== null : override === null || Number(v.priceOverride) !== override)) {
            if (!v.isListed) added++;
            await tx.inventory.update({ where: { storeId_productId: { storeId, productId: p.id } }, data: { isListed: true, priceOverride: override } });
          }
        }
        if (create.length) await tx.inventory.createMany({ data: create, skipDuplicates: true });

        const optionsUpdated = await this.syncOptions(tx, storeId, items.filter((i) => i.hasDetail), prod);

        return { categoriesCreated: missing.length, productsCreated: fresh.length, productsUpdated: updated, addedToStore: added, storePrices, optionsUpdated };
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    this.log.log(`BROWN menu synced for ${store.code}: ${items.length} items, ${result.productsCreated} new, ${result.productsUpdated} updated, ${result.optionsUpdated} with new options`);
    return { store: store.code, brownStoreId: brownStoreId ?? null, items: items.length, ...result };
  }

  /**
   * Sizes, options and add-ons from the full BROWN menu:
   *  - option groups and options are found or created by name (Size: S/M/L; BROWN option groups; add-on groups)
   *  - each item offers exactly its BROWN groups (replacing the ones it had)
   *  - this store's rows in product_options say which options the item offers here, at what price, and the default size
   * Changed items get a new updated_at, so cashier screens download them again.
   */
  private async syncOptions(tx: Prisma.TransactionClient, storeId: string, items: BrownItem[], prod: Map<string, { id: string }>): Promise<number> {
    if (!items.length) return 0;

    // 1. Groups: Size (required), BROWN options (optional, one), add-ons (optional, several)
    const groupSpec = new Map<string, { minSelect: number; maxSelect: number; sortOrder: number }>();
    if (items.some((i) => i.sizes.length > 1)) groupSpec.set(SIZE_GROUP, { minSelect: 1, maxSelect: 1, sortOrder: 0 });
    for (const i of items) {
      for (const m of i.modifiers) if (!groupSpec.has(m.group)) groupSpec.set(m.group, { minSelect: 0, maxSelect: 1, sortOrder: 10 + groupSpec.size });
      for (const a of i.addons) if (!groupSpec.has(a.group)) groupSpec.set(a.group, { minSelect: 0, maxSelect: 20, sortOrder: 50 + groupSpec.size });
    }
    const haveGroups = await tx.modifierGroup.findMany({ where: { name: { in: [...groupSpec.keys()] } }, select: { id: true, name: true } });
    const groupId = new Map(haveGroups.map((g) => [g.name, g.id]));
    for (const [name, spec] of groupSpec) if (!groupId.has(name)) groupId.set(name, (await tx.modifierGroup.create({ data: { name, ...spec }, select: { id: true } })).id);

    // 2. Options, found or created by name inside their group
    const wanted = new Map<string, Map<string, number>>(); // group -> option name -> default price for a new option
    const want = (g: string, o: string, price = 0) => {
      const m = wanted.get(g) ?? new Map<string, number>();
      if (!m.has(o)) m.set(o, price);
      wanted.set(g, m);
    };
    for (const i of items) {
      if (i.sizes.length > 1) for (const s of i.sizes) want(SIZE_GROUP, s.name);
      for (const m of i.modifiers) for (const o of m.options) want(m.group, o);
      for (const a of i.addons) for (const o of a.options) want(a.group, o.name, o.price);
    }
    const optionId = new Map<string, string>(); // "group|option" -> id
    for (const [g, opts] of wanted) {
      const gid = groupId.get(g)!;
      const have = await tx.modifierOption.findMany({ where: { groupId: gid, name: { in: [...opts.keys()] } }, select: { id: true, name: true } });
      for (const o of have) optionId.set(`${g}|${o.name}`, o.id);
      let sort = await tx.modifierOption.count({ where: { groupId: gid } });
      for (const [name, price] of opts) {
        if (optionId.has(`${g}|${name}`)) continue;
        const o = await tx.modifierOption.create({ data: { groupId: gid, name, priceDelta: price, sortOrder: ++sort }, select: { id: true } });
        optionId.set(`${g}|${name}`, o.id);
      }
    }

    // 3. Per item: its groups (in order) and this store's options with prices
    const productIds = items.map((i) => prod.get(i.sku)!.id);
    const [links, rows] = await Promise.all([
      tx.productModifierGroup.findMany({ where: { productId: { in: productIds } }, orderBy: { sortOrder: 'asc' }, select: { productId: true, groupId: true } }),
      tx.productOption.findMany({ where: { storeId, productId: { in: productIds } }, select: { id: true, productId: true, optionId: true, priceDelta: true, isDefault: true } }),
    ]);
    const linksBy = new Map<string, string[]>();
    for (const l of links) linksBy.set(l.productId, [...(linksBy.get(l.productId) ?? []), l.groupId]);
    const rowsBy = new Map<string, typeof rows>();
    for (const r of rows) rowsBy.set(r.productId, [...(rowsBy.get(r.productId) ?? []), r]);

    const changed: string[] = [];
    for (const i of items) {
      const pid = prod.get(i.sku)!.id;
      const groups: string[] = [];
      const desired = new Map<string, { price: number; isDefault: boolean }>();
      if (i.sizes.length > 1) {
        groups.push(groupId.get(SIZE_GROUP)!);
        for (const s of i.sizes) desired.set(optionId.get(`${SIZE_GROUP}|${s.name}`)!, { price: Math.round((s.price - i.price) * 100) / 100, isDefault: s.isDefault });
      }
      for (const m of i.modifiers) {
        groups.push(groupId.get(m.group)!);
        for (const o of m.options) desired.set(optionId.get(`${m.group}|${o}`)!, { price: 0, isDefault: false });
      }
      for (const a of i.addons) {
        if (!groups.includes(groupId.get(a.group)!)) groups.push(groupId.get(a.group)!);
        for (const o of a.options) desired.set(optionId.get(`${a.group}|${o.name}`)!, { price: o.price, isDefault: false });
      }
      const uniqueGroups = [...new Set(groups)];
      let itemChanged = false;

      // groups the item offers (same for every store): replaced when different
      if ((linksBy.get(pid) ?? []).join() !== uniqueGroups.join()) {
        await tx.productModifierGroup.deleteMany({ where: { productId: pid } });
        if (uniqueGroups.length) await tx.productModifierGroup.createMany({ data: uniqueGroups.map((g, n) => ({ productId: pid, groupId: g, sortOrder: n })) });
        await tx.product.update({ where: { id: pid }, data: { updatedAt: new Date() } });
        itemChanged = true;
      }
      // this store's options and prices
      const current = rowsBy.get(pid) ?? [];
      const stale = current.filter((r) => !desired.has(r.optionId)).map((r) => r.id);
      if (stale.length) {
        await tx.productOption.deleteMany({ where: { id: { in: stale } } });
        itemChanged = true;
      }
      const toCreate: Prisma.ProductOptionCreateManyInput[] = [];
      for (const [oid, want] of desired) {
        const row = current.find((r) => r.optionId === oid);
        if (!row) toCreate.push({ productId: pid, optionId: oid, storeId, priceDelta: want.price, isDefault: want.isDefault });
        else if (Number(row.priceDelta) !== want.price || row.isDefault !== want.isDefault) {
          await tx.productOption.update({ where: { id: row.id }, data: { priceDelta: want.price, isDefault: want.isDefault } });
          itemChanged = true;
        }
      }
      if (toCreate.length) {
        await tx.productOption.createMany({ data: toCreate, skipDuplicates: true });
        itemChanged = true;
      }
      if (itemChanged) changed.push(pid);
    }
    // cashier screens of this store download changed items again
    if (changed.length) await tx.inventory.updateMany({ where: { storeId, productId: { in: changed } }, data: { updatedAt: new Date() } });
    return changed.length;
  }

  /** Starts syncing every active store that has a BROWN store id. Only one run at a time. */
  startSyncAll(input: BrownSyncAllInput, onDone?: (job: BrownSyncAllJob) => void): Promise<BrownSyncAllJob> | BrownSyncAllJob {
    const running = [...this.jobs.values()].find((j) => j.running);
    if (running) return running;
    return this.prisma.store
      .findMany({ where: { isActive: true, externalId: { not: null } }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } })
      .then((stores) => {
        if (!stores.length) throw new BadRequestException('No active store has a BROWN store id yet');
        const job: BrownSyncAllJob = { id: randomUUID(), startedAt: new Date().toISOString(), finishedAt: null, running: true, total: stores.length, done: 0, stopped: null, results: [] };
        this.jobs.set(job.id, job);
        for (const id of [...this.jobs.keys()].slice(0, -5)) this.jobs.delete(id);
        // the same data_encryption works for every store (it depends on the token and the month)
        const dataEncryption = input.dataEncryption || brownDataEnc(input.accessToken, input.devKid);
        void (async () => {
          let failedInARow = 0;
          for (const s of stores) {
            try {
              const r = await this.sync(s.id, { devKid: input.devKid, accessToken: input.accessToken, dataEncryption, apiUrl: input.apiUrl, username: input.username, groupIds: input.groupIds });
              job.results.push({ store: s.code, name: s.name, ok: true, items: r.items, productsCreated: r.productsCreated, productsUpdated: r.productsUpdated, optionsUpdated: r.optionsUpdated });
              failedInARow = 0;
            } catch (e) {
              job.results.push({ store: s.code, name: s.name, ok: false, error: (e as Error).message });
              failedInARow++;
            }
            job.done++;
            // the same error 3 times in a row (BROWN unreachable, token expired...): stop instead of failing every store
            const last = job.results.slice(-3);
            if (failedInARow >= 3 && last.every((r) => r.error === last[0].error)) {
              job.stopped = `Stopped after 3 stores with the same error: ${last[0].error}`;
              break;
            }
          }
          job.running = false;
          job.finishedAt = new Date().toISOString();
          this.log.log(`BROWN sync all: ${job.results.filter((r) => r.ok).length} of ${job.total} stores synced${job.stopped ? ' (stopped)' : ''}`);
          onDone?.(job);
        })();
        return job;
      });
  }

  /** Progress of a "sync all stores" run */
  syncAllStatus(id: string): BrownSyncAllJob {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundException('This sync run is not known (the server may have restarted). Start it again.');
    return job;
  }
}
