import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Global, HttpCode, Injectable, Logger, Module, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApprovalAction, Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { Type } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { CurrentPrincipal, Roles } from '../common/decorators';
import { DateRangeQueryDto, dateFilter } from '../common/date-range';
import { pageArgs, toPage } from '../common/pagination';
import { assertStoreAccess, Principal, userIdOf } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';

/*
 * Cashier controls.
 *  - Audit log: one row per important action, never edited.
 *  - Manager approvals: a manager types their PIN on the cashier's POS; the server returns an approval id
 *    that the cashier's next request (sale with a big discount, refund, void) uses once, within 5 minutes.
 */

const APPROVAL_MINUTES = 5;
const MAX_PIN_FAILS = 5;
const LOCK_MINUTES = 15;

export interface AuditEntry {
  action: string;
  summary: string;
  storeId?: string | null;
  entityType?: string;
  entityId?: string | null;
  details?: unknown;
  approvedBy?: { id: string; name: string } | null;
}

@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit');

  constructor(private readonly prisma: PrismaService) {}

  private data(p: Principal | null, e: AuditEntry): Prisma.AuditLogUncheckedCreateInput {
    return {
      action: e.action, summary: e.summary.slice(0, 300), storeId: e.storeId ?? null,
      entityType: e.entityType, entityId: e.entityId ?? null,
      details: e.details === undefined ? undefined : JSON.parse(JSON.stringify(e.details)),
      userId: p ? userIdOf(p) : null, userName: p ? (p.kind === 'api_key' ? `API: ${p.name}` : p.name) : null,
      approvedById: e.approvedBy?.id ?? null, approvedByName: e.approvedBy?.name ?? null,
    };
  }

  /** Inside a transaction: the entry is saved only if the action is. */
  record(tx: Prisma.TransactionClient, p: Principal | null, e: AuditEntry) {
    return tx.auditLog.create({ data: this.data(p, e) });
  }

  /** Outside a transaction: never fails the request. */
  add(p: Principal | null, e: AuditEntry) {
    this.prisma.auditLog.create({ data: this.data(p, e) }).catch((err) => this.log.error(`Audit write failed: ${(err as Error).message}`));
  }

  async list(p: Principal, q: AuditQueryDto) {
    if (q.storeId) assertStoreAccess(p, q.storeId);
    const where: Prisma.AuditLogWhereInput = {
      ...(q.storeId ? { storeId: q.storeId } : p.storeIds === 'ALL' ? {} : { OR: [{ storeId: { in: p.storeIds } }, { storeId: null, userId: userIdOf(p) }] }),
      ...(q.action && { action: q.action }),
      ...(q.userId && { userId: q.userId }),
      ...(q.search && { OR: [{ summary: { contains: q.search, mode: 'insensitive' as const } }, { entityId: q.search }, { userName: { contains: q.search, mode: 'insensitive' as const } }] }),
      createdAt: dateFilter(q.from, q.to),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.auditLog.count({ where }),
    ]);
    return toPage(rows.map((r) => ({ ...r, id: String(r.id) })), total, q);
  }

  async actions() {
    const rows = await this.prisma.auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } });
    return rows.map((r) => r.action);
  }
}

export class AuditQueryDto extends DateRangeQueryDto {
  @IsOptional() @IsString() @MaxLength(50)
  action?: string;

  @IsOptional() @IsUUID()
  userId?: string;

  @IsOptional() @IsString() @MaxLength(100)
  search?: string;
}

export class RequestApprovalDto {
  @IsUUID()
  storeId: string;

  @IsEnum(ApprovalAction)
  action: ApprovalAction;

  @Matches(/^\d{4,8}$/, { message: 'The PIN has 4 to 8 digits' })
  pin: string;

  /** DISCOUNT: the discount % being approved */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100)
  percent?: number;

  /** REFUND / VOID: the sale */
  @IsOptional() @IsUUID()
  saleId?: string;

  @IsOptional() @IsString() @MaxLength(200)
  reason?: string;
}

