import { BadRequestException, Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Prisma, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { REPORT_TIMEZONE } from '../config';
import { CurrentPrincipal, Roles, Scopes } from '../common/decorators';
import { assertStoreAccess, Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';

export class ReportQueryDto {
  @IsOptional() @IsUUID()
  storeId?: string;

  /** Start date (inclusive), default: 30 days ago */
  @IsOptional() @IsDateString()
  from?: string;

  /** End date (inclusive), default: today */
  @IsOptional() @IsDateString()
  to?: string;

  /** IANA time zone for day boundaries, e.g. Asia/Phnom_Penh */
  @IsOptional() @IsString()
  tz?: string;
}

export class SalesSummaryQueryDto extends ReportQueryDto {
  @IsOptional() @IsIn(['day', 'week', 'month', 'store'])
  groupBy?: 'day' | 'week' | 'month' | 'store' = 'day';
}

export class TopQueryDto extends ReportQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number = 20;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/**
 * Reports use raw SQL with aggregates so they stay fast on millions of rows.
 * Only completed / refunded sales are counted; refunds are subtracted as "net".
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Builds the WHERE fragment for date range + store access on the `s` (sales) alias. */
  private scope(p: Principal, q: ReportQueryDto, alias = 's') {
    const tz = q.tz ?? REPORT_TIMEZONE;
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      throw new BadRequestException(`Unknown time zone ${tz}`);
    }
    const to = q.to ?? new Date().toISOString().slice(0, 10);
    const from = q.from ?? new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const col = Prisma.raw(`${alias}.created_at`);
    const storeCol = Prisma.raw(`${alias}.store_id`);
    // created_at is stored in UTC; convert local day boundaries of `tz` to UTC.
    const parts = [
      Prisma.sql`${col} >= ((${from}::date)::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'`,
      Prisma.sql`${col} < ((${to}::date + 1)::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'`,
    ];
    if (q.storeId) {
      assertStoreAccess(p, q.storeId);
      parts.push(Prisma.sql`${storeCol} = ${q.storeId}::uuid`);
    } else if (p.storeIds !== 'ALL') {
      if (!p.storeIds.length) parts.push(Prisma.sql`false`);
      else parts.push(Prisma.sql`${storeCol} IN (${Prisma.join(p.storeIds.map((id) => Prisma.sql`${id}::uuid`))})`);
    }
    return { where: Prisma.join(parts, ' AND '), tz, from, to };
  }

  async salesSummary(p: Principal, q: SalesSummaryQueryDto) {
    const { where, tz, from, to } = this.scope(p, q);
    const groupBy = q.groupBy ?? 'day';
    const key =
      groupBy === 'store'
        ? Prisma.sql`st.code`
        : Prisma.sql`to_char(date_trunc(${groupBy}, (s.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz}), 'YYYY-MM-DD')`;
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT ${key} AS key,
             count(*)::int AS "salesCount",
             sum(s.subtotal) AS subtotal,
             sum(s.discount_total) AS discount,
             sum(s.tax_total) AS tax,
             sum(s.total) AS total,
             sum(s.points_discount) AS "pointsDiscount",
             sum(s.refunded_total) AS refunds,
             sum(s.amount_due - s.refunded_total) AS net,
             avg(s.total) AS "averageSale"
        FROM sales s JOIN stores st ON st.id = s.store_id
       WHERE ${where} AND s.status <> 'VOIDED'
       GROUP BY 1 ORDER BY 1`;
    const data = rows.map((r) => ({
      key: r.key,
      salesCount: r.salesCount,
      subtotal: num(r.subtotal), discount: num(r.discount), tax: num(r.tax), total: num(r.total),
      pointsDiscount: num(r.pointsDiscount), refunds: num(r.refunds), net: num(r.net),
      averageSale: Math.round(num(r.averageSale) * 100) / 100,
    }));
    const totals = data.reduce(
      (t, r) => ({
        salesCount: t.salesCount + r.salesCount, total: t.total + r.total, refunds: t.refunds + r.refunds, net: t.net + r.net,
        tax: t.tax + r.tax, discount: t.discount + r.discount,
      }),
      { salesCount: 0, total: 0, refunds: 0, net: 0, tax: 0, discount: 0 },
    );
    return { from, to, tz, groupBy, totals, data };
  }

  async topProducts(p: Principal, q: TopQueryDto) {
    const { where, from, to } = this.scope(p, q);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT si.product_id AS "productId", si.sku, max(si.name) AS name,
             sum(si.quantity - si.refunded_qty) AS quantity,
             sum(si.net_amount * (si.quantity - si.refunded_qty) / si.quantity) AS revenue,
             sum((si.net_amount / si.quantity - si.cost_price) * (si.quantity - si.refunded_qty)) AS profit
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE ${where} AND s.status <> 'VOIDED'
       GROUP BY si.product_id, si.sku
       ORDER BY revenue DESC NULLS LAST
       LIMIT ${q.limit ?? 20}`;
    return {
      from, to,
      data: rows.map((r) => ({ ...r, quantity: num(r.quantity), revenue: round2(num(r.revenue)), profit: round2(num(r.profit)) })),
    };
  }

  async payments(p: Principal, q: ReportQueryDto) {
    const { where, from, to } = this.scope(p, q);
    // Cash tendered includes the change handed back, so subtract it to get the money actually kept.
    const rows = await this.prisma.$queryRaw<any[]>`
      WITH change AS (
        SELECT coalesce(sum(s.change_due), 0) AS total FROM sales s WHERE ${where} AND s.status <> 'VOIDED'
      )
      SELECT pm.method, count(*)::int AS count,
             sum(pm.amount) - CASE WHEN pm.method = 'CASH' THEN (SELECT total FROM change) ELSE 0 END AS amount
        FROM payments pm JOIN sales s ON s.id = pm.sale_id
       WHERE ${where} AND s.status <> 'VOIDED'
       GROUP BY pm.method ORDER BY amount DESC`;
    return { from, to, data: rows.map((r) => ({ method: r.method, count: r.count, amount: num(r.amount) })) };
  }

  /** Revenue (without tax), cost of goods and gross profit, after refunds. */
  async profit(p: Principal, q: SalesSummaryQueryDto) {
    const { where, tz, from, to } = this.scope(p, q);
    const groupBy = q.groupBy ?? 'day';
    const key =
      groupBy === 'store'
        ? Prisma.sql`st.code`
        : Prisma.sql`to_char(date_trunc(${groupBy}, (s.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz}), 'YYYY-MM-DD')`;
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT ${key} AS key,
             sum(si.net_amount * (si.quantity - si.refunded_qty) / si.quantity) AS revenue,
             sum(si.cost_price * (si.quantity - si.refunded_qty)) AS cost
        FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN stores st ON st.id = s.store_id
       WHERE ${where} AND s.status <> 'VOIDED'
       GROUP BY 1 ORDER BY 1`;
    const data = rows.map((r) => {
      const revenue = round2(num(r.revenue));
      const cost = round2(num(r.cost));
      const profit = round2(revenue - cost);
      return { key: r.key, revenue, cost, profit, marginPercent: revenue ? round2((profit / revenue) * 100) : 0 };
    });
    return { from, to, groupBy, data };
  }

  async cashiers(p: Principal, q: ReportQueryDto) {
    const { where, from, to } = this.scope(p, q);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT u.id AS "userId", coalesce(u.full_name, s.channel) AS name,
             count(*)::int AS "salesCount", sum(s.total) AS total, sum(s.refunded_total) AS refunds
        FROM sales s LEFT JOIN users u ON u.id = s.cashier_id
       WHERE ${where} AND s.status <> 'VOIDED'
       GROUP BY u.id, coalesce(u.full_name, s.channel) ORDER BY total DESC`;
    return { from, to, data: rows.map((r) => ({ ...r, total: num(r.total), refunds: num(r.refunds) })) };
  }

  async loyalty(p: Principal, q: TopQueryDto) {
    const { where, from, to } = this.scope(p, q);
    const [totals] = await this.prisma.$queryRaw<any[]>`
      SELECT count(*) FILTER (WHERE s.customer_id IS NOT NULL)::int AS "memberSales",
             count(*)::int AS "allSales",
             coalesce(sum(s.points_earned), 0)::int AS "pointsEarned",
             coalesce(sum(s.points_redeemed), 0)::int AS "pointsRedeemed",
             coalesce(sum(s.points_discount), 0) AS "pointsDiscount"
        FROM sales s WHERE ${where}`;
    const top = await this.prisma.$queryRaw<any[]>`
      SELECT c.id, c.code, c.name, c.phone, c.points, count(*)::int AS visits, sum(s.amount_due - s.refunded_total) AS spent
        FROM sales s JOIN customers c ON c.id = s.customer_id
       WHERE ${where}
       GROUP BY c.id ORDER BY spent DESC LIMIT ${q.limit ?? 20}`;
    return {
      from, to,
      totals: { ...totals, pointsDiscount: num(totals.pointsDiscount) },
      topCustomers: top.map((c) => ({ ...c, spent: num(c.spent) })),
    };
  }

  /**
   * Wallet cards: money customers hold on their cards right now (a liability: you owe it),
   * plus top-ups, payments and refunds in the period.
   */
  async wallet(p: Principal, q: ReportQueryDto) {
    const { from, to, tz } = this.scope(p, q);
    const storeIds = q.storeId ? [q.storeId] : p.storeIds;
    const storeFilter = storeIds === 'ALL' ? Prisma.sql`true` : storeIds.length ? Prisma.sql`w.store_id IN (${Prisma.join(storeIds.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.sql`false`;
    const [liability] = await this.prisma.$queryRaw<any[]>`
      SELECT count(*) FILTER (WHERE status = 'ACTIVE')::int AS "activeCards",
             count(*) FILTER (WHERE status = 'INACTIVE')::int AS "unusedCards",
             coalesce(sum(balance) FILTER (WHERE status IN ('ACTIVE', 'BLOCKED')), 0) AS "outstanding"
        FROM wallet_cards`;
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT w.type, coalesce(w.method::text, '') AS method, count(*)::int AS count, sum(w.amount) AS amount
        FROM wallet_transactions w
       WHERE ${storeFilter}
         AND w.created_at >= ((${from}::date)::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'
         AND w.created_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'
       GROUP BY 1, 2 ORDER BY 1, 2`;
    return {
      from, to,
      outstanding: round2(num(liability.outstanding)), activeCards: liability.activeCards, unusedCards: liability.unusedCards,
      data: rows.map((r) => ({ type: r.type, method: r.method || null, count: r.count, amount: round2(num(r.amount)) })),
    };
  }

  /** Ingredients used up by recipes (beans, milk, cups...) and their cost, from the stock ledger. */
  async ingredientUsage(p: Principal, q: ReportQueryDto) {
    const { from, to, tz } = this.scope(p, q);
    const storeIds = q.storeId ? [q.storeId] : p.storeIds;
    const sf = storeIds === 'ALL' ? Prisma.sql`true` : storeIds.length ? Prisma.sql`m.store_id IN (${Prisma.join(storeIds.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.sql`false`;
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT pr.id, pr.sku, pr.name, pr.unit, -sum(m.quantity) AS used, -sum(m.quantity) * pr.cost_price AS cost
        FROM stock_movements m JOIN products pr ON pr.id = m.product_id
       WHERE m.type = 'RECIPE' AND ${sf}
         AND m.created_at >= ((${from}::date)::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'
         AND m.created_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'
       GROUP BY pr.id ORDER BY cost DESC`;
    return { from, to, data: rows.map((r) => ({ ...r, used: Math.round(num(r.used) * 1000) / 1000, cost: round2(num(r.cost)) })) };
  }

  /** Coupons used per campaign, and gift vouchers sold / spent / still outstanding. */
  async couponsAndVouchers(p: Principal, q: ReportQueryDto) {
    const { from, to, tz } = this.scope(p, q);
    const storeIds = q.storeId ? [q.storeId] : p.storeIds;
    const sf = (col: string) =>
      storeIds === 'ALL' ? Prisma.sql`true` : storeIds.length ? Prisma.sql`${Prisma.raw(col)} IN (${Prisma.join(storeIds.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.sql`false`;
    const period = (col: string) => Prisma.sql`${Prisma.raw(col)} >= ((${from}::date)::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'
         AND ${Prisma.raw(col)} < ((${to}::date + 1)::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'`;
    const coupons = await this.prisma.$queryRaw<any[]>`
      SELECT c.id, c.name, count(*)::int AS uses, sum(r.discount) AS discount
        FROM coupon_redemptions r JOIN coupon_campaigns c ON c.id = r.campaign_id
       WHERE ${sf('r.store_id')} AND ${period('r.created_at')}
       GROUP BY c.id ORDER BY discount DESC`;
    const [sold] = await this.prisma.$queryRaw<any[]>`
      SELECT count(*)::int AS count, coalesce(sum(v.value), 0) AS value FROM vouchers v WHERE ${sf('v.sold_store_id')} AND v.sold_at IS NOT NULL AND ${period('v.sold_at')}`;
    const [spent] = await this.prisma.$queryRaw<any[]>`
      SELECT count(DISTINCT u.voucher_id)::int AS count, coalesce(sum(u.amount), 0) AS value FROM voucher_uses u WHERE ${sf('u.store_id')} AND ${period('u.created_at')}`;
    const outstanding = await this.prisma.$queryRaw<any[]>`
      SELECT b.sold, count(*)::int AS count, coalesce(sum(v.balance), 0) AS value
        FROM vouchers v JOIN voucher_batches b ON b.id = v.batch_id
       WHERE v.status = 'ACTIVE' AND (v.expires_at IS NULL OR v.expires_at > now())
       GROUP BY b.sold`;
    const out = (isSold: boolean) => outstanding.find((o) => o.sold === isSold) ?? { count: 0, value: 0 };
    return {
      from, to,
      coupons: coupons.map((c) => ({ ...c, discount: round2(num(c.discount)) })),
      vouchers: {
        soldInPeriod: { count: sold.count, value: round2(num(sold.value)) },
        spentInPeriod: { count: spent.count, value: round2(num(spent.value)) },
        outstandingSold: { count: out(true).count, value: round2(num(out(true).value)) },
        outstandingFree: { count: out(false).count, value: round2(num(out(false).value)) },
      },
    };
  }

  /** How much each promotion gave away and how often it was used. */
  async promotions(p: Principal, q: ReportQueryDto) {
    const { where, from, to } = this.scope(p, q);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT pr.id, pr.name, pr.type, count(DISTINCT s.id)::int AS sales,
             sum(si.quantity) AS quantity, sum(si.promo_discount) AS discount, sum(si.line_total) AS revenue
        FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN promotions pr ON pr.id = si.promotion_id
       WHERE ${where} AND s.status <> 'VOIDED' AND si.promo_discount > 0
       GROUP BY pr.id ORDER BY discount DESC`;
    return { from, to, data: rows.map((r) => ({ ...r, quantity: num(r.quantity), discount: round2(num(r.discount)), revenue: round2(num(r.revenue)) })) };
  }

  /** Current stock value per store (at cost and at selling price). */
  async inventoryValue(p: Principal, storeId?: string) {
    if (storeId) assertStoreAccess(p, storeId);
    const ids = storeId ? [storeId] : p.storeIds;
    const filter =
      ids === 'ALL' ? Prisma.sql`true` : ids.length ? Prisma.sql`i.store_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.sql`false`;
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT st.id AS "storeId", st.code, st.name,
             count(*)::int AS products,
             count(*) FILTER (WHERE i.quantity <= i.reorder_level AND i.reorder_level > 0)::int AS "lowStock",
             sum(greatest(i.quantity, 0) * pr.cost_price) AS "costValue",
             sum(greatest(i.quantity, 0) * coalesce(i.price_override, pr.sell_price)) AS "retailValue"
        FROM inventory i JOIN products pr ON pr.id = i.product_id JOIN stores st ON st.id = i.store_id
       WHERE ${filter} AND pr.track_stock
       GROUP BY st.id ORDER BY st.code`;
    return rows.map((r) => ({ ...r, costValue: round2(num(r.costValue)), retailValue: round2(num(r.retailValue)) }));
  }

  /** Numbers for the home screen: today vs yesterday. */
  async dashboard(p: Principal, q: ReportQueryDto) {
    const tz = q.tz ?? REPORT_TIMEZONE;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(Date.now() - 86_400_000));
    const [t, y, top, stock] = await Promise.all([
      this.salesSummary(p, { ...q, from: today, to: today, groupBy: 'store' }),
      this.salesSummary(p, { ...q, from: yesterday, to: yesterday, groupBy: 'store' }),
      this.topProducts(p, { ...q, from: today, to: today, limit: 5 }),
      this.inventoryValue(p, q.storeId),
    ]);
    return {
      date: today,
      today: t.totals,
      yesterday: y.totals,
      byStore: t.data,
      topProductsToday: top.data,
      lowStockItems: stock.reduce((s, r) => s + r.lowStock, 0),
    };
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

@ApiTags('Reports')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Roles(Role.STORE_MANAGER)
@Scopes('reports:read')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  dashboard(@CurrentPrincipal() p: Principal, @Query() q: ReportQueryDto) {
    return this.reports.dashboard(p, q);
  }

  /** Sales totals grouped by day, week, month or store. */
  @Get('sales-summary')
  salesSummary(@CurrentPrincipal() p: Principal, @Query() q: SalesSummaryQueryDto) {
    return this.reports.salesSummary(p, q);
  }

  @Get('top-products')
  topProducts(@CurrentPrincipal() p: Principal, @Query() q: TopQueryDto) {
    return this.reports.topProducts(p, q);
  }

  @Get('payments')
  payments(@CurrentPrincipal() p: Principal, @Query() q: ReportQueryDto) {
    return this.reports.payments(p, q);
  }

  @Get('profit')
  profit(@CurrentPrincipal() p: Principal, @Query() q: SalesSummaryQueryDto) {
    return this.reports.profit(p, q);
  }

  @Get('cashiers')
  cashiers(@CurrentPrincipal() p: Principal, @Query() q: ReportQueryDto) {
    return this.reports.cashiers(p, q);
  }

  @Get('loyalty')
  loyalty(@CurrentPrincipal() p: Principal, @Query() q: TopQueryDto) {
    return this.reports.loyalty(p, q);
  }

  @Get('ingredient-usage')
  ingredientUsage(@CurrentPrincipal() p: Principal, @Query() q: ReportQueryDto) {
    return this.reports.ingredientUsage(p, q);
  }

  @Get('coupons-vouchers')
  couponsVouchers(@CurrentPrincipal() p: Principal, @Query() q: ReportQueryDto) {
    return this.reports.couponsAndVouchers(p, q);
  }

  @Get('wallet')
  wallet(@CurrentPrincipal() p: Principal, @Query() q: ReportQueryDto) {
    return this.reports.wallet(p, q);
  }

  @Get('promotions')
  promotions(@CurrentPrincipal() p: Principal, @Query() q: ReportQueryDto) {
    return this.reports.promotions(p, q);
  }

  @Get('inventory-value')
  inventoryValue(@CurrentPrincipal() p: Principal, @Query('storeId') storeId?: string) {
    return this.reports.inventoryValue(p, storeId);
  }
}

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
