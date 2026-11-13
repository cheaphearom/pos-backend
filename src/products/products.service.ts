import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { pageArgs, toPage } from '../common/pagination';
import { assertStoreAccess, Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto, ProductQueryDto, UpdateProductDto } from './products.dto';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(p: Principal, q: ProductQueryDto) {
    if (q.storeId) assertStoreAccess(p, q.storeId);
    const where: Prisma.ProductWhereInput = {
      categoryId: q.categoryId,
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
      },
      orderBy: { name: 'asc' },
    });
    return {
      serverTime,
      full: !sinceDate,
      products: rows.map(({ inventory, sellPrice, modifierGroups, isIngredient, ...r }) => ({
        ...r,
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
