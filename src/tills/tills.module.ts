// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
/**
 * Tills: checks that no offline sale disappears from a POS computer.
 *
 * Each till (browser) has its own id and numbers its offline sales 1, 2, 3… (OFF-<code>-0001). Whenever it is online
 * it reports how many numbers it has used and which sales still wait on it. A waiting sale can only be deleted with a
 * manager PIN, and that is recorded here. Managers see, per till, every number that never arrived, is not waiting and
 * was not deleted with a PIN.
 */
import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { ApprovalsService, AuditService } from '../audit/audit.module';
import { CurrentPrincipal, Roles } from '../common/decorators';
import { assertStoreAccess, Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';

/** Short name printed on offline receipts: the first 4 characters of the till id. */
export const tillCode = (tillId: string) => tillId.replace(/-/g, '').slice(0, 4).toUpperCase();
/** A till that has not reported for this long while sales were waiting on it is shown to managers. */
export const STALE_MINUTES = 30;

export class WaitingSaleDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(100_000_000)
  seq: number;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  total: number;
}

export class TillReportDto {
  @IsUUID()
  tillId: string;

  @IsUUID()
  storeId: string;

  /** Highest offline number this till has used (0 = none yet) */
  @Type(() => Number) @IsInt() @Min(0) @Max(100_000_000)
  issuedSeq: number;

  /** Offline sales still waiting on the till (numbered ones) */
  @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => WaitingSaleDto)
  waiting: WaitingSaleDto[];
}

export class DiscardDto {
  @IsUUID()
  tillId: string;

  @IsUUID()
  storeId: string;

  @IsString() @MinLength(1) @MaxLength(64)
  clientRef: string;

  @IsString() @MinLength(1) @MaxLength(40)
  receiptNo: string;

  /** Its offline number (missing for sales made before numbering) */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000_000)
  offlineSeq?: number;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  total: number;

  @IsString() @MinLength(3) @MaxLength(200)
  reason: string;

  /** From POST /approvals with action DISCARD_OFFLINE */
  @IsUUID()
  approvalId: string;
}

export class TillsQueryDto {
  @IsOptional() @IsUUID()
  storeId?: string;
}

/** Numbers from 1 to issued that are none of: received, waiting, deleted. */
export function missingSeqs(issued: number, ...accounted: Iterable<number>[]) {
  const seen = new Set<number>();
  for (const list of accounted) for (const n of list) seen.add(n);
  const out: number[] = [];
  for (let n = 1; n <= issued; n++) if (!seen.has(n)) out.push(n);
  return out;
}

