import { Injectable, NotFoundException } from '@nestjs/common';
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

  /** Fast lookup for the POS screen: barcode scan or exact SKU. */
  async lookup(p: Principal, code: string, storeId: string) {
    assertStoreAccess(p, storeId);
    const product = await this.prisma.product.findFirst({
      where: { isActive: true, OR: [{ barcode: code }, { sku: code }] },
      include: { inventory: { where: { storeId } } },
    });
    if (!product) throw new NotFoundException(`No product with barcode or SKU "${code}"`);
    return withStorePrice(product, storeId);
  }

  create(dto: CreateProductDto) {
    return this.prisma.product.create({ data: dto });
  }

  update(id: string, dto: UpdateProductDto) {
    return this.prisma.product.update({ where: { id }, data: dto });
  }

  /** Create or update many products by SKU in one transaction (for imports and integrations). */
  async bulkUpsert(products: CreateProductDto[]) {
    const results = await this.prisma.$transaction(
      products.map((dto) =>
        this.prisma.product.upsert({ where: { sku: dto.sku }, create: dto, update: dto, select: { id: true, sku: true } }),
      ),
    );
    return { count: results.length, products: results };
  }
}

/** Adds `price` (store override or default) and `stock` when a store is given. */
function withStorePrice<T extends { sellPrice: Prisma.Decimal; inventory?: { storeId: string; quantity: Prisma.Decimal; priceOverride: Prisma.Decimal | null }[] }>(
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
  };
}
