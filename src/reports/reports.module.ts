// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { BadRequestException, Controller, Get, Injectable, Module, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Prisma, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { REPORT_TIMEZONE } from '../config';
import { CurrentPrincipal, Permission, Roles, Scopes } from '../common/decorators';
import { assertStoreAccess, Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';
import { DailySummaryService } from './daily-summary';

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

export class SlowQueryDto extends ReportQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number = 30;
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
    // Default: the last 30 days, where "today" is today in the report time zone (not in UTC:
    // just after midnight in Phnom Penh it is still yesterday in UTC).
    const localDay = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(t);
    const to = q.to ?? localDay(Date.now());
    const from = q.from ?? localDay(Date.now() - 29 * 86_400_000);
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

  /** `col IN (the caller's stores)` (or the one store asked for), without a date range. */
  private storesOnly(p: Principal, storeId: string | undefined, col: string) {
    if (storeId) {
      assertStoreAccess(p, storeId);
      return Prisma.sql`${Prisma.raw(col)} = ${storeId}::uuid`;
    }
    if (p.storeIds === 'ALL') return Prisma.sql`true`;
    if (!p.storeIds.length) return Prisma.sql`false`;
    return Prisma.sql`${Prisma.raw(col)} IN (${Prisma.join(p.storeIds.map((id) => Prisma.sql`${id}::uuid`))})`;
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

  /**
   * Busy hours: sales by weekday and hour of the day (store time). `days` = how many of each weekday the period has,
   * so the screen can show an average per day.
   */
  async hours(p: Principal, q: ReportQueryDto) {
    const { where, tz, from, to } = this.scope(p, q);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT extract(isodow FROM (s.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::int AS dow,
             extract(hour FROM (s.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::int AS hour,
             count(*)::int AS "salesCount",
             sum(s.amount_due - s.refunded_total) AS net
        FROM sales s
       WHERE ${where} AND s.status <> 'VOIDED'
       GROUP BY 1, 2 ORDER BY 1, 2`;
    // how many Mondays, Tuesdays... the period has (1 = Monday)
    const days: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
    for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d = new Date(d.getTime() + 86_400_000)) {
      days[((d.getUTCDay() + 6) % 7) + 1]++;
    }
    return {
      from, to, tz, days,
      data: rows.map((r) => ({ dow: r.dow, hour: r.hour, salesCount: r.salesCount, net: round2(num(r.net)) })),
    };
  }

  /** Sales and profit per category (the product's category now; "No category" for the others), after refunds. */
  async categories(p: Principal, q: ReportQueryDto) {
    const { where, from, to } = this.scope(p, q);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT c.id, c.name, pc.name AS parent,
             sum(si.quantity - si.refunded_qty) AS quantity,
             sum(si.net_amount * (si.quantity - si.refunded_qty) / si.quantity) AS revenue,
             sum(si.cost_price * (si.quantity - si.refunded_qty)) AS cost,
             count(DISTINCT s.id)::int AS sales
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        LEFT JOIN products pr ON pr.id = si.product_id
        LEFT JOIN categories c ON c.id = pr.category_id
        LEFT JOIN categories pc ON pc.id = c.parent_id
       WHERE ${where} AND s.status <> 'VOIDED'
       GROUP BY c.id, c.name, pc.name
       ORDER BY revenue DESC NULLS LAST`;
    const data = rows.map((r) => {
      const revenue = round2(num(r.revenue));
      const cost = round2(num(r.cost));
      const profit = round2(revenue - cost);
      return {
        id: r.id, name: r.id ? (r.parent ? `${r.parent} › ${r.name}` : r.name) : 'No category', sales: r.sales,
        quantity: Math.round(num(r.quantity) * 1000) / 1000, revenue, cost, profit, marginPercent: revenue ? round2((profit / revenue) * 100) : 0,
      };
    });
    const total = data.reduce((t, r) => t + r.revenue, 0);
    return { from, to, data: data.map((r) => ({ ...r, sharePercent: total ? round2((r.revenue / total) * 100) : 0 })) };
  }

  /**
   * Sizes and drink options sold (from each sale line's snapshot of its options), after refunds:
   * how many items had each option, and the extra charged for it. `sizes`: the Size group per drink.
   */
  async options(p: Principal, q: ReportQueryDto) {
    const { where, from, to } = this.scope(p, q);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT m->>'group' AS "group", m->>'option' AS option,
             sum(si.quantity - si.refunded_qty) AS quantity,
             sum((si.quantity - si.refunded_qty) * coalesce((m->>'price')::numeric, 0)) AS extra
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(si.modifiers::jsonb) = 'array' THEN si.modifiers::jsonb ELSE '[]'::jsonb END) m
       WHERE ${where} AND s.status <> 'VOIDED'
       GROUP BY 1, 2
       ORDER BY 1, quantity DESC`;
    const sizes = await this.prisma.$queryRaw<any[]>`
      SELECT si.product_id AS "productId", max(si.name) AS name, m->>'option' AS option, sum(si.quantity - si.refunded_qty) AS quantity
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(si.modifiers::jsonb) = 'array' THEN si.modifiers::jsonb ELSE '[]'::jsonb END) m
       WHERE ${where} AND s.status <> 'VOIDED' AND lower(m->>'group') = 'size'
       GROUP BY 1, 3`;
    // one row per group, options ordered by how often they were chosen
    type OptionRow = { option: string; quantity: number; extra: number; sharePercent: number };
    type GroupRow = { group: string; quantity: number; extra: number; options: OptionRow[] };
    const groups = new Map<string, GroupRow>();
    for (const r of rows) {
      const g: GroupRow = groups.get(r.group) ?? { group: r.group, quantity: 0, extra: 0, options: [] };
      const qty = Math.round(num(r.quantity) * 1000) / 1000;
      if (qty <= 0) continue;
      g.options.push({ option: r.option, quantity: qty, extra: round2(num(r.extra)), sharePercent: 0 });
      g.quantity += qty;
      g.extra += num(r.extra);
      groups.set(r.group, g);
    }
    const data = [...groups.values()].map((g) => ({
      ...g, extra: round2(g.extra),
      options: g.options.map((o) => ({ ...o, sharePercent: g.quantity ? round2((o.quantity / g.quantity) * 100) : 0 })),
    })).sort((a, b) => (a.group.toLowerCase() === 'size' ? -1 : b.group.toLowerCase() === 'size' ? 1 : b.quantity - a.quantity));
    // sizes per drink: { name, total, sizes: { S: 3, M: 5 } }, best sellers first
    type DrinkRow = { productId: string; name: string; total: number; sizes: Record<string, number> };
    const drinks = new Map<string, DrinkRow>();
    for (const r of sizes) {
      const qty = Math.round(num(r.quantity) * 1000) / 1000;
      if (qty <= 0) continue;
      const d: DrinkRow = drinks.get(r.productId) ?? { productId: r.productId, name: r.name, total: 0, sizes: {} };
      d.sizes[r.option] = qty;
      d.total += qty;
      drinks.set(r.productId, d);
    }
    return { from, to, data, sizes: [...drinks.values()].sort((a, b) => b.total - a.total) };
  }

  /** Sales by order type (shop sale, takeaway, dine-in, online pick-up, delivery) and channel (POS / online). */
  async orderTypes(p: Principal, q: ReportQueryDto) {
    const { where, from, to } = this.scope(p, q);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT s.order_type::text AS "orderType", s.channel,
             count(*)::int AS "salesCount", sum(s.amount_due - s.refunded_total) AS net, avg(s.total) AS "averageSale"
        FROM sales s
       WHERE ${where} AND s.status <> 'VOIDED'
       GROUP BY 1, 2 ORDER BY net DESC NULLS LAST`;
    const total = rows.reduce((t, r) => t + num(r.net), 0);
    return {
      from, to,
      data: rows.map((r) => ({
        orderType: r.orderType, channel: r.channel, salesCount: r.salesCount, net: round2(num(r.net)),
        averageSale: round2(num(r.averageSale)), sharePercent: total ? round2((num(r.net) / total) * 100) : 0,
      })),
    };
  }

  /**
   * Control: manual discounts, refunds and voids per cashier (from the audit log), who approved them, refunds as a
   * share of the cashier's sales, wrong manager PINs, and the latest events.
   */
  async control(p: Principal, q: ReportQueryDto) {
    const { where: aw, from, to } = this.scope(p, q, 'a');
    const { where: sw } = this.scope(p, q, 's');
    const actions = Prisma.sql`a.action IN ('DISCOUNT', 'DISCOUNT_APPROVED', 'REFUND', 'VOID', 'APPROVAL_DENIED')`;
    const [rows, sales, approvers, events] = await Promise.all([
      this.prisma.$queryRaw<any[]>`
        SELECT a.user_id AS "userId", max(a.user_name) AS name, a.action, count(*)::int AS n,
               coalesce(sum(CASE WHEN a.details->>'amount' ~ '^-?[0-9.]+$' THEN (a.details->>'amount')::numeric END), 0) AS amount
          FROM audit_logs a WHERE ${aw} AND ${actions}
         GROUP BY a.user_id, a.action`,
      this.prisma.$queryRaw<any[]>`
        SELECT s.cashier_id AS "userId", count(*)::int AS "salesCount", sum(s.total) AS total
          FROM sales s WHERE ${sw} GROUP BY s.cashier_id`,
      this.prisma.$queryRaw<any[]>`
        SELECT max(a.approved_by_name) AS name, a.action, count(*)::int AS n
          FROM audit_logs a WHERE ${aw} AND ${actions} AND a.approved_by_id IS NOT NULL
         GROUP BY a.approved_by_id, a.action`,
      this.prisma.$queryRaw<any[]>`
        SELECT a.created_at AS "at", a.user_name AS "user", a.action, a.entity_id AS receipt, a.summary,
               a.approved_by_name AS "approvedBy", st.code AS store,
               CASE WHEN a.details->>'amount' ~ '^-?[0-9.]+$' THEN (a.details->>'amount')::numeric END AS amount
          FROM audit_logs a LEFT JOIN stores st ON st.id = a.store_id
         WHERE ${aw} AND ${actions}
         ORDER BY a.created_at DESC LIMIT 200`,
    ]);
    type Who = { userId: string | null; name: string; salesCount: number; salesTotal: number; discounts: number; discountAmount: number; discountsApproved: number;
      refunds: number; refundAmount: number; voids: number; voidAmount: number; wrongPins: number; refundPercent: number };
    const people = new Map<string, Who>();
    const who = (id: string | null, name?: string): Who => {
      const k = id ?? '-';
      let w = people.get(k);
      if (!w) {
        w = { userId: id, name: name ?? 'Unknown', salesCount: 0, salesTotal: 0, discounts: 0, discountAmount: 0, discountsApproved: 0, refunds: 0, refundAmount: 0, voids: 0, voidAmount: 0, wrongPins: 0, refundPercent: 0 };
        people.set(k, w);
      }
      if (name && w.name === 'Unknown') w.name = name;
      return w;
    };
    for (const r of rows) {
      const w = who(r.userId, r.name);
      const amount = num(r.amount);
      if (r.action === 'DISCOUNT' || r.action === 'DISCOUNT_APPROVED') {
        w.discounts += r.n;
        w.discountAmount += amount;
        if (r.action === 'DISCOUNT_APPROVED') w.discountsApproved += r.n;
      } else if (r.action === 'REFUND') { w.refunds += r.n; w.refundAmount += amount; }
      else if (r.action === 'VOID') { w.voids += r.n; w.voidAmount += amount; }
      else if (r.action === 'APPROVAL_DENIED') w.wrongPins += r.n;
    }
    for (const r of sales) {
      if (!r.userId || !people.has(r.userId)) continue; // only people with something to check
      const w = people.get(r.userId)!;
      w.salesCount = r.salesCount;
      w.salesTotal = round2(num(r.total));
    }
    const cashiers = [...people.values()].map((w) => ({
      ...w, discountAmount: round2(w.discountAmount), refundAmount: round2(w.refundAmount), voidAmount: round2(w.voidAmount),
      refundPercent: w.salesTotal ? round2(((w.refundAmount + w.voidAmount) / w.salesTotal) * 100) : 0,
    })).sort((a, b) => b.refundAmount + b.voidAmount + b.discountAmount - (a.refundAmount + a.voidAmount + a.discountAmount));
    const mgr = new Map<string, { name: string; discounts: number; refunds: number; voids: number }>();
    for (const r of approvers) {
      const m = mgr.get(r.name) ?? { name: r.name, discounts: 0, refunds: 0, voids: 0 };
      if (r.action === 'DISCOUNT_APPROVED') m.discounts += r.n;
      else if (r.action === 'REFUND') m.refunds += r.n;
      else if (r.action === 'VOID') m.voids += r.n;
      mgr.set(r.name, m);
    }
    const totals = cashiers.reduce(
      (t, w) => ({
        discounts: t.discounts + w.discounts, discountAmount: round2(t.discountAmount + w.discountAmount), refunds: t.refunds + w.refunds,
        refundAmount: round2(t.refundAmount + w.refundAmount), voids: t.voids + w.voids, voidAmount: round2(t.voidAmount + w.voidAmount), wrongPins: t.wrongPins + w.wrongPins,
      }),
      { discounts: 0, discountAmount: 0, refunds: 0, refundAmount: 0, voids: 0, voidAmount: 0, wrongPins: 0 },
    );
    return {
      from, to, totals, cashiers,
      approvers: [...mgr.values()].sort((a, b) => b.discounts + b.refunds + b.voids - (a.discounts + a.refunds + a.voids)),
      events: events.map((e) => ({ ...e, amount: e.amount === null ? null : round2(num(e.amount)) })),
    };
  }

  /**
   * Slow movers: products the store sells (listed, active, not ingredients) that sold the least in the period,
   * with the stock and the money tied up in it, and when each last sold.
   */
  async slowMovers(p: Principal, q: SlowQueryDto) {
    const { where, from, to, tz } = this.scope(p, q, 's');
    const inv = this.storesOnly(p, q.storeId, 'i.store_id');
    const st = this.storesOnly(p, q.storeId, 's.store_id');
    const rows = await this.prisma.$queryRaw<any[]>`
      WITH sold AS (
        SELECT si.product_id, sum(si.quantity - si.refunded_qty) AS qty, sum(si.net_amount * (si.quantity - si.refunded_qty) / si.quantity) AS revenue
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE ${where} AND s.status <> 'VOIDED' GROUP BY 1),
      last AS (
        SELECT si.product_id, max(s.created_at) AS at
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE ${st} AND s.status <> 'VOIDED' GROUP BY 1)
      SELECT pr.id, pr.sku, pr.name, pr.unit, pr.track_stock AS "trackStock", c.name AS category,
             pr.created_at >= ((${from}::date)::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC' AS "isNew",
             coalesce(max(sold.qty), 0) AS qty, coalesce(max(sold.revenue), 0) AS revenue, max(last.at) AS "lastSold",
             sum(i.quantity) AS stock, sum(greatest(i.quantity, 0) * pr.cost_price) AS "stockValue"
        FROM inventory i JOIN products pr ON pr.id = i.product_id
        LEFT JOIN categories c ON c.id = pr.category_id
        LEFT JOIN sold ON sold.product_id = pr.id
        LEFT JOIN last ON last.product_id = pr.id
       WHERE ${inv} AND i.is_listed AND pr.is_active AND NOT pr.is_ingredient
       GROUP BY pr.id, c.name
       ORDER BY coalesce(max(sold.qty), 0) ASC, sum(greatest(i.quantity, 0) * pr.cost_price) DESC, pr.name
       LIMIT ${q.limit ?? 30}`;
    return {
      from, to,
      data: rows.map((r) => ({
        id: r.id, sku: r.sku, name: r.name, unit: r.unit, category: r.category, isNew: r.isNew, trackStock: r.trackStock,
        quantity: Math.round(num(r.qty) * 1000) / 1000, revenue: round2(num(r.revenue)), lastSold: r.lastSold,
        stock: r.trackStock ? Math.round(num(r.stock) * 1000) / 1000 : null, stockValue: r.trackStock ? round2(num(r.stockValue)) : null,
      })),
    };
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
  constructor(
    private readonly reports: ReportsService,
    private readonly daily: DailySummaryService,
  ) {}

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

  /** Sales by weekday and hour (busy hours). */
  @Get('hours')
  hours(@CurrentPrincipal() p: Principal, @Query() q: ReportQueryDto) {
    return this.reports.hours(p, q);
  }

  /** Sales and profit per category. */
  @Get('categories')
  categories(@CurrentPrincipal() p: Principal, @Query() q: ReportQueryDto) {
    return this.reports.categories(p, q);
  }

  /** Sizes and drink options sold. */
  @Get('options')
  options(@CurrentPrincipal() p: Principal, @Query() q: ReportQueryDto) {
    return this.reports.options(p, q);
  }

  /** Sales by order type and channel. */
  @Get('order-types')
  orderTypes(@CurrentPrincipal() p: Principal, @Query() q: ReportQueryDto) {
    return this.reports.orderTypes(p, q);
  }

  /** Discounts, refunds and voids per cashier, approvals, wrong PINs and the latest events. */
  @Get('control')
  control(@CurrentPrincipal() p: Principal, @Query() q: ReportQueryDto) {
    return this.reports.control(p, q);
  }

  /** Products that sold the least, with their stock. */
  @Get('slow-movers')
  slowMovers(@CurrentPrincipal() p: Principal, @Query() q: SlowQueryDto) {
    return this.reports.slowMovers(p, q);
  }

  /** The nightly Telegram summary for a day (default today): its text and whether sending is set up. */
  @Get('daily-summary')
  dailySummary(@Query('date') date?: string) {
    return this.daily.preview(date);
  }

  /** Send the summary for today (or ?date=) to Telegram now. */
  @Roles(Role.SUPER_ADMIN) @Permission('monitor')
  @Post('daily-summary/send')
  sendDailySummary(@Query('date') date?: string) {
    return this.daily.sendNow(date);
  }

  @Get('inventory-value')
  inventoryValue(@CurrentPrincipal() p: Principal, @Query('storeId') storeId?: string) {
    return this.reports.inventoryValue(p, storeId);
  }
}

@Module({ controllers: [ReportsController], providers: [ReportsService, DailySummaryService] })
export class ReportsModule {}