@Injectable()
export class TillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  /** The till says how far it has numbered and what still waits on it. */
  async report(p: Principal, dto: TillReportDto) {
    if (p.kind !== 'user') throw new ForbiddenException('Tills report with a staff login');
    assertStoreAccess(p, dto.storeId);
    const waitingSeqs = [...new Set(dto.waiting.map((w) => w.seq))].sort((a, b) => a - b);
    const waitingTotal = dto.waiting.reduce((s, w) => s.plus(w.total), new Prisma.Decimal(0));
    const now = new Date();
    const cur = await this.prisma.till.findUnique({ where: { id: dto.tillId } });
    const wentBack = !!cur && dto.issuedSeq < cur.issuedSeq;
    const issuedSeq = Math.max(cur?.issuedSeq ?? 0, dto.issuedSeq, ...waitingSeqs);
    const data = { storeId: dto.storeId, lastUserId: p.id, lastUserName: p.name, lastSeenAt: now, issuedSeq, waitingSeqs, waitingTotal, ...(wentBack && { counterBackAt: now }) };
    const till = await this.prisma.till.upsert({ where: { id: dto.tillId }, create: { id: dto.tillId, code: tillCode(dto.tillId), ...data }, update: data });
    if (!cur) {
      this.audit.add(p, { action: 'TILL_NEW', storeId: dto.storeId, entityType: 'till', entityId: till.id, summary: `New till ${till.code} first used by ${p.name}` });
    }
    if (wentBack) {
      this.audit.add(p, {
        action: 'TILL_COUNTER_BACK', storeId: dto.storeId, entityType: 'till', entityId: till.id,
        summary: `Till ${till.code} reported offline number ${dto.issuedSeq}, lower than ${cur!.issuedSeq} before: its browser data was cleared or changed`,
        details: { reported: dto.issuedSeq, before: cur!.issuedSeq },
      });
    }
    return { code: till.code, issuedSeq };
  }

  /** Delete a waiting offline sale from a till, with a manager PIN. Recorded, and shown in the till check. */
  async discard(p: Principal, dto: DiscardDto) {
    if (p.kind !== 'user') throw new ForbiddenException('Only staff can delete offline sales');
    assertStoreAccess(p, dto.storeId);
    const done = await this.prisma.offlineDiscard.findUnique({ where: { clientRef: dto.clientRef } });
    if (done) return { ok: true, id: done.id };
    if (await this.prisma.sale.findUnique({ where: { clientRef: dto.clientRef }, select: { id: true } })) {
      throw new BadRequestException('This sale already reached the server; it can only be refunded or voided now');
    }
    return this.prisma.$transaction(async (tx) => {
      const manager = await this.approvals.consume(tx, p, dto.approvalId, {
        storeId: dto.storeId, action: 'DISCARD_OFFLINE', ...(dto.total > 0 && { amount: dto.total }), usedFor: dto.clientRef,
      });
      const now = new Date();
      const till = await tx.till.upsert({
        where: { id: dto.tillId },
        create: { id: dto.tillId, code: tillCode(dto.tillId), storeId: dto.storeId, lastSeenAt: now, lastUserId: p.id, lastUserName: p.name, issuedSeq: dto.offlineSeq ?? 0 },
        update: {},
      });
      const row = await tx.offlineDiscard.create({
        data: {
          tillId: till.id, storeId: dto.storeId, offlineSeq: dto.offlineSeq, clientRef: dto.clientRef, receiptNo: dto.receiptNo,
          total: dto.total, reason: dto.reason.trim(), userId: p.id, approvedById: manager.id,
        },
      });
      if (dto.offlineSeq) await tx.till.update({ where: { id: till.id }, data: { waitingSeqs: till.waitingSeqs.filter((s) => s !== dto.offlineSeq) } });
      await this.audit.record(tx, p, {
        action: 'OFFLINE_SALE_DELETED', storeId: dto.storeId, entityType: 'till', entityId: till.id,
        summary: `${p.name} deleted offline sale ${dto.receiptNo} (${dto.total}) from till ${till.code}: ${dto.reason.trim()}`,
        approvedBy: manager, details: { receiptNo: dto.receiptNo, offlineSeq: dto.offlineSeq, total: dto.total, clientRef: dto.clientRef },
      });
      return { ok: true, id: row.id };
    });
  }

  /** Per till: numbers used, arrived, waiting, deleted, and the ones missing. */
  async check(p: Principal, q: TillsQueryDto) {
    if (q.storeId) assertStoreAccess(p, q.storeId);
    const tills = await this.prisma.till.findMany({
      where: q.storeId ? { storeId: q.storeId } : p.storeIds === 'ALL' ? {} : { storeId: { in: p.storeIds } },
      include: { store: { select: { code: true, name: true } }, discards: { select: { offlineSeq: true, receiptNo: true, total: true, reason: true, createdAt: true } } },
      orderBy: { lastSeenAt: 'desc' },
    });
    const ids = tills.map((t) => t.id);
    const sales = ids.length
      ? await this.prisma.sale.findMany({ where: { tillId: { in: ids }, offlineSeq: { not: null } }, select: { tillId: true, offlineSeq: true } })
      : [];
    const staleBefore = Date.now() - STALE_MINUTES * 60_000;
    return tills.map((t) => {
      const got = sales.filter((s) => s.tillId === t.id).map((s) => s.offlineSeq!);
      const counts = new Map<number, number>();
      for (const n of got) counts.set(n, (counts.get(n) ?? 0) + 1);
      const deleted = t.discards.map((d) => d.offlineSeq).filter((n): n is number => !!n);
      const missing = missingSeqs(t.issuedSeq, got, t.waitingSeqs, deleted);
      const usedTwice = [...counts].filter(([, c]) => c > 1).map(([n]) => n);
      const stale = t.waitingSeqs.length > 0 && t.lastSeenAt.getTime() < staleBefore;
      const status = missing.length || usedTwice.length ? 'problem' : t.counterBackAt || stale ? 'check' : t.waitingSeqs.length ? 'waiting' : 'ok';
      return {
        id: t.id, code: t.code, store: t.store, lastSeenAt: t.lastSeenAt, lastUserName: t.lastUserName, createdAt: t.createdAt,
        issued: t.issuedSeq, received: new Set(got).size, waiting: t.waitingSeqs.length, waitingTotal: t.waitingTotal,
        deleted: t.discards.length, missing: missing.slice(0, 200), missingCount: missing.length, usedTwice,
        missingReceipts: missing.slice(0, 50).map((n) => `OFF-${t.code}-${String(n).padStart(4, '0')}`),
        counterBackAt: t.counterBackAt, stale, status,
        discards: t.discards.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 20),
      };
    });
  }
}

@ApiTags('Tills')
@ApiBearerAuth()
@Controller('tills')
export class TillsController {
  constructor(private readonly tills: TillsService) {}

  /** Sent by the POS whenever it is online: its offline numbering and waiting sales. Any staff. */
  @Post('report')
  @HttpCode(200)
  report(@CurrentPrincipal() p: Principal, @Body() dto: TillReportDto) {
    return this.tills.report(p, dto);
  }

  /** Delete a waiting offline sale (needs a manager approval, action DISCARD_OFFLINE). */
  @Post('discard')
  @HttpCode(200)
  discard(@CurrentPrincipal() p: Principal, @Body() dto: DiscardDto) {
    return this.tills.discard(p, dto);
  }

  /** Offline sales check per till, for managers. */
  @Roles(Role.STORE_MANAGER)
  @Get()
  check(@CurrentPrincipal() p: Principal, @Query() q: TillsQueryDto) {
    return this.tills.check(p, q);
  }
}

@Module({ controllers: [TillsController], providers: [TillsService] })
export class TillsModule {}