export class SetPinDto {
  @IsString()
  currentPassword: string;

  /** 4-8 digits; empty removes the PIN */
  @Matches(/^(\d{4,8})?$/, { message: 'The PIN has 4 to 8 digits' })
  pin: string;
}

export const ACTION_LABEL: Record<ApprovalAction, string> = { DISCOUNT: 'discount', REFUND: 'refund', VOID: 'void' };

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** A manager of this store (or a super admin) approves with their PIN. */
  async request(p: Principal, dto: RequestApprovalDto) {
    if (p.kind !== 'user') throw new ForbiddenException('Approvals are for POS users');
    assertStoreAccess(p, dto.storeId);
    if (dto.action === 'DISCOUNT' && dto.percent === undefined) throw new BadRequestException('Say which discount % to approve');
    if (dto.action !== 'DISCOUNT' && !dto.saleId) throw new BadRequestException('Say which sale');
    // 5 wrong PINs in 15 minutes from this user: wait (stops guessing a 4-digit PIN).
    const recentFails = await this.prisma.auditLog.count({ where: { action: 'APPROVAL_DENIED', userId: p.id, createdAt: { gte: new Date(Date.now() - LOCK_MINUTES * 60_000) } } });
    if (recentFails >= MAX_PIN_FAILS) throw new ForbiddenException(`Too many wrong PINs. Try again in ${LOCK_MINUTES} minutes.`);
    const managers = await this.prisma.user.findMany({
      where: {
        isActive: true, approvalPinHash: { not: null },
        OR: [{ role: Role.SUPER_ADMIN }, { role: Role.STORE_MANAGER, stores: { some: { storeId: dto.storeId } } }],
      },
      select: { id: true, fullName: true, approvalPinHash: true },
    });
    let manager: { id: string; fullName: string } | undefined;
    for (const m of managers) {
      if (await bcrypt.compare(dto.pin, m.approvalPinHash!)) { manager = m; break; }
    }
    const what = `${ACTION_LABEL[dto.action]}${dto.action === 'DISCOUNT' ? ` ${dto.percent}%` : ''}`;
    if (!manager) {
      await this.audit.record(this.prisma, p, { action: 'APPROVAL_DENIED', storeId: dto.storeId, summary: `Wrong manager PIN for ${what}`, entityType: dto.saleId ? 'sale' : undefined, entityId: dto.saleId, details: { action: dto.action, percent: dto.percent } });
      const left = MAX_PIN_FAILS - recentFails - 1;
      throw new BadRequestException(left > 0 ? `Wrong manager PIN (${left} ${left === 1 ? 'try' : 'tries'} left)` : `Wrong manager PIN. Locked for ${LOCK_MINUTES} minutes.`);
    }
    if (manager.id === p.id && p.role === Role.CASHIER) throw new ForbiddenException('You cannot approve your own request');
    const approval = await this.prisma.approval.create({
      data: {
        storeId: dto.storeId, action: dto.action, maxPercent: dto.percent, saleId: dto.saleId, reason: dto.reason,
        managerId: manager.id, requestedById: p.id, expiresAt: new Date(Date.now() + APPROVAL_MINUTES * 60_000),
      },
    });
    this.audit.add(p, {
      action: 'APPROVAL_GRANTED', storeId: dto.storeId, summary: `${manager.fullName} approved ${what} for ${p.name}`,
      entityType: dto.saleId ? 'sale' : 'approval', entityId: dto.saleId ?? approval.id, approvedBy: { id: manager.id, name: manager.fullName },
      details: { approvalId: approval.id, action: dto.action, percent: dto.percent, reason: dto.reason },
    });
    return { approvalId: approval.id, manager: manager.fullName, expiresAt: approval.expiresAt };
  }

  /**
   * Use an approval once, inside the caller's transaction. Returns the approving manager.
   * Throws when it is missing, for another action / store / sale / user, expired or used.
   */
  async consume(tx: Prisma.TransactionClient, p: Principal, approvalId: string | undefined, need: { storeId: string; action: ApprovalAction; percent?: number; saleId?: string; usedFor: string }) {
    const label = ACTION_LABEL[need.action];
    if (!approvalId) throw new ForbiddenException(`A manager PIN is needed for this ${label}`);
    const a = await tx.approval.findUnique({ where: { id: approvalId } });
    const bad = !a || a.action !== need.action || a.storeId !== need.storeId || a.requestedById !== p.id
      || (need.saleId && a.saleId !== need.saleId) || (need.percent !== undefined && a.maxPercent !== null && a.maxPercent.lt(need.percent - 0.005));
    if (bad) throw new ForbiddenException(`The manager approval does not cover this ${label}; ask again`);
    if (a.expiresAt < new Date()) throw new ForbiddenException('The manager approval has expired; ask again');
    const used = await tx.approval.updateMany({ where: { id: a.id, usedAt: null }, data: { usedAt: new Date(), usedFor: need.usedFor } });
    if (!used.count) throw new ForbiddenException('This manager approval was already used; ask again');
    const m = await tx.user.findUniqueOrThrow({ where: { id: a.managerId }, select: { id: true, fullName: true } });
    return { id: m.id, name: m.fullName };
  }

  async setPin(p: Principal, dto: SetPinDto) {
    if (p.kind !== 'user' || p.role === Role.CASHIER) throw new ForbiddenException('Only managers have an approval PIN');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: p.id } });
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) throw new BadRequestException('Current password is wrong');
    if (dto.pin) {
      if (/^(\d)\1+$/.test(dto.pin) || '0123456789'.includes(dto.pin) || '9876543210'.includes(dto.pin)) {
        throw new BadRequestException('Choose a PIN that is harder to guess than ' + dto.pin);
      }
      // Each PIN must identify one manager (the cashier's POS only asks for the PIN).
      const others = await this.prisma.user.findMany({ where: { id: { not: p.id }, approvalPinHash: { not: null }, role: { not: Role.CASHIER } }, select: { approvalPinHash: true } });
      for (const o of others) if (await bcrypt.compare(dto.pin, o.approvalPinHash!)) throw new BadRequestException('Another manager uses this PIN; choose a different one');
    }
    await this.prisma.user.update({ where: { id: p.id }, data: { approvalPinHash: dto.pin ? await bcrypt.hash(dto.pin, 10) : null } });
    this.audit.add(p, { action: dto.pin ? 'APPROVAL_PIN_SET' : 'APPROVAL_PIN_REMOVED', summary: `${p.name} ${dto.pin ? 'set' : 'removed'} their approval PIN`, entityType: 'user', entityId: p.id });
    return { hasPin: !!dto.pin };
  }
}

@ApiTags('Cashier controls')
@ApiBearerAuth()
@Controller()
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  @Roles(Role.STORE_MANAGER)
  @Get('audit')
  list(@CurrentPrincipal() p: Principal, @Query() q: AuditQueryDto) {
    return this.audit.list(p, q);
  }

  @Roles(Role.STORE_MANAGER)
  @Get('audit/actions')
  actions() {
    return this.audit.actions();
  }

  /** Manager types their PIN on the cashier's POS. 5 wrong PINs lock the user for 15 minutes (see the service). */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('approvals')
  request(@CurrentPrincipal() p: Principal, @Body() dto: RequestApprovalDto) {
    return this.approvals.request(p, dto);
  }

  @HttpCode(200)
  @Post('auth/approval-pin')
  setPin(@CurrentPrincipal() p: Principal, @Body() dto: SetPinDto) {
    return this.approvals.setPin(p, dto);
  }
}

@Global()
@Module({ controllers: [AuditController], providers: [AuditService, ApprovalsService], exports: [AuditService, ApprovalsService] })
export class AuditModule {}
