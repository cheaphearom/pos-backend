import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CashMoveType, Prisma, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { ApprovalsService, AuditService } from '../audit/audit.module';
import { CurrentPrincipal, Roles } from '../common/decorators';
import { PageQueryDto, pageArgs, toPage } from '../common/pagination';
import { assertStoreAccess, Principal, storeScope } from '../common/principal';
import { REPORT_TIMEZONE } from '../config';
import { zonedMidnight } from '../production/production.module';
import { PrismaService } from '../prisma/prisma.service';
import { ShiftsModule, ShiftsService } from '../shifts/shifts.module';
import { RegisterReportService } from './register-report';

/*
 * The cash drawer during the day:
 *  - Cash in / out: money put into or taken out of the drawer (float, paid-outs, bank drops), with a reason.
 *  - X report: the shift so far, printable any time, changes nothing.
 *  - Z report: closes a store's business day. Numbered (Z-0001…), saved once, reprinted from the saved figures.
 */

export class CashMoveDto {
  @IsEnum(CashMoveType)
  type: CashMoveType;

  @IsOptional() @IsIn(['USD', 'KHR'])
  currency?: 'USD' | 'KHR';

  /** Dollars (2 decimals) or riel (whole, steps of 100) */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01)
  amount: number;

  @IsString() @MinLength(3) @MaxLength(200)
  reason: string;

  /** Cashier pay-outs: from POST /approvals (action CASH_OUT) */
  @IsOptional() @IsUUID()
  approvalId?: string;
}

export class ZQueryDto extends PageQueryDto {
  @IsOptional() @IsUUID()
  storeId?: string;
}

export class ZRunDto {
  @IsUUID()
  storeId: string;

