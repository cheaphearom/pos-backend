import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { brownConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { BrownSyncDto } from './brown.dto';

/** One menu item, as the POS needs it */
export interface BrownItem { sku: string; name: string; category: string; imageUrl: string | null; price: number }

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
        rows.push({
          sku,
          name: String(it?.item_name ?? sku).trim().slice(0, 200) || sku,
          category,
          imageUrl: /^https?:\/\//.test(pic) && !/\/(null)?$/.test(pic) ? pic : null,
          price: Math.round(price * 100) / 100,
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
}

@Injectable()
export class BrownService {
  private readonly log = new Logger('BrownSync');
  constructor(private readonly prisma: PrismaService) {}

  /** The address used when the Sync dialog leaves API URL empty. */
  settings() {
    return { menuUrl: brownConfig.menuUrl };
  }

  /**
   * Calls a BROWN menu API for one BROWN store. Two request formats:
   *  - .../brown_app_menu_listing/ (app API): flat fields
   *  - anything else (Client_API .../item_menu/): { dev_kid, function, datas: { ... } }
   */
  async fetchMenu(brownStoreId: string, devKid: string, accessToken: string, dataEncryption?: string, apiUrl?: string, username?: string): Promise<unknown> {
    const url = this.checkUrl(apiUrl || brownConfig.menuUrl);
    const dataEnc = dataEncryption || brownDataEnc(accessToken, devKid);
    const body = /brown_app_menu_listing/i.test(url.pathname)
      ? { dev_kid: devKid, username: username ?? '', data_enc: dataEnc, user_access_token: accessToken, action: 'list_item_menu', store_id: brownStoreId, service_type: '' }
      : {
          dev_kid: devKid,
          function: 'list_item_menu',
          datas: { store_id: brownStoreId, menu_id: '', action: 'list_item_menu', access_token: accessToken, data_encryption: dataEnc },
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
      response = await this.fetchMenu(brownStoreId, dto.devKid!, dto.accessToken!, dto.dataEncryption, dto.apiUrl?.trim(), dto.username?.trim());
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

        return { categoriesCreated: missing.length, productsCreated: fresh.length, productsUpdated: updated, addedToStore: added, storePrices };
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    this.log.log(`BROWN menu synced for ${store.code}: ${items.length} items, ${result.productsCreated} new, ${result.productsUpdated} updated`);
    return { store: store.code, brownStoreId: brownStoreId ?? null, items: items.length, ...result };
  }
}
