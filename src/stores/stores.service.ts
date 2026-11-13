import { Injectable } from '@nestjs/common';
import { assertStoreAccess, Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStoreWithProductsDto, UpdateStoreDto } from './stores.dto';

@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService) {}

  list(p: Principal, includeInactive = false) {
    return this.prisma.store.findMany({
      where: {
        ...(p.storeIds !== 'ALL' && { id: { in: p.storeIds } }),
        ...(!includeInactive && { isActive: true }),
      },
      orderBy: { code: 'asc' },
      omit: { receiptSeq: true },
    });
  }

  /** Names of all active stores (e.g. to choose a transfer destination). No details. */
  directory() {
    return this.prisma.store.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } });
  }

  async get(p: Principal, id: string) {
    assertStoreAccess(p, id);
    const store = await this.prisma.store.findUniqueOrThrow({ where: { id }, omit: { receiptSeq: true } });
    const [staff, products] = await Promise.all([
      this.prisma.storeUser.count({ where: { storeId: id } }),
      this.prisma.inventory.count({ where: { storeId: id, isListed: true } }),
    ]);
    return { ...store, staffCount: staff, productCount: products };
  }

  /** A new store sells every active product, or the same products as another store (with its prices). */
  async create({ copyProductsFrom, ...dto }: CreateStoreWithProductsDto) {
    return this.prisma.$transaction(async (tx) => {
      const store = await tx.store.create({ data: dto, omit: { receiptSeq: true } });
      const listing = copyProductsFrom
        ? await tx.inventory.findMany({ where: { storeId: copyProductsFrom, isListed: true }, select: { productId: true, priceOverride: true, reorderLevel: true } })
        : (await tx.product.findMany({ where: { isActive: true }, select: { id: true } })).map((p) => ({ productId: p.id, priceOverride: null, reorderLevel: undefined }));
      if (listing.length) await tx.inventory.createMany({ data: listing.map((l) => ({ ...l, storeId: store.id })) });
      return store;
    });
  }

  update(p: Principal, id: string, dto: UpdateStoreDto) {
    assertStoreAccess(p, id);
    return this.prisma.store.update({ where: { id }, data: dto, omit: { receiptSeq: true } });
  }
}