  /** Business day YYYY-MM-DD (store time zone); default today */
  @IsOptional() @IsDateString()
  date?: string;
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE }).format(new Date());
const nextDay = (d: string) => new Date(Date.parse(d + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);

@Injectable()
export class RegistersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shifts: ShiftsService,
    private readonly report: RegisterReportService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  private async shiftFor(p: Principal, id: string) {
    const shift = await this.prisma.shift.findUnique({ where: { id }, include: { user: { select: { fullName: true } }, store: { select: { id: true, code: true, name: true, address: true, currency: true, khrRate: true, cashOutNeedsApproval: true } } } });
    if (!shift) throw new NotFoundException('Shift not found');
    assertStoreAccess(p, shift.storeId);
    if (p.role === Role.CASHIER && shift.userId !== p.id) throw new ForbiddenException('Not your shift');
    return shift;
  }

  /** Money in or out of the drawer during an open shift. */
  async moveCash(p: Principal, shiftId: string, dto: CashMoveDto) {
    const shift = await this.shiftFor(p, shiftId);
    if (shift.status !== 'OPEN') throw new BadRequestException('The shift is closed');
    const currency = dto.currency ?? 'USD';
    if (currency === 'KHR') {
      if (!shift.store.khrRate) throw new BadRequestException('Riel cash is not set up for this store');
      if (!Number.isInteger(dto.amount) || dto.amount % 100) throw new BadRequestException('Riel must be in steps of 100');
    }
    const usdValue = currency === 'KHR' ? Math.round((dto.amount / shift.store.khrRate!) * 100) / 100 : dto.amount;
    if (dto.type === 'PAY_OUT') {
      // Never more than the drawer should hold
      const sum = await this.shifts.summarize(shift);
      const left = currency === 'KHR' ? sum.khr.expected : Number(sum.expectedCash);
      if (dto.amount > left + 1e-9) throw new BadRequestException(`The drawer should only have ${currency === 'KHR' ? `${left} riel` : left.toFixed(2)}`);
    }
    return this.prisma.$transaction(async (tx) => {
      const approvedBy = dto.type === 'PAY_OUT' && p.role === Role.CASHIER && shift.store.cashOutNeedsApproval
        ? await this.approvals.consume(tx, p, dto.approvalId, { storeId: shift.storeId, action: 'CASH_OUT', amount: usdValue, usedFor: `shift ${shift.id}` })
        : null;
      const m = await tx.cashMovement.create({
        data: { shiftId, storeId: shift.storeId, userId: p.id, type: dto.type, currency, amount: dto.amount, reason: dto.reason.trim(), approvedById: approvedBy?.id },
      });
      const amt = currency === 'KHR' ? `${dto.amount} riel` : dto.amount.toFixed(2);
      await this.audit.record(tx, p, {
        action: dto.type === 'PAY_IN' ? 'CASH_IN' : 'CASH_OUT', storeId: shift.storeId, entityType: 'shift', entityId: shift.id, approvedBy,
        summary: `${dto.type === 'PAY_IN' ? 'Cash in' : 'Cash out'} ${amt}: ${dto.reason.trim()}${approvedBy ? `, approved by ${approvedBy.name}` : ''}`,
        details: { type: dto.type, currency, amount: dto.amount },
      });
      return m;
    });
  }

  listCash(p: Principal, shiftId: string) {
    return this.shiftFor(p, shiftId).then(() => this.prisma.cashMovement.findMany({ where: { shiftId }, orderBy: { createdAt: 'asc' } }));
  }

  /** X report: the shift so far. */
  async xReport(p: Principal, shiftId: string) {
    const shift = await this.shiftFor(p, shiftId);
    const [summary, figures] = await Promise.all([this.shifts.summarize(shift), this.report.build({ storeId: shift.storeId, shift })]);
    return {
      kind: 'X', printedAt: new Date(), store: shift.store, cashier: shift.user.fullName,
      shift: { id: shift.id, status: shift.status, openedAt: shift.openedAt, closedAt: shift.closedAt, openingCash: shift.openingCash, openingKhr: shift.openingKhr, closingCash: shift.closingCash, closingKhr: shift.closingKhr },
      drawer: drawerOf(shift, summary),
      ...figures,
    };
  }

  private async dayData(storeId: string, day: string) {
    const from = zonedMidnight(day, REPORT_TIMEZONE), to = zonedMidnight(nextDay(day), REPORT_TIMEZONE);
    const store = await this.prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { id: true, code: true, name: true, address: true, currency: true, khrRate: true } });
    const shifts = await this.prisma.shift.findMany({ where: { storeId, openedAt: { gte: from, lt: to } }, include: { user: { select: { fullName: true } } }, orderBy: { openedAt: 'asc' } });
    const drawers = await Promise.all(shifts.map(async (sh) => ({ cashier: sh.user.fullName, status: sh.status, openedAt: sh.openedAt, closedAt: sh.closedAt, ...drawerOf(sh, await this.shifts.summarize(sh)) })));
    return { store, from, to, shifts, drawers, figures: await this.report.build({ storeId, from, to }) };
  }

  /** What the Z report would show (nothing is saved). */
  async preview(p: Principal, storeId: string, day = today()) {
    assertStoreAccess(p, storeId);
    const d = await this.dayData(storeId, day);
    const done = await this.prisma.zReport.findUnique({ where: { storeId_businessDay: { storeId, businessDay: new Date(day + 'T00:00:00Z') } }, select: { id: true, zNo: true } });
    return {
      kind: 'Z', preview: true, businessDay: day, store: d.store, from: d.from, to: d.to, alreadyClosed: done,
      openShifts: d.shifts.filter((s) => s.status === 'OPEN').map((s) => s.user.fullName),
      shifts: d.drawers, ...d.figures,
    };
  }

  /** Close the business day: every shift of the day must be closed; one Z per store and day. */
  async run(p: Principal, dto: ZRunDto) {
    assertStoreAccess(p, dto.storeId);
    const day = dto.date ?? today();
    if (day > today()) throw new BadRequestException('That day has not started yet');
    const d = await this.dayData(dto.storeId, day);
    const open = d.shifts.filter((s) => s.status === 'OPEN');
    if (open.length) throw new BadRequestException(`Close these shifts first: ${open.map((s) => s.user.fullName).join(', ')}`);
    const data = { kind: 'Z', businessDay: day, store: d.store, from: d.from, to: d.to, shifts: d.drawers, ...d.figures };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const [{ z_seq: zNo }] = await tx.$queryRaw<{ z_seq: number }[]>`UPDATE stores SET z_seq = z_seq + 1 WHERE id = ${dto.storeId}::uuid RETURNING z_seq`;
        const z = await tx.zReport.create({
          data: { storeId: dto.storeId, zNo, businessDay: new Date(day + 'T00:00:00Z'), fromAt: d.from, toAt: d.to, data: JSON.parse(JSON.stringify({ ...data, zNo })), createdById: p.kind === 'user' ? p.id : null },
        });
        await this.audit.record(tx, p, {
          action: 'Z_REPORT', storeId: dto.storeId, entityType: 'z-report', entityId: `${d.store.code}-Z${String(zNo).padStart(4, '0')}`,
          summary: `Z report ${d.store.code}-Z${String(zNo).padStart(4, '0')} for ${day}: ${d.figures.sales.count} sales, net ${d.figures.netAfterRefunds.toFixed(2)}`,
        });
        return this.view(z);
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new BadRequestException(`The Z report for ${day} was already run; reprint it from the list`);
      throw e;
    }
  }

  private view(z: Prisma.ZReportGetPayload<object>) {
    return { id: z.id, zNo: z.zNo, businessDay: z.businessDay.toISOString().slice(0, 10), createdAt: z.createdAt, ...(z.data as object) };
  }

  async list(p: Principal, q: ZQueryDto) {
    const where = storeScope(p, q.storeId);
    const [rows, total] = await Promise.all([
      this.prisma.zReport.findMany({ where, orderBy: [{ businessDay: 'desc' }], ...pageArgs(q) }),
      this.prisma.zReport.count({ where }),
    ]);
    return toPage(rows.map((z) => {
      const d = z.data as any;
      return { id: z.id, zNo: z.zNo, businessDay: z.businessDay.toISOString().slice(0, 10), createdAt: z.createdAt, store: d.store, sales: d.sales?.count, net: d.netAfterRefunds, shifts: d.shifts?.length ?? 0, difference: (d.shifts ?? []).reduce((a: number, s: any) => a + (s.difference ?? 0), 0) };
    }), total, q);
  }

  async get(p: Principal, id: string) {
    const z = await this.prisma.zReport.findUnique({ where: { id } });
    if (!z) throw new NotFoundException('Z report not found');
    assertStoreAccess(p, z.storeId);
    return this.view(z);
  }
}

