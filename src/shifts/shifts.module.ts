import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { CurrentPrincipal } from '../common/decorators';
import { DateRangeQueryDto, dateFilter } from '../common/date-range';
import { pageArgs, toPage } from '../common/pagination';
import { assertStoreAccess, Principal, storeScope } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';

export class OpenShiftDto {
  @IsUUID()
  storeId: string;

  /** Cash in the drawer at the start */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  openingCash: number;

  /** Riel in the drawer at the start (dual currency stores) */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  openingKhr?: number;
}

export class CloseShiftDto {
  /** Cash counted in the drawer at the end */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  closingCash: number;

  /** Riel counted at the end (dual currency stores) */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  closingKhr?: number;

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

export class ShiftQueryDto extends DateRangeQueryDto {
  @IsOptional() @IsIn(['OPEN', 'CLOSED'])
  status?: 'OPEN' | 'CLOSED';

  @IsOptional() @IsUUID()
  userId?: string;
}

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

@Injectable()
export class ShiftsService {
  constructor(private readonly prisma: PrismaService) {}

  async open(p: Principal, dto: OpenShiftDto) {
    assertStoreAccess(p, dto.storeId);
    const existing = await this.prisma.shift.findFirst({ where: { userId: p.id, storeId: dto.storeId, status: 'OPEN' } });
    if (existing) throw new BadRequestException('You already have an open shift in this store');
    return this.prisma.shift.create({ data: { storeId: dto.storeId, userId: p.id, openingCash: dto.openingCash, openingKhr: dto.openingKhr ?? 0 } });
  }

  /** The caller's open shift in a store, or null. */
  current(p: Principal, storeId: string) {
    assertStoreAccess(p, storeId);
    return this.prisma.shift.findFirst({ where: { userId: p.id, storeId, status: 'OPEN' } });
  }

