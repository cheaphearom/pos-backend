import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { REPORT_TIMEZONE } from '../config';
import { PrismaService } from '../prisma/prisma.service';

/*
 * Figures for the X report (one shift, any time) and the Z report (a store's whole business day).
 * Same layout for both, so a printed X and Z read the same way.
 */

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const r2 = (v: number) => Math.round(v * 100) / 100;

export interface ReportScope {
  storeId: string;
  /** X report: one shift. Refunds are those the shift's cashier made while it was open. */
  shift?: { id: string; userId: string; openedAt: Date; closedAt: Date | null };
  /** Z report: the business day window */
  from?: Date;
  to?: Date;
}

@Injectable()
export class RegisterReportService {
  constructor(private readonly prisma: PrismaService) {}

  async build(scope: ReportScope) {
    const sh = scope.shift;
    const saleWhere: Prisma.SaleWhereInput = sh ? { shiftId: sh.id } : { storeId: scope.storeId, createdAt: { gte: scope.from, lt: scope.to } };
    const refundWhere: Prisma.RefundWhereInput = sh
      ? { userId: sh.userId, sale: { storeId: scope.storeId }, createdAt: { gte: sh.openedAt, ...(sh.closedAt && { lte: sh.closedAt }) } }
      : { sale: { storeId: scope.storeId }, createdAt: { gte: scope.from, lt: scope.to } };
    const cashWhere: Prisma.CashMovementWhereInput = sh ? { shiftId: sh.id } : { storeId: scope.storeId, createdAt: { gte: scope.from, lt: scope.to } };
    const walletWhere: Prisma.WalletTransactionWhereInput = sh ? { shiftId: sh.id, type: 'TOPUP' } : { storeId: scope.storeId, type: 'TOPUP', createdAt: { gte: scope.from, lt: scope.to } };
    const voucherWhere: Prisma.VoucherWhereInput = sh ? { soldShiftId: sh.id } : { soldStoreId: scope.storeId, soldAt: { gte: scope.from, lt: scope.to } };

    const [sales, promo, payments, refunds, moves, topups, vouchers, items, byCashier] = await Promise.all([
      this.prisma.sale.aggregate({
        where: saleWhere, _count: true,
        _sum: { subtotal: true, discountTotal: true, couponDiscount: true, taxTotal: true, total: true, pointsDiscount: true, amountDue: true, changeUsd: true, changeKhr: true, pointsEarned: true, pointsRedeemed: true },
      }),
      this.prisma.saleItem.aggregate({ where: { sale: saleWhere }, _sum: { promoDiscount: true } }),
      this.prisma.payment.groupBy({ by: ['method', 'currency'], where: { sale: saleWhere }, _sum: { amount: true, tendered: true }, _count: true, orderBy: { method: 'asc' } }),
      this.prisma.refund.findMany({ where: refundWhere, select: { refundNo: true, method: true, amount: true, reason: true, createdAt: true } }),
      this.prisma.cashMovement.findMany({ where: cashWhere, orderBy: { createdAt: 'asc' } }),
      this.prisma.walletTransaction.groupBy({ by: ['method'], where: walletWhere, _sum: { amount: true }, _count: true }),
      this.prisma.voucher.groupBy({ by: ['soldMethod'], where: voucherWhere, _sum: { value: true }, _count: true }),
      this.prisma.saleItem.groupBy({ by: ['name'], where: { sale: saleWhere }, _sum: { quantity: true, lineTotal: true }, orderBy: { _sum: { lineTotal: 'desc' } }, take: 15 }),
      sh ? Promise.resolve([]) : this.prisma.sale.groupBy({ by: ['cashierId'], where: saleWhere, _sum: { amountDue: true }, _count: true }),
    ]);

    const userIds = [...new Set([...(byCashier as any[]).map((x) => x.cashierId), ...moves.map((m) => m.userId), ...moves.map((m) => m.approvedById)].filter(Boolean) as string[])];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } }) : [];
    const nameOf = (id?: string | null) => users.find((u) => u.id === id)?.fullName ?? (id ? '?' : 'Online / API');

    const s = sales._sum;
    const promoTotal = n(promo._sum.promoDiscount);
    const coupon = n(s.couponDiscount);
    const voids = refunds.filter((r) => r.reason?.startsWith('Void:'));
    const plainRefunds = refunds.filter((r) => !r.reason?.startsWith('Void:'));
    const sumAmt = (rows: { amount: Prisma.Decimal }[]) => r2(rows.reduce((a, r) => a + n(r.amount), 0));
    const byMethod = (rows: { method: string; amount: Prisma.Decimal }[]) => {
      const m: Record<string, number> = {};
      for (const r of rows) m[r.method] = r2((m[r.method] ?? 0) + n(r.amount));
      return m;
    };
    const mv = (type: string, cur: string) => r2(moves.filter((m) => m.type === type && m.currency === cur).reduce((a, m) => a + n(m.amount), 0));
    const net = n(s.amountDue);
    const refundTotal = sumAmt(refunds);

    // Hourly sales in the store's time zone
    const hours = await this.prisma.$queryRaw<{ h: number; count: bigint; amount: Prisma.Decimal }[]>`
      SELECT extract(hour FROM s.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${REPORT_TIMEZONE})::int AS h, count(*) AS count, coalesce(sum(s.amount_due), 0) AS amount
        FROM sales s
       WHERE ${sh ? Prisma.sql`s.shift_id = ${sh.id}::uuid` : Prisma.sql`s.store_id = ${scope.storeId}::uuid AND s.created_at >= ${scope.from} AND s.created_at < ${scope.to}`}
       GROUP BY 1 ORDER BY 1`;

    return {
      sales: {
        count: sales._count,
        gross: r2(n(s.subtotal)),
        promotions: r2(promoTotal),
        coupons: r2(coupon),
        manualDiscounts: r2(n(s.discountTotal) - promoTotal - coupon),
        discountTotal: r2(n(s.discountTotal)),
        tax: r2(n(s.taxTotal)),
        total: r2(n(s.total)),
        points: r2(n(s.pointsDiscount)),
        net,
        average: sales._count ? r2(net / sales._count) : 0,
        pointsEarned: n(s.pointsEarned),
        pointsRedeemed: n(s.pointsRedeemed),
      },
      payments: payments.map((p) => ({ method: p.method, currency: p.currency, count: p._count, amount: r2(n(p._sum.amount)), tendered: p.currency === 'KHR' ? n(p._sum.tendered) : null })),
      refunds: { count: plainRefunds.length, amount: sumAmt(plainRefunds), byMethod: byMethod(plainRefunds) },
      voids: { count: voids.length, amount: sumAmt(voids), list: voids.map((v) => ({ refundNo: v.refundNo, amount: n(v.amount), reason: v.reason!.slice(6), at: v.createdAt })) },
      netAfterRefunds: r2(net - refundTotal),
      change: { usd: r2(n(s.changeUsd)), khr: n(s.changeKhr) },
      cash: {
        payInUsd: mv('PAY_IN', 'USD'), payOutUsd: mv('PAY_OUT', 'USD'), payInKhr: mv('PAY_IN', 'KHR'), payOutKhr: mv('PAY_OUT', 'KHR'),
        movements: moves.map((m) => ({ id: m.id, type: m.type, currency: m.currency, amount: n(m.amount), reason: m.reason, by: nameOf(m.userId), approvedBy: m.approvedById ? nameOf(m.approvedById) : null, at: m.createdAt })),
      },
      walletTopups: topups.map((t) => ({ method: t.method ?? 'OTHER', count: t._count, amount: r2(n(t._sum.amount)) })),
      voucherSales: vouchers.map((v) => ({ method: v.soldMethod ?? 'OTHER', count: v._count, amount: r2(n(v._sum.value)) })),
      items: items.map((i) => ({ name: i.name, quantity: n(i._sum.quantity), amount: r2(n(i._sum.lineTotal)) })),
      hours: hours.map((h) => ({ hour: h.h, count: Number(h.count), amount: r2(n(h.amount)) })),
      cashiers: (byCashier as any[]).map((c) => ({ name: nameOf(c.cashierId), count: c._count, amount: r2(n(c._sum.amountDue)) })).sort((a, b) => b.amount - a.amount),
    };
  }
}
