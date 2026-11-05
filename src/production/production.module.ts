import { BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, Role, WasteReason } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateNested } from 'class-validator';
import { randomBytes } from 'crypto';
import { CurrentPrincipal, Roles } from '../common/decorators';
import { assertStoreAccess, Principal, userIdOf } from '../common/principal';
import { REPORT_TIMEZONE } from '../config';
import { StockService } from '../inventory/stock.service';
import { PrismaService } from '../prisma/prisma.service';

/*
 * Bakery production: items made here in batches (croissants, muffins, cakes).
 *  - Plan: how much to bake today, from what usually sells on this weekday and what is still fresh.
 *  - Batch: baking takes the ingredients out of stock and puts the finished pieces in, with the real cost per piece.
 *  - End of day: what is past its shelf life, and writing off waste (with its cost) for the waste report.
 */

export class StoreQueryDto {
  @IsUUID()
  storeId: string;

  /** YYYY-MM-DD in the store's time zone; default today */
  @IsOptional() @IsDateString()
  date?: string;
}

export class RangeQueryDto {
  @IsOptional() @IsUUID()
  storeId?: string;

  @IsOptional() @IsDateString()
  from?: string;

  @IsOptional() @IsDateString()
  to?: string;
}

export class CreateBatchDto {
  @IsUUID()
  storeId: string;

  @IsUUID()
  productId: string;

  /** Pieces to make */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001)
  quantity: number;

  /** Already baked: record it as done right away */
  @IsOptional() @IsBoolean()
  done?: boolean;

  @IsOptional() @IsString() @MaxLength(200)
  note?: string;
}

export class CompleteBatchDto {
  /** Pieces actually made (default: the planned quantity) */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001)
  producedQty?: number;
}

export class WasteItemDto {
  @IsUUID()
  productId: string;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001)
  quantity: number;

  @IsEnum(WasteReason)
  reason: WasteReason;

  @IsOptional() @IsString() @MaxLength(200)
  note?: string;
}

export class WasteDto {
  @IsUUID()
  storeId: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => WasteItemDto)
  items: WasteItemDto[];
}

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;
const HISTORY_WEEKS = 4;
const BUFFER = 1.1; // bake 10% more than usually sells