/** Expected and counted drawer of a shift, in both currencies. */
function drawerOf(shift: { openingCash: Prisma.Decimal; openingKhr: number; closingCash: Prisma.Decimal | null; closingKhr: number | null }, sum: Awaited<ReturnType<ShiftsService['summarize']>>) {
  const expected = Math.round(Number(sum.expectedCash) * 100) / 100;
  const counted = shift.closingCash === null ? null : Number(shift.closingCash);
  return {
    openingCash: Number(shift.openingCash), cashSales: Number(sum.cashUsdSales), changeGiven: Number(sum.changeUsd), cashRefunds: Number(sum.cashRefunds),
    walletTopups: Number(sum.walletTopups.CASH ?? 0), voucherSales: Number(sum.voucherSales.CASH ?? 0),
    cashIn: Number(sum.cashIn.usd), cashOut: Number(sum.cashOut.usd), expected, counted,
    difference: counted === null ? null : Math.round((counted - expected) * 100) / 100,
    khr: { ...sum.khr, counted: shift.closingKhr, difference: shift.closingKhr === null ? null : shift.closingKhr - sum.khr.expected },
  };
}

@ApiTags('Cash drawer, X and Z reports')
@ApiBearerAuth()
@Controller()
export class RegistersController {
  constructor(private readonly registers: RegistersService) {}

  /** Cash in / out of the drawer (cashier pay-outs need a manager PIN when the store says so). */
  @Post('shifts/:id/cash')
  moveCash(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CashMoveDto) {
    return this.registers.moveCash(p, id, dto);
  }

  @Get('shifts/:id/cash')
  listCash(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.registers.listCash(p, id);
  }

  /** X report: the shift so far (any time; changes nothing). */
  @Get('shifts/:id/x-report')
  x(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.registers.xReport(p, id);
  }

  @Roles(Role.STORE_MANAGER)
  @Get('z-reports')
  list(@CurrentPrincipal() p: Principal, @Query() q: ZQueryDto) {
    return this.registers.list(p, q);
  }

  @Roles(Role.STORE_MANAGER)
  @Get('z-reports/preview')
  preview(@CurrentPrincipal() p: Principal, @Query('storeId', ParseUUIDPipe) storeId: string, @Query('date') date?: string) {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('date must be YYYY-MM-DD');
    return this.registers.preview(p, storeId, date || undefined);
  }

  @Roles(Role.STORE_MANAGER)
  @Post('z-reports')
  run(@CurrentPrincipal() p: Principal, @Body() dto: ZRunDto) {
    return this.registers.run(p, dto);
  }

  @Roles(Role.STORE_MANAGER)
  @Get('z-reports/:id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.registers.get(p, id);
  }
}

@Module({ imports: [ShiftsModule], controllers: [RegistersController], providers: [RegistersService, RegisterReportService] })
export class RegistersModule {}
