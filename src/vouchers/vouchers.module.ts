import { BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { PaymentMethod, Prisma, Role, VoucherStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { CurrentPrincipal, Roles, Scopes } from '../common/decorators';
import { PageQueryDto, pageArgs, toPage } from '../common/pagination';
import { assertStoreAccess, Principal, userIdOf } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';
import { randomCode } from '../wallet/card-number';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

export class CreateBatchDto {
  @IsString() @MaxLength(100)
  name: string;

  /** Face value of each voucher */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01)
  value: number;

  @Type(() => Number) @IsInt() @Min(1) @Max(10000)
  count: number;

  /** true = customers buy them (activated when sold); false = free promotional vouchers, usable at once */
  @IsBoolean()
  sold: boolean;

  @IsOptional() @IsDateString()
  expiresAt?: string;
}

export class SellVoucherDto {
  @IsUUID()
  storeId: string;

  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @IsOptional() @IsString() @MaxLength(100)
  reference?: string;
}

export class VoucherQueryDto extends PageQueryDto {
  @IsOptional() @IsUUID()
  batchId?: string;

  @IsOptional() @IsEnum(VoucherStatus)
  status?: VoucherStatus;

  @IsOptional() @IsString()
  search?: string;
}

@Injectable()
export class VouchersService {
  constructor(private readonly prisma: PrismaService) {}

  async batches(q: PageQueryDto) {
    const [rows, total] = await Promise.all([
      this.prisma.voucherBatch.findMany({ orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.voucherBatch.count(),
    ]);
    const stats = await this.prisma.voucher.groupBy({ by: ['batchId', 'status'], where: { batchId: { in: rows.map((r) => r.id) } }, _count: true, _sum: { balance: true } });
    return toPage(
      rows.map((b) => {
        const mine = stats.filter((s) => s.batchId === b.id);
        return {
          ...b,
          counts: Object.fromEntries(mine.map((s) => [s.status, s._count])),
          outstanding: mine.filter((s) => s.status === 'ACTIVE').reduce((t, s) => t.plus(s._sum.balance ?? 0), D(0)),
        };
      }),
      total,
      q,
    );
  }

  async createBatch(dto: CreateBatchDto) {
    const batch = await this.prisma.voucherBatch.create({ data: { name: dto.name, value: dto.value, count: dto.count, sold: dto.sold, expiresAt: dto.expiresAt } });
    const codes = new Set<string>();
    while (codes.size < dto.count) codes.add('GV' + randomCode(10));
    await this.prisma.voucher.createMany({
      data: [...codes].map((code) => ({
        batchId: batch.id, code, value: dto.value, balance: dto.value, expiresAt: dto.expiresAt,
        status: dto.sold ? 'INACTIVE' : 'ACTIVE',
      })),
    });
    return { batch, codes: [...codes].map((code) => ({ code, value: dto.value, expiresAt: dto.expiresAt ?? '' })) };
  }

  async list(q: VoucherQueryDto) {
    const where: Prisma.VoucherWhereInput = { batchId: q.batchId, status: q.status, ...(q.search && { code: { contains: q.search.trim().toUpperCase() } }) };
    const [rows, total] = await Promise.all([
      this.prisma.voucher.findMany({ where, orderBy: { createdAt: 'asc' }, include: { batch: { select: { name: true, sold: true } } }, ...pageArgs(q) }),
      this.prisma.voucher.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  async lookup(code: string) {
    const v = await this.prisma.voucher.findUnique({
      where: { code: code.trim().toUpperCase() },
      include: { batch: { select: { name: true, sold: true } }, uses: { orderBy: { id: 'desc' }, take: 20 } },
    });
    if (!v) throw new NotFoundException('Voucher not found');
    return { ...v, expired: !!v.expiresAt && v.expiresAt < new Date() };
  }

  /** A customer buys a voucher: money comes in and the voucher becomes usable. */
  async sell(p: Principal, code: string, dto: SellVoucherDto) {
    assertStoreAccess(p, dto.storeId);
    if (dto.method === 'VOUCHER' || dto.method === 'WALLET') throw new BadRequestException('Pay for a voucher with cash, KHQR, card or transfer');
    const userId = userIdOf(p);
    const shift = userId ? await this.prisma.shift.findFirst({ where: { storeId: dto.storeId, userId, status: 'OPEN' }, select: { id: true } }) : null;
    const n = await this.prisma.voucher.updateMany({
      where: { code: code.trim().toUpperCase(), status: 'INACTIVE' },
      data: { status: 'ACTIVE', soldAt: new Date(), soldStoreId: dto.storeId, soldMethod: dto.method, soldShiftId: shift?.id, soldById: userId, note: dto.reference },
    });
    if (!n.count) {
      const v = await this.lookup(code);
      throw new BadRequestException(v.status === 'ACTIVE' ? 'This voucher is already active' : `Voucher is ${v.status}`);
    }
    return this.lookup(code);
  }

  async void(code: string, reason?: string) {
    const n = await this.prisma.voucher.updateMany({ where: { code: code.trim().toUpperCase(), status: { in: ['INACTIVE', 'ACTIVE'] } }, data: { status: 'VOID', note: reason ?? 'Voided' } });
    if (!n.count) throw new BadRequestException('Voucher not found or already used/void');
    return this.lookup(code);
  }

  /** Inside the sale transaction: spend from the voucher (atomic; no change is given on vouchers). */
  async spend(tx: Prisma.TransactionClient, code: string, amount: number, ctx: { saleId: string; storeId: string }) {
    const rows = await tx.$queryRaw<{ id: string; balance: Prisma.Decimal }[]>`
      UPDATE vouchers
         SET balance = balance - ${D(amount)}::numeric,
             status = CASE WHEN balance - ${D(amount)}::numeric = 0 THEN 'USED'::"VoucherStatus" ELSE status END,
             updated_at = now()
       WHERE code = ${code.trim().toUpperCase()} AND status = 'ACTIVE' AND balance >= ${D(amount)}::numeric
         AND (expires_at IS NULL OR expires_at > now())
       RETURNING id, balance`;
    if (!rows.length) {
      const v = await tx.voucher.findUnique({ where: { code: code.trim().toUpperCase() } });
      if (!v) throw new BadRequestException('Voucher not found');
      if (v.status === 'INACTIVE') throw new BadRequestException('This voucher was not sold yet');
      if (v.status !== 'ACTIVE') throw new BadRequestException(`Voucher is ${v.status.toLowerCase()}`);
      if (v.expiresAt && v.expiresAt <= new Date()) throw new BadRequestException('This voucher has expired');
      throw new BadRequestException(`Voucher balance is ${v.balance}, not enough for ${amount}`);
    }
    await tx.voucherUse.create({ data: { voucherId: rows[0].id, saleId: ctx.saleId, storeId: ctx.storeId, amount } });
  }

  /** Refund back to the voucher that paid. */
  async refund(tx: Prisma.TransactionClient, code: string, amount: Prisma.Decimal, ctx: { saleId: string; storeId: string }) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE vouchers SET balance = balance + ${amount}::numeric, status = 'ACTIVE'::"VoucherStatus", updated_at = now()
       WHERE code = ${code} AND status IN ('ACTIVE', 'USED') RETURNING id`;
    if (!rows.length) throw new BadRequestException('The voucher that paid is void; refund another way');
    await tx.voucherUse.create({ data: { voucherId: rows[0].id, saleId: ctx.saleId, storeId: ctx.storeId, amount: amount.neg() } });
  }
}

@ApiTags('Vouchers')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('vouchers')
export class VouchersController {
  constructor(private readonly vouchers: VouchersService) {}

  @Roles(Role.STORE_MANAGER)
  @Get('batches')
  batches(@Query() q: PageQueryDto) {
    return this.vouchers.batches(q);
  }

  /** Create vouchers; returns every code (for printing). */
  @Roles(Role.SUPER_ADMIN)
  @Scopes('promotions:write')
  @Post('batches')
  createBatch(@Body() dto: CreateBatchDto) {
    return this.vouchers.createBatch(dto);
  }

  @Roles(Role.STORE_MANAGER)
  @Get()
  list(@Query() q: VoucherQueryDto) {
    return this.vouchers.list(q);
  }

  @Scopes('sales:read')
  @Get('lookup')
  lookup(@Query('code') code: string) {
    return this.vouchers.lookup(code ?? '');
  }

  /** Sell a voucher at the till (activates it). */
  @Scopes('sales:write')
  @Post(':code/sell')
  sell(@CurrentPrincipal() p: Principal, @Param('code') code: string, @Body() dto: SellVoucherDto) {
    return this.vouchers.sell(p, code, dto);
  }

  @Roles(Role.STORE_MANAGER)
  @Post(':code/void')
  void(@Param('code') code: string, @Body('reason') reason?: string) {
    return this.vouchers.void(code, reason);
  }
}

@Module({ controllers: [VouchersController], providers: [VouchersService], exports: [VouchersService] })
export class VouchersModule {}
