// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { pageArgs, toPage } from '../common/pagination';
import { assertStoreAccess, Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';
import { PriceHistoryService, PriceMeta } from '../prices/price-history.module';
import { BulkPriceDto, CreateProductDto, ProductQueryDto, SetSizePricesDto, UpdateProductDto } from './products.dto';


export interface BulkPriceRow {
  productId: string; sku: string; name: string; sized: boolean; skipped?: string;
  normal: { before: number; after: number } | null;
  stores: { storeId: string; code: string; before?: number; after?: number; sizes?: { optionId: string; name: string; before: number | null; after: number | null }[] }[];
}

/** Rounds to the nearest step (0.05, 0.10, 0.25), or to cents. */
export function roundTo(v: number, step?: number | null) {
  const r = step ? Math.round(v / step) * step : v;
  return Math.round(r * 100) / 100;
}

/** The new price: + / - a percent, + / - an amount, or a fixed price; then rounded. */
export function changePrice(v: number, c: { type: 'PERCENT' | 'AMOUNT' | 'SET'; value: number }, step?: number | null) {
  const n = c.type === 'PERCENT' ? v * (1 + c.value / 100) : c.type === 'AMOUNT' ? v + c.value : c.value;
  return roundTo(n, step);
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly history: PriceHistoryService,
  ) {}

  /** The product's size group (a drink option group named "Size"), with the sizes it uses */
  async sizeGroup(productId: string) {
    const link = await this.prisma.productModifierGroup.findFirst({
      where: { productId, group: { name: { equals: 'Size', mode: 'insensitive' } } },
      select: { group: { select: { id: true, name: true, options: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true, priceDelta: true, isDefault: true } } } } },
    });
    if (!link) return null;
    const used = await this.prisma.productOption.findMany({ where: { productId, option: { groupId: link.group.id } }, select: { optionId: true }, distinct: ['optionId'] });
    const usedIds = new Set(used.map((u) => u.optionId));
    // BROWN drinks use some sizes of the group (S, M, L): show only those; otherwise every size
    const options = usedIds.size ? link.group.options.filter((o) => usedIds.has(o.id)) : link.group.options;
    return { ...link.group, options };
  }

  /**
   * Full price of each size in each store: the store's price (its own, or the selling price) plus the size's extra.
   * Null = the store does not offer that size.
   */
  async sizePrices(id: string) {
    const product = await this.prisma.product.findUniqueOrThrow({ where: { id }, select: { sellPrice: true } });
    const group = await this.sizeGroup(id);
    if (!group || !group.options.length) return { groupId: null, sizes: [], stores: [] };
    const [inv, rows] = await Promise.all([
      this.prisma.inventory.findMany({ where: { productId: id }, select: { storeId: true, priceOverride: true } }),
      this.prisma.productOption.findMany({ where: { productId: id, option: { groupId: group.id } }, select: { storeId: true, optionId: true, priceDelta: true } }),
    ]);
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      groupId: group.id,
      sizes: group.options.map((o) => ({ id: o.id, name: o.name })),
      stores: inv.map((v) => {
        const base = Number(v.priceOverride ?? product.sellPrice);
        const own = rows.filter((r) => r.storeId === v.storeId);
        return {
          storeId: v.storeId,
          prices: Object.fromEntries(group.options.map((o) => {
            const r = own.find((x) => x.optionId === o.id);
            return [o.id, own.length ? (r ? round(base + Number(r.priceDelta)) : null) : round(base + Number(o.priceDelta))];
          })),
        };
      }),
    };
  }

  /**
   * Save full size prices per store. The store's price becomes its lowest size price (the price on the POS tile),
   * and each size keeps the difference, so sales and the POS work as before.
   */
  async setSizePrices(id: string, dto: SetSizePricesDto) {
    const product = await this.prisma.product.findUniqueOrThrow({ where: { id }, select: { sellPrice: true, name: true } });
    const group = await this.sizeGroup(id);
    if (!group) throw new BadRequestException(`${product.name} has no Size option group`);
    const sizeIds = new Set(group.options.map((o) => o.id));
    for (const s of dto.stores) {
      if (s.prices.some((p) => !sizeIds.has(p.optionId))) throw new BadRequestException('Unknown size for this product');
      if (!s.prices.some((p) => p.price !== null)) throw new BadRequestException('Give at least one size price for each store');
    }
    await this.prisma.$transaction((tx) => this.writeSizePrices(tx, id, Number(product.sellPrice), group, dto.stores));
    return this.sizePrices(id);
  }

  /** Saves full size prices for some stores (smallest = the store's price, others as differences). Inside a transaction. */
  async writeSizePrices(tx: Prisma.TransactionClient, id: string, sellPrice: number, group: { id: string; options: { id: string; isDefault: boolean }[] }, stores: { storeId: string; prices: { optionId: string; price: number | null }[] }[]) {
      for (const s of stores) {
        const priced = s.prices.filter((p): p is { optionId: string; price: number } => p.price !== null);
        const base = Math.min(...priced.map((p) => p.price));
        const priceOverride = Math.abs(base - sellPrice) < 0.005 ? null : base;
        const before = await tx.productOption.findMany({ where: { productId: id, storeId: s.storeId, option: { groupId: group.id } }, select: { optionId: true, isDefault: true } });
        const wasDefault = before.find((b) => b.isDefault)?.optionId;
        const defaultId = priced.some((p) => p.optionId === wasDefault) ? wasDefault : (group.options.find((o) => o.isDefault && priced.some((p) => p.optionId === o.id))?.id ?? priced[0].optionId);
        // updatedAt changes, so the store's POS screens download the new prices
        await tx.inventory.upsert({
          where: { storeId_productId: { storeId: s.storeId, productId: id } },
          update: { priceOverride, updatedAt: new Date() },
          create: { storeId: s.storeId, productId: id, priceOverride, isListed: true },
        });
        await tx.productOption.deleteMany({ where: { productId: id, storeId: s.storeId, option: { groupId: group.id } } });
        await tx.productOption.createMany({
          data: priced.map((p) => ({ productId: id, storeId: s.storeId, optionId: p.optionId, priceDelta: Math.round((p.price - base) * 100) / 100, isDefault: p.optionId === defaultId })),
        });
      }
  }

  /**
   * Bulk price change for ticked products. Preview (nothing saved) or apply (one transaction).
   * ALL: the normal price, every store's own price and size prices. STORE: that store's price and size prices only.
   * Drinks with sizes: %, $ and rounding apply to each size; "set" makes the smallest size that price and keeps the
   * differences between sizes.
   */
  async bulkPrice(dto: BulkPriceDto, apply: boolean, meta: PriceMeta = { source: 'BULK' }) {
    if (dto.scope === 'STORE' && !dto.storeId) throw new BadRequestException('Choose the store');
    const products = await this.prisma.product.findMany({
      where: { id: { in: dto.productIds } },
      select: { id: true, sku: true, name: true, sellPrice: true, isIngredient: true, inventory: { select: { storeId: true, priceOverride: true, isListed: true, store: { select: { code: true } } } } },
      orderBy: { name: 'asc' },
    });
    const f = (v: number) => changePrice(v, dto.change, dto.round);
    const rows: BulkPriceRow[] = [];
    for (const prod of products) {
      const base: BulkPriceRow = { productId: prod.id, sku: prod.sku, name: prod.name, sized: false, normal: null, stores: [] };
      if (prod.isIngredient) { rows.push({ ...base, skipped: 'Ingredient: no selling price' }); continue; }
      const inv = prod.inventory.filter((i) => i.isListed && (dto.scope === 'ALL' || i.storeId === dto.storeId)).sort((a, b) => a.store.code.localeCompare(b.store.code));
      if (!inv.length) { rows.push({ ...base, skipped: dto.scope === 'STORE' ? 'Not sold in this store' : 'Not sold in any store' }); continue; }
      const oldNormal = Number(prod.sellPrice);
      const newNormal = dto.scope === 'ALL' ? f(oldNormal) : oldNormal;
      const group = await this.sizeGroup(prod.id);
      const sp = group?.options.length ? await this.sizePrices(prod.id) : null;
      const row: BulkPriceRow = { ...base, sized: !!sp, normal: dto.scope === 'ALL' ? { before: oldNormal, after: newNormal } : null };
      for (const i of inv) {
        if (sp) {
          const cur = sp.stores.find((x) => x.storeId === i.storeId)?.prices ?? {};
          const priced = Object.values(cur).filter((v): v is number => v !== null);
          if (!priced.length) continue;
          const shift = dto.change.type === 'SET' ? dto.change.value - Math.min(...priced) : 0;
          row.stores.push({
            storeId: i.storeId, code: i.store.code,
            sizes: sp.sizes.map((z) => {
              const before = cur[z.id] ?? null;
              const after = before === null ? null : dto.change.type === 'SET' ? roundTo(before + shift, dto.round) : f(before);
              return { optionId: z.id, name: z.name, before, after };
            }),
          });
        } else {
          const own = i.priceOverride === null ? null : Number(i.priceOverride);
          const before = own ?? oldNormal;
          const after = dto.scope === 'ALL' ? (own === null ? newNormal : f(own)) : f(before);
          row.stores.push({ storeId: i.storeId, code: i.store.code, before, after });
        }
      }
      rows.push(row);
    }
    const bad = rows.find((r) => r.normal && r.normal.after < 0 || r.stores.some((s) => (s.after ?? 0) < 0 || s.sizes?.some((z) => (z.after ?? 0) < 0)));
    if (bad) throw new BadRequestException(`${bad.name} would get a price below $0`);
    if (apply) {
      const changedIds = rows.filter((r) => !r.skipped).map((r) => r.productId);
      const before = await this.history.snapshot(changedIds);
      await this.prisma.$transaction(async (tx) => {
        for (const r of rows) {
          if (r.skipped) continue;
          const normal = r.normal?.after ?? Number(products.find((x) => x.id === r.productId)!.sellPrice);
          if (r.normal && r.normal.after !== r.normal.before) await tx.product.update({ where: { id: r.productId }, data: { sellPrice: r.normal.after } });
          if (r.sized) {
            const group = (await this.sizeGroup(r.productId))!;
            await this.writeSizePrices(tx, r.productId, normal, group, r.stores.map((s) => ({ storeId: s.storeId, prices: s.sizes!.map((z) => ({ optionId: z.optionId, price: z.after })) })));
          } else {
            for (const s of r.stores) {
              await tx.inventory.update({
                where: { storeId_productId: { storeId: s.storeId, productId: r.productId } },
                data: { priceOverride: Math.abs(s.after! - normal) < 0.005 ? null : s.after },
              });
            }
          }
        }
      }, { timeout: 120_000 });
      await this.history.record(before, await this.history.snapshot(changedIds), meta);
    }
    return { applied: apply, changed: rows.filter((r) => !r.skipped).length, skipped: rows.filter((r) => r.skipped).length, rows };
  }

  async list(p: Principal, q: ProductQueryDto) {
    if (q.storeId) assertStoreAccess(p, q.storeId);
    // a group (e.g. Beverages) also lists the products of its categories
    const kids = q.categoryId ? await this.prisma.category.findMany({ where: { parentId: q.categoryId }, select: { id: true } }) : [];
    const where: Prisma.ProductWhereInput = {
      ...(q.categoryId && { categoryId: { in: [q.categoryId, ...kids.map((k) => k.id)] } }),
      ...(!q.includeInactive && { isActive: true }),
      ...(q.kind && { isIngredient: q.kind === 'ingredient' }),
      ...(q.storeId && q.listing === 'listed' && { inventory: { some: { storeId: q.storeId, isListed: true } } }),
      ...(q.storeId && q.listing === 'unlisted' && { NOT: { inventory: { some: { storeId: q.storeId, isListed: true } } } }),
      ...(q.search && {
        OR: [
          { name: { contains: q.search, mode: 'insensitive' } },
          { sku: { contains: q.search, mode: 'insensitive' } },
          { barcode: q.search },
        ],
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { name: 'asc' },
        include: {
          category: { select: { id: true, name: true } },
          modifierGroups: { orderBy: { sortOrder: 'asc' }, select: { groupId: true } },
          ...(q.storeId && { inventory: { where: { storeId: q.storeId } } }),
        },
        ...pageArgs(q),
      }),
      this.prisma.product.count({ where }),
    ]);
    return toPage(rows.map((r) => withStorePrice(r, q.storeId)), total, q);
  }

  async get(p: Principal, id: string, storeId?: string) {
    if (storeId) assertStoreAccess(p, storeId);
    const product = await this.prisma.product.findUniqueOrThrow({
      where: { id },
      include: {
        category: { select: { id: true, name: true } },
        inventory: {
          where: p.storeIds === 'ALL' ? {} : { storeId: { in: p.storeIds } },
          include: { store: { select: { id: true, code: true, name: true } } },
        },
      },
    });
    return withStorePrice(product, storeId);
  }

  /**
   * Compact list of every active product this store sells, with its price and stock, for the POS
   * to keep offline. With `since`, only products whose data changed after that time
   * (including deactivated or no longer sold ones, so the POS can remove them).
   */
  async catalog(p: Principal, storeId: string, since?: string) {
    assertStoreAccess(p, storeId);
    const sinceDate = since ? new Date(since) : undefined;
    if (sinceDate && isNaN(sinceDate.getTime())) throw new NotFoundException('Invalid since date');
    const serverTime = new Date().toISOString();
    const rows = await this.prisma.product.findMany({
      where: sinceDate
        ? { OR: [{ updatedAt: { gt: sinceDate } }, { inventory: { some: { storeId, updatedAt: { gt: sinceDate } } } }] }
        : { isActive: true, isIngredient: false, inventory: { some: { storeId, isListed: true } } },
      select: {
        id: true, sku: true, barcode: true, name: true, nameKm: true, unit: true, sellPrice: true, taxable: true,
        trackStock: true, isActive: true, categoryId: true, imageUrl: true, isIngredient: true,
        inventory: { where: { storeId }, select: { quantity: true, priceOverride: true, isListed: true } },
        modifierGroups: { orderBy: { sortOrder: 'asc' }, select: { groupId: true } },
        productOptions: { where: { storeId }, select: { optionId: true, priceDelta: true, isDefault: true, option: { select: { groupId: true } } } },
      },
      orderBy: { name: 'asc' },
    });
    return {
      serverTime,
      full: !sinceDate,
      products: rows.map(({ inventory, sellPrice, modifierGroups, isIngredient, productOptions, ...r }) => ({
        ...r,
        // this store's own options (sizes with their price, which options the drink offers)
        optionPrices: productOptions.map((o) => ({ optionId: o.optionId, groupId: o.option.groupId, price: o.priceDelta, isDefault: o.isDefault })),
        // ingredients are never sold at the POS, nor products this store does not sell
        isActive: r.isActive && !isIngredient && !!inventory[0]?.isListed,
        modifierGroupIds: modifierGroups.map((m) => m.groupId),
        price: inventory[0]?.priceOverride ?? sellPrice,
        stock: inventory[0]?.quantity ?? '0',
      })),
    };
  }

  /** Fast lookup for the POS screen: barcode scan or exact SKU. */
  async lookup(p: Principal, code: string, storeId: string) {
    assertStoreAccess(p, storeId);
    const product = await this.prisma.product.findFirst({
      where: { isActive: true, OR: [{ barcode: code }, { sku: code }] },
      include: { inventory: { where: { storeId } } },
    });
    if (!product) throw new NotFoundException(`No product with barcode or SKU "${code}"`);
    if (!product.inventory[0]?.isListed) throw new NotFoundException(`${product.name} is not sold in this store`);
    return withStorePrice(product, storeId);
  }

  /** A new product is sold in the chosen stores (with their own price), or in every store when none are given. */
  async create({ modifierGroupIds, stores, ...dto }: CreateProductDto) {
    const listing = stores ?? (await this.allStores()).map((storeId) => ({ storeId, price: null }));
    const known = new Set(await this.allStores());
    const unknown = listing.find((s) => !known.has(s.storeId));
    if (unknown) throw new BadRequestException(`Store ${unknown.storeId} not found`);
    return this.prisma.product.create({
      data: {
        ...dto,
        ...(modifierGroupIds && { modifierGroups: { create: modifierGroupIds.map((groupId, i) => ({ groupId, sortOrder: i })) } }),
        inventory: { create: listing.map((s) => ({ storeId: s.storeId, priceOverride: s.price ?? null, isListed: true })) },
      },
    });
  }

  private async allStores() {
    return (await this.prisma.store.findMany({ select: { id: true } })).map((s) => s.id);
  }

  update(id: string, { modifierGroupIds, ...dto }: UpdateProductDto) {
    return this.prisma.$transaction(async (tx) => {
      if (modifierGroupIds) {
        await tx.productModifierGroup.deleteMany({ where: { productId: id } });
        await tx.productModifierGroup.createMany({ data: modifierGroupIds.map((groupId, i) => ({ productId: id, groupId, sortOrder: i })) });
      }
      // updatedAt changes so offline POS catalogues pick up the new options.
      return tx.product.update({ where: { id }, data: { ...dto, updatedAt: new Date() } });
    });
  }

  /** Create or update many products by SKU in one transaction (for imports and integrations). */
  async bulkUpsert(products: CreateProductDto[]) {
    const storeIds = await this.allStores();
    const results = await this.prisma.$transaction(
      products.map(({ modifierGroupIds: _ignored, stores, ...dto }) =>
        this.prisma.product.upsert({
          where: { sku: dto.sku },
          // New products: sold in the given stores, or in every store
          create: { ...dto, inventory: { create: (stores ?? storeIds.map((storeId) => ({ storeId, price: null }))).filter((s) => storeIds.includes(s.storeId)).map((s) => ({ storeId: s.storeId, priceOverride: s.price ?? null })) } },
          update: dto,
          select: { id: true, sku: true },
        }),
      ),
    );
    return { count: results.length, products: results };
  }
}

/** Adds `price` (store override or default) and `stock` when a store is given. */
function withStorePrice<T extends { sellPrice: Prisma.Decimal; inventory?: { storeId: string; quantity: Prisma.Decimal; priceOverride: Prisma.Decimal | null; isListed: boolean }[] }>(
  product: T,
  storeId?: string,
) {
  if (!storeId) return product;
  const inv = product.inventory?.find((i) => i.storeId === storeId);
  const { inventory, ...rest } = product;
  return {
    ...rest,
    inventory,
    price: inv?.priceOverride ?? product.sellPrice,
    stock: inv?.quantity ?? new Prisma.Decimal(0),
    /** this store sells the product */
    listed: !!inv?.isListed,
  };
}
