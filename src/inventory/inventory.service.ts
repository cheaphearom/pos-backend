import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';
import { randomBytes } from 'crypto';
import { dateFilter } from '../common/date-range';
import { pageArgs, toPage } from '../common/pagination';
import { assertStoreAccess, canAccessStore, Principal, storeScope, userIdOf } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { AdjustStockDto, CreateTransferDto, InventoryQueryDto, MovementQueryDto, TransferQueryDto, UpdateInventoryDto } from './inventory.dto';
import { MovementResult, StockService } from './stock.service';
import { logEvent } from '../logging/logger';

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly webhooks: WebhooksService,
  ) {}

  async list(p: Principal, q: InventoryQueryDto) {
    assertStoreAccess(p, q.storeId);
    const where: Prisma.InventoryWhereInput = {
      storeId: q.storeId,
      ...(q.lowStock && { quantity: { lte: this.prisma.inventory.fields.reorderLevel } }),
      ...(q.search && {
        product: {
          OR: [
            { name: { contains: q.search, mode: 'insensitive' } },
            { sku: { contains: q.search, mode: 'insensitive' } },
            { barcode: q.search },
          ],
        },
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.inventory.findMany({
        where,
        include: { product: { select: { id: true, sku: true, barcode: true, name: true, unit: true, sellPrice: true, costPrice: true } } },
        orderBy: { product: { name: 'asc' } },
        ...pageArgs(q),
      }),
      this.prisma.inventory.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  /** Set reorder level / store price for a product in a store. */
  async update(p: Principal, storeId: string, productId: string, dto: UpdateInventoryDto) {
    assertStoreAccess(p, storeId);
    return this.prisma.inventory.upsert({
      where: { storeId_productId: { storeId, productId } },
      create: { storeId, productId, reorderLevel: dto.reorderLevel, priceOverride: dto.priceOverride },
      update: dto,
    });
  }

  async adjust(p: Principal, dto: AdjustStockDto) {
    assertStoreAccess(p, dto.storeId);
    const results = await this.prisma.$transaction(async (tx) => {
      const out: MovementResult[] = [];
      for (const item of dto.items) {
        out.push(
          await this.stock.apply(tx, {
            storeId: dto.storeId,
            productId: item.productId,
            delta: item.quantity,
            type: dto.type as StockMovementType,
            referenceType: dto.type,
            referenceId: dto.reference,
            note: dto.note,
            userId: userIdOf(p),
            allowNegative: false,
          }),
        );
      }
      return out;
    });
    logEvent('info', 'stock_adjusted', 'Stock adjusted', { storeId: dto.storeId, type: dto.type, items: results.length });
    await this.webhooks.emit('stock.adjusted', { storeId: dto.storeId, type: dto.type, reference: dto.reference, items: results });
    await this.emitLowStock(results);
    return { items: results };
  }

  async movements(p: Principal, q: MovementQueryDto) {
    const where: Prisma.StockMovementWhereInput = {
      ...storeScope(p, q.storeId),
      productId: q.productId,
      createdAt: dateFilter(q.from, q.to),
    };
    const [rows, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        orderBy: { id: 'desc' },
        include: { product: { select: { sku: true, name: true } }, store: { select: { code: true } } },
        ...pageArgs(q),
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  // ─── Transfers between stores ───
  // Step 1 (create): stock leaves the source store immediately (IN_TRANSIT).
  // Step 2 (receive): stock arrives in the destination store. Or cancel: stock goes back.

  async listTransfers(p: Principal, q: TransferQueryDto) {
    if (q.storeId) assertStoreAccess(p, q.storeId);
    const stores = q.storeId ? [q.storeId] : p.storeIds;
    const where: Prisma.StockTransferWhereInput = {
      status: q.status,
      ...(stores !== 'ALL' && { OR: [{ fromStoreId: { in: stores } }, { toStoreId: { in: stores } }] }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.stockTransfer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          fromStore: { select: { code: true, name: true } },
          toStore: { select: { code: true, name: true } },
          _count: { select: { items: true } },
        },
        ...pageArgs(q),
      }),
      this.prisma.stockTransfer.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  async getTransfer(p: Principal, id: string) {
    const t = await this.prisma.stockTransfer.findUniqueOrThrow({
      where: { id },
      include: {
        fromStore: { select: { code: true, name: true } },
        toStore: { select: { code: true, name: true } },
        items: { include: { product: { select: { sku: true, name: true, unit: true } } } },
      },
    });
    if (!canAccessStore(p, t.fromStoreId) && !canAccessStore(p, t.toStoreId)) assertStoreAccess(p, t.fromStoreId);
    return t;
  }

  async createTransfer(p: Principal, dto: CreateTransferDto) {
    assertStoreAccess(p, dto.fromStoreId);
    if (dto.fromStoreId === dto.toStoreId) throw new BadRequestException('Source and destination store must differ');
    const transferNo = `TR-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;

    const { transfer, results } = await this.prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.create({
        data: {
          transferNo,
          fromStoreId: dto.fromStoreId,
          toStoreId: dto.toStoreId,
          note: dto.note,
          createdById: userIdOf(p),
          items: { create: dto.items.map((i) => ({ productId: i.productId, quantity: i.quantity })) },
        },
        include: { items: true },
      });
      const results: MovementResult[] = [];
      for (const item of dto.items) {
        results.push(
          await this.stock.apply(tx, {
            storeId: dto.fromStoreId,
            productId: item.productId,
            delta: -item.quantity,
            type: 'TRANSFER_OUT',
            referenceType: 'TRANSFER',
            referenceId: transfer.transferNo,
            userId: userIdOf(p),
            allowNegative: false,
          }),
        );
      }
      return { transfer, results };
    });
    await this.webhooks.emit('transfer.created', transfer);
    await this.emitLowStock(results);
    return transfer;
  }

  async receiveTransfer(p: Principal, id: string) {
    return this.finishTransfer(p, id, 'RECEIVED');
  }

  async cancelTransfer(p: Principal, id: string) {
    return this.finishTransfer(p, id, 'CANCELLED');
  }

  private async finishTransfer(p: Principal, id: string, status: 'RECEIVED' | 'CANCELLED') {
    const transfer = await this.prisma.$transaction(async (tx) => {
      // Lock the transfer row so it cannot be received twice at the same time.
      await tx.$queryRaw`SELECT id FROM stock_transfers WHERE id = ${id}::uuid FOR UPDATE`;
      const t = await tx.stockTransfer.findUniqueOrThrow({ where: { id }, include: { items: true } });
      if (t.status !== 'IN_TRANSIT') throw new BadRequestException(`Transfer is already ${t.status}`);
      const targetStore = status === 'RECEIVED' ? t.toStoreId : t.fromStoreId;
      assertStoreAccess(p, targetStore);

      for (const item of t.items) {
        await this.stock.apply(tx, {
          storeId: targetStore,
          productId: item.productId,
          delta: item.quantity,
          type: 'TRANSFER_IN',
          referenceType: 'TRANSFER',
          referenceId: t.transferNo,
          note: status === 'CANCELLED' ? 'Transfer cancelled, stock returned' : undefined,
          userId: userIdOf(p),
        });
      }
      return tx.stockTransfer.update({
        where: { id },
        data: { status, receivedAt: new Date(), receivedById: userIdOf(p) },
        include: { items: true },
      });
    });
    if (status === 'RECEIVED') await this.webhooks.emit('transfer.received', transfer);
    return transfer;
  }

  async emitLowStock(results: MovementResult[]) {
    for (const r of results.filter((x) => x.becameLow)) {
      await this.webhooks.emit('stock.low', r);
    }
  }
}
