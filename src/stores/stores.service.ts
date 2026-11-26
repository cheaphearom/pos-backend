// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { BadRequestException, Injectable } from '@nestjs/common';
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
      const store = await tx.store.create({ data: { ...dto, kitchenStations: plainStations(dto.kitchenStations) }, omit: { receiptSeq: true } });
      const listing = copyProductsFrom
        ? await tx.inventory.findMany({ where: { storeId: copyProductsFrom, isListed: true }, select: { productId: true, priceOverride: true, reorderLevel: true } })
        : (await tx.product.findMany({ where: { isActive: true }, select: { id: true } })).map((p) => ({ productId: p.id, priceOverride: null, reorderLevel: undefined }));
      if (listing.length) await tx.inventory.createMany({ data: listing.map((l) => ({ ...l, storeId: store.id })) });
      return store;
    });
  }

  update(p: Principal, id: string, dto: UpdateStoreDto) {
    assertStoreAccess(p, id);
    return this.prisma.store.update({ where: { id }, data: { ...dto, kitchenStations: plainStations(dto.kitchenStations) }, omit: { receiptSeq: true } });
  }
}

/** Kitchen stations as plain JSON (names trimmed, station ids unique). */
function plainStations(list?: { id: string; name: string; categoryIds: string[] }[]) {
  if (list === undefined) return undefined;
  const ids = new Set<string>();
  for (const st of list) {
    if (ids.has(st.id)) throw new BadRequestException('Two kitchen stations have the same id');
    ids.add(st.id);
  }
  return list.map((st) => ({ id: st.id, name: st.name.trim(), categoryIds: [...st.categoryIds] }));
}
