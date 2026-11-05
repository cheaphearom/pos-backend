import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { pageArgs, toPage } from '../common/pagination';
import { assertStoreAccess, Principal, storeScope, userIdOf } from '../common/principal';
import { InventoryService } from '../inventory/inventory.service';
import { MovementResult, StockService } from '../inventory/stock.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { CreatePurchaseOrderDto, CreateSupplierDto, PoItemDto, PoQueryDto, ReceivePurchaseOrderDto, SupplierQueryDto, UpdatePurchaseOrderDto, UpdateSupplierDto } from './purchasing.dto';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

const poInclude = {
  supplier: { select: { id: true, code: true, name: true, phone: true, email: true, paymentTermsDays: true } },
  store: { select: { id: true, code: true, name: true, address: true } },
  items: { orderBy: { lineNo: 'asc' }, include: { product: { select: { id: true, sku: true, barcode: true, name: true, unit: true, costPrice: true } } } },
  receipts: { orderBy: { createdAt: 'asc' }, include: { items: true } },
} satisfies Prisma.PurchaseOrderInclude;

@Injectable()
export class PurchasingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly inventory: InventoryService,
    private readonly webhooks: WebhooksService,
  ) {}

  // ─── Suppliers (shared by all stores) ───

  async listSuppliers(q: SupplierQueryDto) {
    const where: Prisma.SupplierWhereInput = q.search
      ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { code: { contains: q.search, mode: 'insensitive' } }, { phone: { contains: q.search } }] }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.supplier.findMany({ where, orderBy: { name: 'asc' }, include: { _count: { select: { purchaseOrders: true } } }, ...pageArgs(q) }),
      this.prisma.supplier.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  getSupplier(id: string) {
    return this.prisma.supplier.findUniqueOrThrow({ where: { id } });
  }

  createSupplier(dto: CreateSupplierDto) {
    return this.prisma.supplier.create({ data: { ...dto, code: dto.code.toUpperCase() } });
  }

  updateSupplier(id: string, dto: UpdateSupplierDto) {
    return this.prisma.supplier.update({ where: { id }, data: { ...dto, code: dto.code?.toUpperCase() } });
  }

  // ─── Purchase orders ───

  async list(p: Principal, q: PoQueryDto) {
    const where: Prisma.PurchaseOrderWhereInput = {
      ...storeScope(p, q.storeId),
      supplierId: q.supplierId,
      status: q.status,
      ...(q.search && { poNo: { contains: q.search, mode: 'insensitive' } }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: { supplier: { select: { code: true, name: true } }, store: { select: { code: true } }, _count: { select: { items: true } } },
        ...pageArgs(q),
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  async get(p: Principal, id: string) {
    const po = await this.prisma.purchaseOrder.findUniqueOrThrow({ where: { id }, include: poInclude });
    assertStoreAccess(p, po.storeId);
    return po;
  }

  async create(p: Principal, dto: CreatePurchaseOrderDto) {
    assertStoreAccess(p, dto.storeId);
    const store = await this.prisma.store.findUniqueOrThrow({ where: { id: dto.storeId } });
    const supplier = await this.prisma.supplier.findUniqueOrThrow({ where: { id: dto.supplierId } });
    if (!supplier.isActive) throw new BadRequestException('Supplier is inactive');
    const items = await this.buildItems(dto.items);
    const poNo = `PO-${store.code}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(2).toString('hex').toUpperCase()}`;
    return this.prisma.purchaseOrder.create({
      data: {
        poNo,
        supplierId: dto.supplierId,
        storeId: dto.storeId,
        expectedAt: dto.expectedAt ? new Date(dto.expectedAt) : undefined,
        note: dto.note,
        createdById: userIdOf(p),
        subtotal: items.reduce((s, i) => s.plus(D(i.unitCost).mul(i.quantity)), D(0)).toDecimalPlaces(2),
        items: { create: items },
      },
      include: poInclude,
    });
  }

  /** Only drafts can be edited. */
  async update(p: Principal, id: string, dto: UpdatePurchaseOrderDto) {
    const po = await this.get(p, id);
    if (po.status !== 'DRAFT') throw new BadRequestException('Only draft orders can be changed');
    if (dto.storeId) assertStoreAccess(p, dto.storeId);
    return this.prisma.$transaction(async (tx) => {
      let subtotal: Prisma.Decimal | undefined;
      if (dto.items) {
        const items = await this.buildItems(dto.items);
        await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
        await tx.purchaseOrderItem.createMany({ data: items.map((i) => ({ ...i, purchaseOrderId: id })) });
        subtotal = items.reduce((s, i) => s.plus(D(i.unitCost).mul(i.quantity)), D(0)).toDecimalPlaces(2);
      }
      return tx.purchaseOrder.update({
        where: { id },
        data: {
          supplierId: dto.supplierId,
          storeId: dto.storeId,
          expectedAt: dto.expectedAt ? new Date(dto.expectedAt) : undefined,
          note: dto.note,
          subtotal,
        },
        include: poInclude,
      });
    });
  }

  /** Mark as sent to the supplier. */
  async order(p: Principal, id: string) {
    const po = await this.get(p, id);
    if (po.status !== 'DRAFT') throw new BadRequestException(`Order is already ${po.status}`);
    return this.prisma.purchaseOrder.update({ where: { id }, data: { status: 'ORDERED', orderedAt: new Date() }, include: poInclude });
  }

  async cancel(p: Principal, id: string) {
    const po = await this.get(p, id);
    if (!['DRAFT', 'ORDERED'].includes(po.status)) throw new BadRequestException(`Cannot cancel an order that is ${po.status}`);
    return this.prisma.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED' }, include: poInclude });
  }

  /**
   * Record a delivery: stock goes up, received quantities and status are updated,
   * and (by default) the products' cost price becomes the received cost.
   */
  async receive(p: Principal, id: string, dto: ReceivePurchaseOrderDto) {
    const userId = userIdOf(p);
    let results: MovementResult[] = [];
    const po = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id}::uuid FOR UPDATE`;
        const order = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { items: true } });
        assertStoreAccess(p, order.storeId);
        if (!['ORDERED', 'PARTIALLY_RECEIVED'].includes(order.status)) {
          throw new BadRequestException(order.status === 'DRAFT' ? 'Mark the order as ordered first' : `Order is ${order.status}`);
        }
        const byId = new Map(order.items.map((i) => [i.id, i]));
        const lines = dto.items.map((r) => {
          const item = byId.get(r.itemId);
          if (!item) throw new BadRequestException(`Line ${r.itemId} is not part of this order`);
          const left = item.quantity.minus(item.receivedQty);
          if (D(r.quantity).gt(left)) throw new BadRequestException(`Only ${left} left to receive on one of the lines`);
          return { item, quantity: D(r.quantity), unitCost: D(r.unitCost ?? item.unitCost) };
        });

        const receipt = await tx.goodsReceipt.create({
          data: {
            purchaseOrderId: id,
            reference: dto.reference,
            note: dto.note,
            userId,
            items: { create: lines.map((l) => ({ purchaseOrderItemId: l.item.id, quantity: l.quantity, unitCost: l.unitCost })) },
          },
        });

        results = [];
        for (const l of [...lines].sort((a, b) => a.item.productId.localeCompare(b.item.productId))) {
          await tx.purchaseOrderItem.update({ where: { id: l.item.id }, data: { receivedQty: { increment: l.quantity } } });
          results.push(
            await this.stock.apply(tx, {
              storeId: order.storeId,
              productId: l.item.productId,
              delta: l.quantity,
              type: 'PURCHASE',
              referenceType: 'PO',
              referenceId: order.poNo,
              note: dto.reference ? `Invoice ${dto.reference}` : undefined,
              userId,
            }),
          );
          if (dto.updateCost ?? true) {
            await tx.product.update({ where: { id: l.item.productId }, data: { costPrice: l.unitCost } });
          }
        }

        const fresh = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: id } });
        const done = fresh.every((i) => i.receivedQty.gte(i.quantity));
        await tx.purchaseOrder.update({
          where: { id },
          data: { status: done ? 'RECEIVED' : 'PARTIALLY_RECEIVED', ...(done && { receivedAt: new Date() }) },
        });
        return tx.purchaseOrder.findUniqueOrThrow({ where: { id: receipt.purchaseOrderId }, include: poInclude });
      },
      { timeout: 20_000 },
    );
    await this.webhooks.emit('purchase_order.received', { purchaseOrderId: po.id, poNo: po.poNo, status: po.status, storeId: po.storeId });
    await this.inventory.emitLowStock(results);
    return po;
  }

  /**
   * Low-stock items of a store with a suggested order quantity
   * (enough to reach twice the reorder level).
   */
  async suggestions(p: Principal, storeId: string) {
    assertStoreAccess(p, storeId);
    const rows = await this.prisma.inventory.findMany({
      where: { storeId, reorderLevel: { gt: 0 }, quantity: { lte: this.prisma.inventory.fields.reorderLevel }, product: { isActive: true, trackStock: true } },
      include: { product: { select: { id: true, sku: true, name: true, unit: true, costPrice: true } } },
      orderBy: { product: { name: 'asc' } },
    });
    return rows.map((r) => ({
      productId: r.productId,
      sku: r.product.sku,
      name: r.product.name,
      unit: r.product.unit,
      stock: r.quantity,
      reorderLevel: r.reorderLevel,
      suggestedQty: Prisma.Decimal.max(r.reorderLevel.mul(2).minus(r.quantity), 1).ceil(),
      unitCost: r.product.costPrice,
    }));
  }

  private async buildItems(items: PoItemDto[]) {
    const products = await this.prisma.product.findMany({ where: { id: { in: items.map((i) => i.productId) } }, select: { id: true, costPrice: true } });
    const cost = new Map(products.map((x) => [x.id, x.costPrice]));
    return items.map((i, n) => {
      if (!cost.has(i.productId)) throw new BadRequestException(`Product ${i.productId} not found`);
      return { lineNo: n + 1, productId: i.productId, quantity: D(i.quantity), unitCost: D(i.unitCost ?? cost.get(i.productId)!) };
    });
  }
}
