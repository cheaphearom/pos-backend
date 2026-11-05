import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { changePoints, pointsForAmount, valueOfPoints } from '../customers/loyalty';
import { dateFilter } from '../common/date-range';
import { pageArgs, toPage } from '../common/pagination';
import { assertStoreAccess, Principal, storeScope, userIdOf } from '../common/principal';
import { InventoryService } from '../inventory/inventory.service';
import { MovementResult, StockService } from '../inventory/stock.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { priceSale, PricingError } from './pricing';
import { CreateRefundDto, CreateSaleDto, SaleQueryDto } from './sales.dto';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);

const receiptInclude = {
  store: { select: { id: true, code: true, name: true, address: true, phone: true, currency: true } },
  cashier: { select: { id: true, fullName: true } },
  customer: { select: { id: true, code: true, name: true, phone: true, points: true } },
  items: { orderBy: { lineNo: 'asc' } },
  payments: true,
  refunds: { include: { items: true } },
} satisfies Prisma.SaleInclude;

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly inventory: InventoryService,
    private readonly webhooks: WebhooksService,
  ) {}

  /**
   * Checkout. Everything (stock, points, receipt number, payments) happens in ONE
   * database transaction: either the whole sale is saved or nothing is.
   */
  async create(p: Principal, dto: CreateSaleDto) {
    assertStoreAccess(p, dto.storeId);

    if (dto.clientRef) {
      const existing = await this.prisma.sale.findUnique({ where: { clientRef: dto.clientRef }, include: receiptInclude });
      if (existing) return existing; // already processed (retry / offline re-sync)
    }

    const store = await this.prisma.store.findUniqueOrThrow({ where: { id: dto.storeId } });
    if (!store.isActive) throw new BadRequestException('Store is inactive');

    // Load products with this store's price.
    const productIds = [...new Set(dto.items.map((i) => i.productId))];
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      include: { inventory: { where: { storeId: dto.storeId }, select: { priceOverride: true } } },
    });
    const byId = new Map(products.map((x) => [x.id, x]));
    for (const id of productIds) {
      const prod = byId.get(id);
      if (!prod) throw new BadRequestException(`Product ${id} not found`);
      if (!prod.isActive) throw new BadRequestException(`Product ${prod.name} is not for sale`);
    }

    const lines = dto.items.map((i) => {
      const prod = byId.get(i.productId)!;
      return { item: i, prod, unitPrice: prod.inventory[0]?.priceOverride ?? prod.sellPrice };
    });

    let priced;
    try {
      priced = priceSale(
        lines.map((l) => ({ unitPrice: l.unitPrice, quantity: l.item.quantity, discount: l.item.discount, taxable: l.prod.taxable })),
        store.taxRate,
        { amount: dto.discount, percent: dto.discountPercent },
      );
    } catch (e) {
      if (e instanceof PricingError) throw new BadRequestException(e.message);
      throw e;
    }

    // Loyalty redemption reduces the amount the customer has to pay.
    let pointsDiscount = ZERO;
    const redeem = dto.redeemPoints ?? 0;
    if (redeem && !dto.customerId) throw new BadRequestException('Select a customer to redeem points');
    if (redeem) {
      pointsDiscount = valueOfPoints(redeem);
      if (pointsDiscount.gt(priced.total)) throw new BadRequestException(`Points are worth ${pointsDiscount}, more than the total ${priced.total}`);
    }
    const amountDue = priced.total.minus(pointsDiscount);

    // Payments: cash can be more than due (change is given), other methods cannot.
    const paid = dto.payments.reduce((s, x) => s.plus(x.amount), ZERO);
    const nonCash = dto.payments.filter((x) => x.method !== 'CASH').reduce((s, x) => s.plus(x.amount), ZERO);
    if (paid.lt(amountDue)) throw new BadRequestException(`Payment ${paid} is less than amount due ${amountDue}`);
    if (nonCash.gt(amountDue)) throw new BadRequestException('Card / KHQR / transfer payments cannot be more than the amount due');
    const changeDue = paid.minus(amountDue);

    const userId = userIdOf(p);
    const shift = userId
      ? await this.prisma.shift.findFirst({ where: { storeId: dto.storeId, userId, status: 'OPEN' }, select: { id: true } })
      : null;

    let stockResults: MovementResult[] = [];
    let sale;
    try {
      sale = await this.prisma.$transaction(
        async (tx) => {
          // 1. Receipt number (locks the store row briefly so numbers never repeat).
          const [{ receipt_seq: seq }] = await tx.$queryRaw<{ receipt_seq: number }[]>`
            UPDATE stores SET receipt_seq = receipt_seq + 1 WHERE id = ${dto.storeId}::uuid RETURNING receipt_seq`;
          const receiptNo = `${store.code}-${String(seq).padStart(8, '0')}`;

          // 2. Save the sale.
          const created = await tx.sale.create({
            data: {
              receiptNo,
              clientRef: dto.clientRef,
              storeId: dto.storeId,
              shiftId: shift?.id,
              cashierId: userId,
              customerId: dto.customerId,
              channel: dto.channel ?? (p.kind === 'api_key' ? 'API' : 'POS'),
              subtotal: priced.subtotal,
              discountTotal: priced.discountTotal,
              taxTotal: priced.taxTotal,
              total: priced.total,
              pointsRedeemed: redeem,
              pointsDiscount,
              amountDue,
              amountPaid: paid,
              changeDue,
              note: dto.note,
              items: {
                create: lines.map((l, i) => ({
                  lineNo: i + 1,
                  productId: l.prod.id,
                  sku: l.prod.sku,
                  name: l.prod.name,
                  quantity: l.item.quantity,
                  unitPrice: l.unitPrice,
                  costPrice: l.prod.costPrice,
                  discount: priced.lines[i].discount,
                  taxRate: priced.lines[i].taxRate,
                  netAmount: priced.lines[i].net,
                  taxAmount: priced.lines[i].tax,
                  lineTotal: priced.lines[i].total,
                })),
              },
              payments: { create: dto.payments.map((x) => ({ method: x.method, amount: x.amount, reference: x.reference })) },
            },
          });

          // 3. Take items out of stock. Sorted by product so concurrent sales lock rows in the same order (no deadlocks).
          const toDeduct = lines.filter((l) => l.prod.trackStock).sort((a, b) => a.prod.id.localeCompare(b.prod.id));
          stockResults = [];
          for (const l of toDeduct) {
            stockResults.push(
              await this.stock.apply(tx, {
                storeId: dto.storeId,
                productId: l.prod.id,
                delta: -l.item.quantity,
                type: 'SALE',
                referenceType: 'SALE',
                referenceId: receiptNo,
                userId,
              }),
            );
          }

          // 4. Loyalty: use points, then earn points on the money actually paid.
          let pointsEarned = 0;
          if (dto.customerId) {
            if (redeem) await changePoints(tx, dto.customerId, -redeem, 'REDEEM', created.id);
            pointsEarned = pointsForAmount(amountDue);
            if (pointsEarned) await changePoints(tx, dto.customerId, pointsEarned, 'EARN', created.id);
            await tx.customer.update({
              where: { id: dto.customerId },
              data: { totalSpent: { increment: amountDue }, visitCount: { increment: 1 } },
            });
          }

          return tx.sale.update({ where: { id: created.id }, data: { pointsEarned }, include: receiptInclude });
        },
        { timeout: 15_000 },
      );
    } catch (e) {
      // Two requests with the same clientRef at the same moment: return the one that won.
      if (dto.clientRef && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.prisma.sale.findUnique({ where: { clientRef: dto.clientRef }, include: receiptInclude });
        if (existing) return existing;
      }
      throw e;
    }

    await this.webhooks.emit('sale.created', sale);
    await this.inventory.emitLowStock(stockResults);
    return sale;
  }

  async list(p: Principal, q: SaleQueryDto) {
    const where: Prisma.SaleWhereInput = {
      ...storeScope(p, q.storeId),
      status: q.status,
      customerId: q.customerId,
      cashierId: q.cashierId,
      shiftId: q.shiftId,
      createdAt: dateFilter(q.from, q.to),
      ...(q.search && { receiptNo: { contains: q.search, mode: 'insensitive' } }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.sale.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          store: { select: { code: true, name: true } },
          cashier: { select: { fullName: true } },
          customer: { select: { name: true, code: true } },
          _count: { select: { items: true } },
        },
        ...pageArgs(q),
      }),
      this.prisma.sale.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  /** Full receipt by sale id or receipt number. */
  async get(p: Principal, idOrReceipt: string) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(idOrReceipt);
    const sale = await this.prisma.sale.findUnique({
      where: isUuid ? { id: idOrReceipt } : { receiptNo: idOrReceipt },
      include: receiptInclude,
    });
    if (!sale) throw new NotFoundException('Sale not found');
    assertStoreAccess(p, sale.storeId);
    return sale;
  }

  /** Refund some or all items of a sale. Money, points and stock are reversed proportionally. */
  async refund(p: Principal, saleId: string, dto: CreateRefundDto) {
    const userId = userIdOf(p);
    let stockResults: MovementResult[] = [];

    const result = await this.prisma.$transaction(
      async (tx) => {
        // Lock the sale so two refunds cannot run at the same time.
        await tx.$queryRaw`SELECT id FROM sales WHERE id = ${saleId}::uuid FOR UPDATE`;
        const sale = await tx.sale.findUnique({
          where: { id: saleId },
          include: {
            items: { orderBy: { lineNo: 'asc' }, include: { refundItems: true, product: { select: { trackStock: true } } } },
            refunds: true,
          },
        });
        if (!sale) throw new NotFoundException('Sale not found');
        assertStoreAccess(p, sale.storeId);
        if (sale.status === 'REFUNDED' || sale.status === 'VOIDED') throw new BadRequestException(`Sale is already ${sale.status}`);

        const itemsById = new Map(sale.items.map((i) => [i.id, i]));
        const requested = new Map<string, Prisma.Decimal>();
        for (const r of dto.items) {
          requested.set(r.saleItemId, (requested.get(r.saleItemId) ?? ZERO).plus(r.quantity));
        }

        let lineSum = ZERO;
        const refundItems: { saleItemId: string; quantity: Prisma.Decimal; amount: Prisma.Decimal }[] = [];
        for (const [saleItemId, qty] of requested) {
          const item = itemsById.get(saleItemId);
          if (!item) throw new BadRequestException(`Item ${saleItemId} is not part of this sale`);
          const left = item.quantity.minus(item.refundedQty);
          if (qty.gt(left)) throw new BadRequestException(`Only ${left} of ${item.name} can still be refunded`);
          // Last units of a line get the exact remaining amount, avoiding rounding drift.
          const alreadyAmount = item.refundItems.reduce((s, x) => s.plus(x.amount), ZERO);
          const amount = qty.eq(left)
            ? item.lineTotal.minus(alreadyAmount)
            : item.lineTotal.mul(qty).div(item.quantity).toDecimalPlaces(2);
          lineSum = lineSum.plus(amount);
          refundItems.push({ saleItemId, quantity: qty, amount });
        }

        const fullyRefunded = sale.items.every((i) => i.quantity.minus(i.refundedQty).eq(requested.get(i.id) ?? ZERO));
        const ratio = sale.total.gt(0) ? lineSum.div(sale.total) : ZERO;
        const prevReturned = sale.refunds.reduce((s, r) => s + r.pointsReturned, 0);
        const prevReversed = sale.refunds.reduce((s, r) => s + r.pointsReversed, 0);

        // Money back = items value minus the part that was paid with points.
        const amount = fullyRefunded
          ? sale.amountDue.minus(sale.refundedTotal)
          : lineSum.minus(sale.pointsDiscount.mul(ratio)).toDecimalPlaces(2);
        let pointsReturned = fullyRefunded ? sale.pointsRedeemed - prevReturned : Math.floor(sale.pointsRedeemed * ratio.toNumber());
        let pointsReversed = fullyRefunded ? sale.pointsEarned - prevReversed : Math.floor(sale.pointsEarned * ratio.toNumber());

        const refund = await tx.refund.create({
          data: {
            refundNo: `${sale.receiptNo}-R${sale.refunds.length + 1}`,
            saleId,
            userId,
            method: dto.method ?? 'CASH',
            amount,
            restock: dto.restock ?? true,
            reason: dto.reason,
            items: { create: refundItems },
          },
        });

        for (const ri of refundItems) {
          await tx.saleItem.update({ where: { id: ri.saleItemId }, data: { refundedQty: { increment: ri.quantity } } });
        }

        if (dto.restock ?? true) {
          const restockable = refundItems
            .filter((ri) => itemsById.get(ri.saleItemId)!.product.trackStock)
            .sort((a, b) => itemsById.get(a.saleItemId)!.productId.localeCompare(itemsById.get(b.saleItemId)!.productId));
          stockResults = [];
          for (const ri of restockable) {
            stockResults.push(
              await this.stock.apply(tx, {
                storeId: sale.storeId,
                productId: itemsById.get(ri.saleItemId)!.productId,
                delta: ri.quantity,
                type: 'REFUND',
                referenceType: 'REFUND',
                referenceId: refund.refundNo,
                userId,
              }),
            );
          }
        }

        if (sale.customerId) {
          if (pointsReturned > 0) await changePoints(tx, sale.customerId, pointsReturned, 'RETURN', saleId);
          // Never push the balance below zero if the customer already spent the points.
          const c = await tx.customer.findUniqueOrThrow({ where: { id: sale.customerId }, select: { points: true } });
          pointsReversed = Math.min(pointsReversed, c.points);
          if (pointsReversed > 0) await changePoints(tx, sale.customerId, -pointsReversed, 'REVERSE', saleId);
          await tx.customer.update({ where: { id: sale.customerId }, data: { totalSpent: { decrement: amount } } });
        } else {
          pointsReturned = 0;
          pointsReversed = 0;
        }

        await tx.refund.update({ where: { id: refund.id }, data: { pointsReturned, pointsReversed } });
        await tx.sale.update({
          where: { id: saleId },
          data: { status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED', refundedTotal: { increment: amount } },
        });

        return tx.refund.findUniqueOrThrow({ where: { id: refund.id }, include: { items: true } });
      },
      { timeout: 15_000 },
    );

    await this.webhooks.emit('sale.refunded', result);
    return result;
  }
}