  async close(p: Principal, id: string, dto: CloseShiftDto) {
    const shift = await this.prisma.shift.findUniqueOrThrow({ where: { id } });
    this.assertOwnerOrManager(p, shift);
    if (shift.status === 'CLOSED') throw new BadRequestException('Shift is already closed');
    const summary = await this.summarize(shift);
    return this.prisma.shift.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closingCash: dto.closingCash,
        expectedCash: summary.expectedCash,
        closingKhr: dto.closingKhr ?? null,
        expectedKhr: summary.khr.expected,
        note: dto.note,
      },
    }).then((s) => ({
      ...s, summary, difference: D(dto.closingCash).minus(summary.expectedCash),
      differenceKhr: dto.closingKhr === undefined ? null : dto.closingKhr - summary.khr.expected,
    }));
  }

  async get(p: Principal, id: string) {
    const shift = await this.prisma.shift.findUniqueOrThrow({
      where: { id },
      include: { user: { select: { fullName: true } }, store: { select: { code: true, name: true } } },
    });
    this.assertOwnerOrManager(p, shift);
    return { ...shift, summary: await this.summarize(shift) };
  }

  async list(p: Principal, q: ShiftQueryDto) {
    const where: Prisma.ShiftWhereInput = {
      ...storeScope(p, q.storeId),
      status: q.status,
      userId: p.role === Role.CASHIER ? p.id : q.userId,
      openedAt: dateFilter(q.from, q.to),
    };
    const [rows, total] = await Promise.all([
      this.prisma.shift.findMany({
        where,
        orderBy: { openedAt: 'desc' },
        include: { user: { select: { fullName: true } }, store: { select: { code: true } } },
        ...pageArgs(q),
      }),
      this.prisma.shift.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  /** Totals for the cash-drawer report. */
  private async summarize(shift: { id: string; storeId: string; userId: string; openingCash: Prisma.Decimal; openingKhr: number; openedAt: Date; closedAt: Date | null }) {
    const [sales, payments, cashRefunds, topups, voucherSales, khrCash] = await Promise.all([
      this.prisma.sale.aggregate({
        where: { shiftId: shift.id },
        _count: true,
        _sum: { total: true, discountTotal: true, taxTotal: true, changeDue: true, changeUsd: true, changeKhr: true },
      }),
      this.prisma.payment.groupBy({ by: ['method'], where: { sale: { shiftId: shift.id } }, _sum: { amount: true } }),
      this.prisma.refund.aggregate({
        where: {
          userId: shift.userId,
          method: 'CASH',
          sale: { storeId: shift.storeId },
          createdAt: { gte: shift.openedAt, ...(shift.closedAt && { lte: shift.closedAt }) },
        },
        _sum: { amount: true },
      }),
      this.prisma.walletTransaction.groupBy({ by: ['method'], where: { shiftId: shift.id, type: 'TOPUP' }, _sum: { amount: true }, _count: true }),
      this.prisma.voucher.groupBy({ by: ['soldMethod'], where: { soldShiftId: shift.id }, _sum: { value: true }, _count: true }),
      this.prisma.payment.aggregate({ where: { sale: { shiftId: shift.id }, method: 'CASH', currency: 'KHR' }, _sum: { amount: true, tendered: true }, _count: true }),
    ]);
    const cashVouchers = voucherSales.find((x) => x.soldMethod === 'CASH')?._sum.value ?? D(0);
    const cashTopups = topups.find((x) => x.method === 'CASH')?._sum.amount ?? D(0);
    const byMethod = Object.fromEntries(payments.map((x) => [x.method, x._sum.amount ?? D(0)]));
    // Two drawers: dollars and riel. Riel cash is counted in riel; its dollar value is not in the dollar drawer.
    const khrUsdValue = khrCash._sum.amount ?? D(0);
    const cashIn = (byMethod.CASH ?? D(0)).minus(khrUsdValue);
    const change = sales._sum.changeUsd ?? D(0);
    const khrIn = Number(khrCash._sum.tendered ?? 0);
    const khrChange = sales._sum.changeKhr ?? 0;
    const refunds = cashRefunds._sum.amount ?? D(0);
    return {
      salesCount: sales._count,
      salesTotal: sales._sum.total ?? D(0),
      discountTotal: sales._sum.discountTotal ?? D(0),
      taxTotal: sales._sum.taxTotal ?? D(0),
      payments: byMethod,
      cashRefunds: refunds,
      walletTopups: Object.fromEntries(topups.map((x) => [x.method ?? 'OTHER', x._sum.amount ?? D(0)])),
      voucherSales: Object.fromEntries(voucherSales.map((x) => [x.soldMethod ?? 'OTHER', x._sum.value ?? D(0)])),
      expectedCash: shift.openingCash.plus(cashIn).minus(change).minus(refunds).plus(cashTopups).plus(cashVouchers),
      khr: { opening: shift.openingKhr, received: khrIn, change: khrChange, payments: khrCash._count, expected: shift.openingKhr + khrIn - khrChange },
    };
  }

  private assertOwnerOrManager(p: Principal, shift: { userId: string; storeId: string }) {
    assertStoreAccess(p, shift.storeId);
    if (p.role === Role.CASHIER && shift.userId !== p.id) throw new ForbiddenException('Not your shift');
  }
}

@ApiTags('Shifts')
@ApiBearerAuth()
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  /** Start a cashier shift with the opening cash amount. */
  @Post('open')
  open(@CurrentPrincipal() p: Principal, @Body() dto: OpenShiftDto) {
    return this.shifts.open(p, dto);
  }

  @Get('current')
  current(@CurrentPrincipal() p: Principal, @Query('storeId', ParseUUIDPipe) storeId: string) {
    return this.shifts.current(p, storeId);
  }

  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() q: ShiftQueryDto) {
    return this.shifts.list(p, q);
  }

  /** Shift details with the cash-drawer summary. */
  @Get(':id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.shifts.get(p, id);
  }

  /** End the shift with the counted cash. Returns expected cash and the difference. */
  @Post(':id/close')
  close(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseShiftDto) {
    return this.shifts.close(p, id, dto);
  }
}

@Module({ controllers: [ShiftsController], providers: [ShiftsService] })
export class ShiftsModule {}
