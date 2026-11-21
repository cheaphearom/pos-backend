// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
/**
 * Scheduled price changes: a bulk price change saved to run later (e.g. new prices from 1 December 06:00).
 * Every minute (and once when the server starts, to catch up after a restart) the due ones are applied with the
 * same code as "Apply now", working from the prices at that moment. Each one is claimed first (PENDING → RUNNING),
 * so it can never run twice.
 */
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDateString } from 'class-validator';
import { AuditService } from '../audit/audit.module';
import { Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';
import { BulkPriceDto } from './products.dto';
import { ProductsService } from './products.service';

export class SchedulePriceDto extends BulkPriceDto {
  /** When to apply it (ISO date-time) */
  @Type(() => String) @IsDateString()
  runAt: string;
}

/** "+10%, rounded to 0.05, all stores" */
export function priceChangeLabel(dto: BulkPriceDto, storeCode?: string | null) {
  const c = dto.change;
  const sign = c.value > 0 ? '+' : '';
  const what = c.type === 'PERCENT' ? `${sign}${c.value}%` : c.type === 'AMOUNT' ? `${sign}$${c.value}` : `set to $${c.value}`;
  return `${what}${dto.round ? `, rounded to ${dto.round}` : ''}, ${dto.scope === 'ALL' ? 'all stores' : `store ${storeCode ?? ''}`}`.slice(0, 200);
}

const EVERY_MS = 60_000;
/** A RUNNING one older than this was interrupted (server stopped): its transaction did not finish, so try again. */
const STUCK_MS = 10 * 60_000;

@Injectable()
export class PriceScheduleService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('PriceSchedule');
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    setTimeout(() => this.tick(), 5_000).unref();
    this.timer = setInterval(() => this.tick(), EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async create(p: Principal, dto: SchedulePriceDto) {
    const runAt = new Date(dto.runAt);
    if (runAt.getTime() < Date.now() + 60_000) throw new BadRequestException('Choose a time at least 1 minute from now (or use Apply now)');
    if (runAt.getTime() > Date.now() + 366 * 86_400_000) throw new BadRequestException('Choose a time within the next year');
    const { runAt: _r, ...request } = dto;
    const preview = await this.products.bulkPrice(request as BulkPriceDto, false); // same checks as Apply now
    if (!preview.changed) throw new BadRequestException('None of the ticked products would change');
    const store = dto.scope === 'STORE' && dto.storeId ? await this.prisma.store.findUnique({ where: { id: dto.storeId }, select: { code: true } }) : null;
    const row = await this.prisma.priceSchedule.create({
      data: {
        runAt, request: request as unknown as Prisma.InputJsonValue, label: priceChangeLabel(dto, store?.code), productCount: preview.changed,
        createdById: p.id, createdByName: p.name,
      },
    });
    this.audit.add(p, {
      action: 'PRODUCT_PRICES_SCHEDULED', entityType: 'price_schedule', entityId: row.id, storeId: dto.scope === 'STORE' ? dto.storeId : undefined,
      summary: `Scheduled prices ${row.label} for ${preview.changed} product(s) at ${runAt.toISOString()}`,
    });
    return row;
  }

  async list() {
    const rows = await this.prisma.priceSchedule.findMany({ orderBy: [{ runAt: 'desc' }], take: 100 });
    const ids = [...new Set(rows.flatMap((r) => ((r.request as any)?.productIds ?? []) as string[]))];
    const names = ids.length ? await this.prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    return rows.map((r) => {
      const productIds = ((r.request as any)?.productIds ?? []) as string[];
      return { ...r, products: productIds.slice(0, 12).map((id) => nameOf.get(id) ?? '(deleted product)'), moreProducts: Math.max(0, productIds.length - 12) };
    });
  }

  async cancel(p: Principal, id: string) {
    const n = await this.prisma.priceSchedule.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledBy: p.name } });
    if (!n.count) {
      const row = await this.prisma.priceSchedule.findUnique({ where: { id }, select: { status: true } });
      if (!row) throw new NotFoundException('Scheduled price change not found');
      throw new BadRequestException(`It is ${row.status.toLowerCase()} and can no longer be cancelled`);
    }
    const row = await this.prisma.priceSchedule.findUniqueOrThrow({ where: { id } });
    this.audit.add(p, { action: 'PRODUCT_PRICES_SCHEDULE_CANCELLED', entityType: 'price_schedule', entityId: id, summary: `Cancelled scheduled prices ${row.label} (${row.productCount} product(s))` });
    return row;
  }

  /** Apply what is due. Safe to call at any time: each schedule is claimed before it runs. */
  async tick(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.prisma.priceSchedule.updateMany({ where: { status: 'RUNNING', startedAt: { lt: new Date(now.getTime() - STUCK_MS) } }, data: { status: 'PENDING' } });
      const due = await this.prisma.priceSchedule.findMany({ where: { status: 'PENDING', runAt: { lte: now } }, orderBy: { runAt: 'asc' }, take: 20 });
      for (const s of due) {
        const claimed = await this.prisma.priceSchedule.updateMany({ where: { id: s.id, status: 'PENDING' }, data: { status: 'RUNNING', startedAt: new Date() } });
        if (!claimed.count) continue;
        try {
          const out = await this.products.bulkPrice(s.request as unknown as BulkPriceDto, true, { source: 'SCHEDULED', userId: s.createdById, userName: s.createdByName, note: s.label });
          await this.prisma.priceSchedule.update({ where: { id: s.id }, data: { status: 'DONE', appliedAt: new Date(), result: { changed: out.changed, skipped: out.skipped } } });
          this.audit.add(null, {
            action: 'PRODUCT_PRICES_BULK', entityType: 'price_schedule', entityId: s.id, storeId: (s.request as any)?.scope === 'STORE' ? (s.request as any).storeId : undefined,
            summary: `Scheduled prices ${s.label} applied (scheduled by ${s.createdByName}): ${out.changed} product(s)${out.skipped ? `, ${out.skipped} skipped` : ''}`,
          });
          this.log.log(`Applied scheduled prices ${s.id}: ${out.changed} product(s)`);
        } catch (e) {
          const msg = (e as Error).message?.slice(0, 500) ?? 'failed';
          await this.prisma.priceSchedule.update({ where: { id: s.id }, data: { status: 'FAILED', error: msg } });
          this.audit.add(null, { action: 'PRODUCT_PRICES_SCHEDULE_FAILED', entityType: 'price_schedule', entityId: s.id, summary: `Scheduled prices ${s.label} could not be applied: ${msg}` });
          this.log.error(`Scheduled prices ${s.id} failed: ${msg}`);
        }
      }
    } catch (e) {
      this.log.error(`Price schedule check failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
