// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
/**
 * Price history: every change to a price customers pay, kept for good.
 *
 * Instead of each feature writing its own history, the prices are read before and after a change (snapshot) and
 * every difference is recorded: the normal price, each store's price (its own price or the normal one) and, for
 * drinks with sizes, each size's full price in each store. So edits, bulk and scheduled changes, BROWN sync and
 * imports are all recorded the same way, and none can forget to.
 */
import { Controller, Get, Global, Injectable, Logger, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, Role } from '@prisma/client';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { DateRangeQueryDto, dateFilter } from '../common/date-range';
import { CurrentPrincipal, Roles, Scopes } from '../common/decorators';
import { pageArgs, toPage } from '../common/pagination';
import { assertStoreAccess, Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';

export type PriceSource = 'CREATE' | 'EDIT' | 'STORE_PRICE' | 'SIZE_PRICES' | 'BULK' | 'SCHEDULED' | 'BROWN_SYNC' | 'IMPORT';
export interface PriceMeta { source: PriceSource; userId?: string | null; userName?: string | null; note?: string | null }
interface PricePoint { productId: string; storeId: string | null; optionId: string | null; sizeName: string | null; price: number }
export type PriceSnapshot = Map<string, PricePoint>;

export class PriceHistoryQueryDto extends DateRangeQueryDto {
  @IsOptional() @IsUUID()
  productId?: string;

  /** Product name or SKU */
  @IsOptional() @IsString() @MaxLength(100)
  search?: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Who made the change, for the history */
export const metaOf = (p: Principal | null | undefined, source: PriceSource, note?: string): PriceMeta => ({
  source, note, userId: p?.kind === 'user' ? p.id : null, userName: p ? (p.kind === 'api_key' ? `API: ${p.name}` : p.name) : null,
});

@Injectable()
export class PriceHistoryService {
  private readonly log = new Logger('PriceHistory');

  constructor(private readonly prisma: PrismaService) {}

  /** The prices customers pay now, for some products (or every product for sale). */
  async snapshot(productIds?: string[] | null): Promise<PriceSnapshot> {
    const snap: PriceSnapshot = new Map();
    if (productIds && !productIds.length) return snap;
    const products = await this.prisma.product.findMany({
      where: { isIngredient: false, ...(productIds && { id: { in: productIds } }) },
      select: {
        id: true, sellPrice: true,
        inventory: { where: { isListed: true }, select: { storeId: true, priceOverride: true } },
        modifierGroups: {
          where: { group: { name: { equals: 'Size', mode: 'insensitive' } } },
          select: { group: { select: { options: { where: { isActive: true }, select: { id: true, name: true, priceDelta: true } } } } },
        },
      },
    });
    const sizeIds = products.flatMap((p) => p.modifierGroups.flatMap((g) => g.group.options.map((o) => o.id)));
    const rows = sizeIds.length
      ? await this.prisma.productOption.findMany({ where: { productId: { in: products.map((p) => p.id) }, optionId: { in: sizeIds } }, select: { productId: true, storeId: true, optionId: true, priceDelta: true } })
      : [];
    for (const p of products) {
      const normal = Number(p.sellPrice);
      snap.set(`${p.id}||`, { productId: p.id, storeId: null, optionId: null, sizeName: null, price: r2(normal) });
      const options = p.modifierGroups[0]?.group.options ?? [];
      const mine = rows.filter((r) => r.productId === p.id);
      const used = new Set(mine.map((r) => r.optionId));
      const sizes = used.size ? options.filter((o) => used.has(o.id)) : options; // same rule as the size price table
      for (const inv of p.inventory) {
        const base = inv.priceOverride === null ? normal : Number(inv.priceOverride);
        if (!sizes.length) {
          snap.set(`${p.id}|${inv.storeId}|`, { productId: p.id, storeId: inv.storeId, optionId: null, sizeName: null, price: r2(base) });
          continue;
        }
        const own = mine.filter((r) => r.storeId === inv.storeId);
        for (const o of sizes) {
          const row = own.find((r) => r.optionId === o.id);
          if (own.length && !row) continue; // this size is not sold in this store
          const price = r2(base + Number(row ? row.priceDelta : o.priceDelta));
          snap.set(`${p.id}|${inv.storeId}|${o.id}`, { productId: p.id, storeId: inv.storeId, optionId: o.id, sizeName: o.name, price });
        }
      }
    }
    return snap;
  }

  /** Saves every price that differs between two snapshots (initial: every price of a new product). Never fails the caller. */
  async record(before: PriceSnapshot, after: PriceSnapshot, meta: PriceMeta, initial = false) {
    try {
      const data: Prisma.PriceChangeCreateManyInput[] = [];
      for (const [key, now] of after) {
        const was = before.get(key);
        if (was ? Math.abs(was.price - now.price) < 0.005 : !initial) continue;
        data.push({
          productId: now.productId, storeId: now.storeId, optionId: now.optionId, sizeName: now.sizeName,
          oldPrice: was ? was.price : null, newPrice: now.price, source: meta.source,
          userId: meta.userId ?? null, userName: meta.userName?.slice(0, 150) ?? null, note: meta.note?.slice(0, 200) ?? null,
        });
      }
      if (data.length) await this.prisma.priceChange.createMany({ data });
      return data.length;
    } catch (e) {
      this.log.error(`Could not save price history: ${(e as Error).message}`);
      return 0;
    }
  }

  /** Run a change and record the prices it changed. productIds null = every product (e.g. BROWN sync, import). */
  async track<T>(productIds: string[] | null, meta: PriceMeta, run: () => Promise<T>): Promise<T> {
    const before = await this.snapshot(productIds).catch(() => new Map() as PriceSnapshot);
    const out = await run();
    await this.record(before, await this.snapshot(productIds).catch(() => new Map() as PriceSnapshot), meta);
    return out;
  }

  async list(p: Principal, q: PriceHistoryQueryDto) {
    if (q.storeId) assertStoreAccess(p, q.storeId);
    const stores: Prisma.PriceChangeWhereInput = q.storeId
      ? { OR: [{ storeId: null }, { storeId: q.storeId }] }
      : p.storeIds === 'ALL' ? {} : { OR: [{ storeId: null }, { storeId: { in: p.storeIds } }] };
    const s = q.search?.trim();
    const where: Prisma.PriceChangeWhereInput = {
      ...stores,
      ...(q.productId && { productId: q.productId }),
      ...(s && { product: { OR: [{ name: { contains: s, mode: 'insensitive' } }, { sku: { contains: s, mode: 'insensitive' } }] } }),
      createdAt: dateFilter(q.from, q.to),
    };
    const [rows, total] = await Promise.all([
      this.prisma.priceChange.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...pageArgs(q),
        include: { product: { select: { name: true, sku: true } }, store: { select: { code: true, name: true } } },
      }),
      this.prisma.priceChange.count({ where }),
    ]);
    return toPage(rows.map((r) => ({ ...r, id: r.id.toString() })), total, q);
  }
}

@ApiTags('Products')
@ApiBearerAuth()
@Controller('price-history')
export class PriceHistoryController {
  constructor(private readonly history: PriceHistoryService) {}

  /** Price changes, newest first: by product, store, name / SKU and dates. Managers see their stores and normal prices. */
  @Roles(Role.STORE_MANAGER)
  @Scopes('products:read')
  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() q: PriceHistoryQueryDto) {
    return this.history.list(p, q);
  }
}

@Global()
@Module({ controllers: [PriceHistoryController], providers: [PriceHistoryService], exports: [PriceHistoryService] })
export class PriceHistoryModule {}
