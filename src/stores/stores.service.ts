import { Injectable } from '@nestjs/common';
import { assertStoreAccess, Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStoreDto, UpdateStoreDto } from './stores.dto';

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
      this.prisma.inventory.count({ where: { storeId: id } }),
    ]);
    return { ...store, staffCount: staff, productCount: products };
  }

  create(dto: CreateStoreDto) {
    return this.prisma.store.create({ data: dto, omit: { receiptSeq: true } });
  }

  update(p: Principal, id: string, dto: UpdateStoreDto) {
    assertStoreAccess(p, id);
    return this.prisma.store.update({ where: { id }, data: dto, omit: { receiptSeq: true } });
  }
}