/** YYYY-MM-DD of an instant in a time zone */
const dayIn = (t: number | Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(t);

/** The UTC instant of midnight at the start of `day` in `tz`. */
export function zonedMidnight(day: string, tz: string): Date {
  const guess = new Date(day + 'T00:00:00Z');
  // offset of tz at that moment, in minutes (e.g. +420 for Asia/Phnom_Penh)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(guess).reduce<Record<string, string>>((a, p) => ((a[p.type] = p.value), a), {});
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}
const addDays = (day: string, d: number) => new Date(Date.parse(day + 'T00:00:00Z') + d * 86_400_000).toISOString().slice(0, 10);

@Injectable()
export class ProductionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
  ) {}

  private bakeryProducts() {
    return this.prisma.product.findMany({
      where: { isActive: true, madeInHouse: true },
      select: {
        id: true, sku: true, name: true, unit: true, batchYield: true, shelfLifeHours: true, costPrice: true,
        recipe: { select: { quantity: true, ingredient: { select: { costPrice: true } } } },
      },
      orderBy: { name: 'asc' },
    });
  }

  /** Pieces from batches still within their shelf life (newest first), per product. */
  private async freshPieces(storeId: string, productIds: string[], at: Date) {
    const rows = await this.prisma.productionBatch.groupBy({
      by: ['productId'],
      where: { storeId, productId: { in: productIds }, status: 'DONE', expiresAt: { gt: at } },
      _sum: { producedQty: true },
    });
    return new Map(rows.map((r) => [r.productId, n(r._sum.producedQty)]));
  }

  /**
   * Today's bake plan. "Usually sells" = average sold on the same weekday over the last 4 weeks
   * (or the daily average when there is no history for that weekday).
   */
  async plan(p: Principal, q: StoreQueryDto) {
    assertStoreAccess(p, q.storeId);
    const tz = REPORT_TIMEZONE;
    const day = q.date ?? dayIn(Date.now(), tz);
    const products = await this.bakeryProducts();
    if (!products.length) return { date: day, products: [] };
    const ids = products.map((x) => x.id);
    const histFrom = zonedMidnight(addDays(day, -HISTORY_WEEKS * 7), tz);
    const dayStart = zonedMidnight(day, tz);
    const dayEnd = zonedMidnight(addDays(day, 1), tz);

    const [sold, inv, batches, fresh] = await Promise.all([
      this.prisma.$queryRaw<{ product_id: string; same_dow: Prisma.Decimal; total: Prisma.Decimal; today: Prisma.Decimal }[]>`
        SELECT si.product_id,
               coalesce(sum(si.quantity - si.refunded_qty) FILTER (
                 WHERE extract(dow FROM s.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz}) = extract(dow FROM ${day}::date)
                   AND s.created_at < ${dayStart}), 0) AS same_dow,
               coalesce(sum(si.quantity - si.refunded_qty) FILTER (WHERE s.created_at < ${dayStart}), 0) AS total,
               coalesce(sum(si.quantity - si.refunded_qty) FILTER (WHERE s.created_at >= ${dayStart}), 0) AS today
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE s.store_id = ${q.storeId}::uuid AND s.status IN ('COMPLETED', 'PARTIALLY_REFUNDED')
           AND s.created_at >= ${histFrom} AND s.created_at < ${dayEnd}
           AND si.product_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
         GROUP BY si.product_id`,
      this.prisma.inventory.findMany({ where: { storeId: q.storeId, productId: { in: ids } }, select: { productId: true, quantity: true } }),
      this.prisma.productionBatch.findMany({
        where: { storeId: q.storeId, productId: { in: ids }, createdAt: { gte: dayStart, lt: dayEnd }, status: { not: 'CANCELLED' } },
        select: { productId: true, status: true, plannedQty: true, producedQty: true },
      }),
      this.freshPieces(q.storeId, ids, new Date()),
    ]);

    return {
      date: day,
      products: products.map((x) => {
        const s = sold.find((r) => r.product_id === x.id);
        const sameDow = n(s?.same_dow) / HISTORY_WEEKS;
        const daily = n(s?.total) / (HISTORY_WEEKS * 7);
        const usual = r3(sameDow || daily);
        const stock = n(inv.find((i) => i.productId === x.id)?.quantity);
        // Without a shelf life every piece in stock counts; otherwise only pieces still fresh.
        const freshNow = x.shelfLifeHours ? Math.min(Math.max(stock, 0), fresh.get(x.id) ?? 0) : Math.max(stock, 0);
        const mine = batches.filter((b) => b.productId === x.id);
        const planned = mine.filter((b) => b.status === 'PLANNED').reduce((a, b) => a + n(b.plannedQty), 0);
        const bakedToday = mine.filter((b) => b.status === 'DONE').reduce((a, b) => a + n(b.producedQty), 0);
        const yieldPerBatch = n(x.batchYield) || 1;
        const need = Math.max(0, Math.ceil(usual * BUFFER - freshNow - planned));
        const batchesNeeded = need ? Math.ceil(need / yieldPerBatch) : 0;
        const batchCost = x.recipe.reduce((a, r) => a + n(r.quantity) * n(r.ingredient.costPrice), 0);
        return {
          id: x.id, sku: x.sku, name: x.name, unit: x.unit, batchYield: yieldPerBatch, shelfLifeHours: x.shelfLifeHours,
          hasRecipe: x.recipe.length > 0, costPerPiece: x.recipe.length ? r3(batchCost / yieldPerBatch) : n(x.costPrice),
          usuallySells: usual, soldToday: n(s?.today), stock, fresh: freshNow, plannedQty: planned, bakedToday,
          suggestedBatches: batchesNeeded, suggestedQty: r3(batchesNeeded * yieldPerBatch),
        };
      }),
    };
  }

  async batches(p: Principal, q: StoreQueryDto) {
    assertStoreAccess(p, q.storeId);
    const day = q.date ?? dayIn(Date.now(), REPORT_TIMEZONE);
    return this.prisma.productionBatch.findMany({
      where: { storeId: q.storeId, createdAt: { gte: zonedMidnight(day, REPORT_TIMEZONE), lt: zonedMidnight(addDays(day, 1), REPORT_TIMEZONE) } },
      include: { product: { select: { name: true, sku: true, unit: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(p: Principal, id: string) {
    const b = await this.prisma.productionBatch.findUnique({ where: { id }, include: { product: { select: { name: true, sku: true, unit: true } }, store: { select: { code: true, name: true } } } });
    if (!b) throw new NotFoundException('Batch not found');
    assertStoreAccess(p, b.storeId);
    return b;
  }

  async create(p: Principal, dto: CreateBatchDto) {
    assertStoreAccess(p, dto.storeId);
    const [store, product] = await Promise.all([
      this.prisma.store.findUniqueOrThrow({ where: { id: dto.storeId } }),
      this.prisma.product.findUnique({ where: { id: dto.productId } }),
    ]);
    if (!product?.isActive || !product.madeInHouse) throw new BadRequestException('Only products marked "Made here (bakery)" can be baked');
    const batchNo = `B-${store.code}-${dayIn(Date.now(), REPORT_TIMEZONE).replace(/-/g, '')}-${randomBytes(2).toString('hex').toUpperCase()}`;
    const batch = await this.prisma.productionBatch.create({
      data: { batchNo, storeId: dto.storeId, productId: dto.productId, plannedQty: dto.quantity, note: dto.note, createdById: userIdOf(p) },
    });
    return dto.done ? this.complete(p, batch.id, { producedQty: dto.quantity }) : this.get(p, batch.id);
  }

  /**
   * Baked: ingredients out (scaled from the batch recipe), finished pieces in, cost per piece saved
   * on the batch and as the product's cost (so profit reports use the real cost). All or nothing.
   */
  async complete(p: Principal, id: string, dto: CompleteBatchDto) {
    const batch = await this.get(p, id);
    if (batch.status !== 'PLANNED') throw new BadRequestException(`This batch is already ${batch.status.toLowerCase()}`);
    const product = await this.prisma.product.findUniqueOrThrow({
      where: { id: batch.productId },
      include: { recipe: { include: { ingredient: { select: { id: true, name: true, unit: true, costPrice: true } } } } },
    });
    const pieces = new Prisma.Decimal(dto.producedQty ?? batch.plannedQty);
    const factor = pieces.div(product.batchYield.gt(0) ? product.batchYield : 1);
    const used = product.recipe.map((r) => {
      const quantity = r.quantity.mul(factor).toDecimalPlaces(3);
      return { ingredientId: r.ingredientId, name: r.ingredient.name, unit: r.ingredient.unit, quantity, cost: quantity.mul(r.ingredient.costPrice) };
    }).filter((u) => u.quantity.gt(0));
    const totalCost = used.length ? used.reduce((a, u) => a.plus(u.cost), new Prisma.Decimal(0)) : pieces.mul(product.costPrice);
    const unitCost = totalCost.div(pieces).toDecimalPlaces(6);
    const now = new Date();
    const userId = userIdOf(p);

    return this.prisma.$transaction(async (tx) => {
      // Claim the batch first so two taps on "Done" cannot bake it twice.
      const claimed = await tx.productionBatch.updateMany({ where: { id, status: 'PLANNED' }, data: { status: 'DONE' } });
      if (!claimed.count) throw new BadRequestException('This batch was already completed');
      // Same order every time (by product id) so parallel batches cannot deadlock.
      const moves = [
        { productId: product.id, delta: pieces, type: 'PRODUCTION' as const },
        ...used.map((u) => ({ productId: u.ingredientId, delta: u.quantity.neg(), type: 'PRODUCTION_USE' as const })),
      ].sort((a, b) => a.productId.localeCompare(b.productId));
      for (const m of moves) {
        // A missing ingredient never stops the baker (same rule as drinks): stock may go below zero and shows as low.
        await this.stock.apply(tx, { storeId: batch.storeId, ...m, referenceType: 'PRODUCTION', referenceId: id, note: batch.batchNo, userId, allowNegative: true });
      }
      if (used.length) await tx.product.update({ where: { id: product.id }, data: { costPrice: unitCost } });
      return tx.productionBatch.update({
        where: { id },
        data: {
          producedQty: pieces, unitCost, totalCost: totalCost.toDecimalPlaces(2), completedAt: now, completedById: userId,
          expiresAt: product.shelfLifeHours ? new Date(now.getTime() + product.shelfLifeHours * 3600_000) : null,
          ingredients: used.map((u) => ({ ingredientId: u.ingredientId, name: u.name, unit: u.unit, quantity: Number(u.quantity), cost: r2(Number(u.cost)) })),
        },
        include: { product: { select: { name: true, sku: true, unit: true } } },
      });
    });
  }

  async cancel(p: Principal, id: string) {
    await this.get(p, id);
    const r = await this.prisma.productionBatch.updateMany({ where: { id, status: 'PLANNED' }, data: { status: 'CANCELLED' } });
    if (!r.count) throw new BadRequestException('Only planned batches can be cancelled');
    return this.get(p, id);
  }

  /**
   * End of day: bakery stock that is past its shelf life. Pieces are assumed to sell oldest first,
   * so what is left beyond the still-fresh batches is expired.
   */
  async endOfDay(p: Principal, q: StoreQueryDto) {
    assertStoreAccess(p, q.storeId);
    const products = await this.bakeryProducts();
    const ids = products.map((x) => x.id);
    const now = new Date();
    const tomorrow = zonedMidnight(addDays(dayIn(now, REPORT_TIMEZONE), 1), REPORT_TIMEZONE);
    const [inv, freshNow, freshTomorrow, wasteToday] = await Promise.all([
      this.prisma.inventory.findMany({ where: { storeId: q.storeId, productId: { in: ids } }, select: { productId: true, quantity: true } }),
      this.freshPieces(q.storeId, ids, now),
      this.freshPieces(q.storeId, ids, tomorrow),
      this.prisma.wasteEntry.groupBy({ by: ['productId'], where: { storeId: q.storeId, productId: { in: ids }, createdAt: { gte: zonedMidnight(dayIn(now, REPORT_TIMEZONE), REPORT_TIMEZONE) } }, _sum: { quantity: true } }),
    ]);
    return products
      .map((x) => {
        const stock = n(inv.find((i) => i.productId === x.id)?.quantity);
        const fresh = x.shelfLifeHours ? Math.min(Math.max(stock, 0), freshNow.get(x.id) ?? 0) : Math.max(stock, 0);
        const keep = x.shelfLifeHours ? Math.min(Math.max(stock, 0), freshTomorrow.get(x.id) ?? 0) : Math.max(stock, 0);
        return {
          id: x.id, sku: x.sku, name: x.name, unit: x.unit, shelfLifeHours: x.shelfLifeHours, costPrice: n(x.costPrice), stock,
          expired: r3(Math.max(0, stock - fresh)), // past shelf life now
          expiresToday: r3(Math.max(0, fresh - keep)), // still fresh now, not tomorrow
          goodTomorrow: r3(keep),
          wastedToday: n(wasteToday.find((w) => w.productId === x.id)?._sum.quantity),
        };
      })
      .filter((x) => x.stock > 0 || x.wastedToday > 0);
  }

  /** Write off stock (any product: bakery, ingredients, retail), saving its cost for the waste report. */
  async waste(p: Principal, dto: WasteDto) {
    assertStoreAccess(p, dto.storeId);
    const ids = [...new Set(dto.items.map((i) => i.productId))];
    if (ids.length !== dto.items.length) throw new BadRequestException('Each product only once');
    const products = await this.prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, costPrice: true, trackStock: true, name: true } });
    if (products.length !== ids.length) throw new BadRequestException('Product not found');
    const untracked = products.find((x) => !x.trackStock);
    if (untracked) throw new BadRequestException(`${untracked.name} has no stock`);
    const userId = userIdOf(p);
    const items = [...dto.items].sort((a, b) => a.productId.localeCompare(b.productId));
    return this.prisma.$transaction(async (tx) => {
      const out = [];
      for (const i of items) {
        const prod = products.find((x) => x.id === i.productId)!;
        const entry = await tx.wasteEntry.create({ data: { storeId: dto.storeId, productId: i.productId, quantity: i.quantity, unitCost: prod.costPrice, reason: i.reason, note: i.note, userId } });
        const res = await this.stock.apply(tx, {
          storeId: dto.storeId, productId: i.productId, delta: -i.quantity, type: 'WASTE', referenceType: 'WASTE', referenceId: entry.id,
          note: [i.reason.toLowerCase(), i.note].filter(Boolean).join(': '), userId, allowNegative: false,
        });
        out.push({ ...entry, balanceAfter: res.balanceAfter, cost: r2(i.quantity * Number(prod.costPrice)) });
      }
      return out;
    });
  }

  /** Produced, sold and wasted per product, with cost and waste %. */
  async report(p: Principal, q: RangeQueryDto) {
    if (q.storeId) assertStoreAccess(p, q.storeId);
    const tz = REPORT_TIMEZONE;
    const to = q.to ?? dayIn(Date.now(), tz);
    const from = q.from ?? addDays(to, -29);
    const start = zonedMidnight(from, tz), end = zonedMidnight(addDays(to, 1), tz);
    const stores = q.storeId ? [q.storeId] : p.storeIds === 'ALL' ? null : p.storeIds;
    const storeWhere = stores ? { storeId: { in: stores } } : {};
    const [made, wasted, wasteByReason, products] = await Promise.all([
      this.prisma.productionBatch.groupBy({ by: ['productId'], where: { ...storeWhere, status: 'DONE', completedAt: { gte: start, lt: end } }, _sum: { producedQty: true, totalCost: true }, _count: true }),
      this.prisma.$queryRaw<{ product_id: string; qty: Prisma.Decimal; cost: Prisma.Decimal }[]>`
        SELECT product_id, sum(quantity) AS qty, sum(quantity * unit_cost) AS cost FROM waste_entries
         WHERE created_at >= ${start} AND created_at < ${end}
           ${stores ? Prisma.sql`AND store_id IN (${Prisma.join(stores.map((s) => Prisma.sql`${s}::uuid`))})` : Prisma.empty}
         GROUP BY product_id`,
      this.prisma.$queryRaw<{ reason: string; qty: Prisma.Decimal; cost: Prisma.Decimal }[]>`
        SELECT reason::text, sum(quantity) AS qty, sum(quantity * unit_cost) AS cost FROM waste_entries
         WHERE created_at >= ${start} AND created_at < ${end}
           ${stores ? Prisma.sql`AND store_id IN (${Prisma.join(stores.map((s) => Prisma.sql`${s}::uuid`))})` : Prisma.empty}
         GROUP BY reason ORDER BY 3 DESC`,
      this.prisma.product.findMany({ where: { OR: [{ madeInHouse: true }, { wasteEntries: { some: { createdAt: { gte: start, lt: end } } } }] }, select: { id: true, sku: true, name: true, unit: true, madeInHouse: true } }),
    ]);
    const ids = products.map((x) => x.id);
    const sold = ids.length
      ? await this.prisma.$queryRaw<{ product_id: string; qty: Prisma.Decimal }[]>`
          SELECT si.product_id, sum(si.quantity - si.refunded_qty) AS qty
            FROM sale_items si JOIN sales s ON s.id = si.sale_id
           WHERE s.status IN ('COMPLETED', 'PARTIALLY_REFUNDED') AND s.created_at >= ${start} AND s.created_at < ${end}
             ${stores ? Prisma.sql`AND s.store_id IN (${Prisma.join(stores.map((s) => Prisma.sql`${s}::uuid`))})` : Prisma.empty}
             AND si.product_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
           GROUP BY si.product_id`
      : [];
    const rows = products.map((x) => {
      const m = made.find((r) => r.productId === x.id);
      const w = wasted.find((r) => r.product_id === x.id);
      const produced = n(m?._sum.producedQty);
      const wasteQty = n(w?.qty);
      return {
        productId: x.id, sku: x.sku, name: x.name, unit: x.unit, madeInHouse: x.madeInHouse,
        batches: m?._count ?? 0, produced, productionCost: r2(n(m?._sum.totalCost)),
        sold: n(sold.find((r) => r.product_id === x.id)?.qty), wasted: wasteQty, wasteCost: r2(n(w?.cost)),
        wastePercent: produced ? Math.round((wasteQty / produced) * 1000) / 10 : null,
      };
    }).filter((x) => x.produced || x.wasted || x.sold);
    rows.sort((a, b) => b.wasteCost - a.wasteCost || b.produced - a.produced);
    return {
      from, to, data: rows,
      byReason: wasteByReason.map((r) => ({ reason: r.reason, quantity: n(r.qty), cost: r2(n(r.cost)) })),
      totals: {
        productionCost: r2(rows.reduce((a, x) => a + x.productionCost, 0)),
        wasteCost: r2(rows.reduce((a, x) => a + x.wasteCost, 0)),
      },
    };
  }
}

@ApiTags('Bakery production')
@ApiBearerAuth()
@Controller('production')
export class ProductionController {
  constructor(private readonly production: ProductionService) {}

  /** What to bake today */
  @Get('plan')
  plan(@CurrentPrincipal() p: Principal, @Query() q: StoreQueryDto) {
    return this.production.plan(p, q);
  }

  @Get('batches')
  batches(@CurrentPrincipal() p: Principal, @Query() q: StoreQueryDto) {
    return this.production.batches(p, q);
  }

  @Get('batches/:id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.production.get(p, id);
  }

  @Post('batches')
  create(@CurrentPrincipal() p: Principal, @Body() dto: CreateBatchDto) {
    return this.production.create(p, dto);
  }

  @Post('batches/:id/complete')
  complete(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CompleteBatchDto) {
    return this.production.complete(p, id, dto);
  }

  @Post('batches/:id/cancel')
  cancel(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.production.cancel(p, id);
  }

  /** Leftovers: expired now, expiring tonight, still good tomorrow */
  @Get('end-of-day')
  endOfDay(@CurrentPrincipal() p: Principal, @Query() q: StoreQueryDto) {
    return this.production.endOfDay(p, q);
  }

  @Post('waste')
  waste(@CurrentPrincipal() p: Principal, @Body() dto: WasteDto) {
    return this.production.waste(p, dto);
  }

  @Roles(Role.STORE_MANAGER)
  @Get('report')
  report(@CurrentPrincipal() p: Principal, @Query() q: RangeQueryDto) {
    return this.production.report(p, q);
  }
}

@Module({ controllers: [ProductionController], providers: [ProductionService] })
export class ProductionModule {}

