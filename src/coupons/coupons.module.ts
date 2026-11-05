import { BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CouponType, Prisma, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { Roles, Scopes } from '../common/decorators';
import { PageQueryDto, pageArgs, toPage } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { randomCode } from '../wallet/card-number';
import { couponDiscount } from './calc';

export class CreateCampaignDto {
  @IsString() @MaxLength(100)
  name: string;

  @IsEnum(CouponType)
  type: CouponType;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01)
  value: number;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  minSpend?: number;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01)
  maxDiscount?: number;

  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true })
  storeIds?: string[];

  @IsOptional() @IsDateString()
  startsAt?: string;

  @IsOptional() @IsDateString()
  endsAt?: string;

  /** Total uses allowed for the whole campaign */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  usageLimit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  perCustomerLimit?: number;

  /** Only loyalty members can use it */
  @IsOptional() @IsBoolean()
  membersOnly?: boolean;

  /** One code everybody types, e.g. SAVE10 */
  @IsOptional() @Matches(/^[A-Z0-9-]{3,40}$/i, { message: 'Code: 3-40 letters, digits or dashes' })
  sharedCode?: string;

  /** Or generate this many single-use codes */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000)
  uniqueCount?: number;

  /** Start of generated codes, e.g. NOV */
  @IsOptional() @Matches(/^[A-Z0-9]{0,10}$/i)
  prefix?: string;
}

export class UpdateCampaignDto {
  @IsOptional() @IsString() @MaxLength(100)
  name?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  @IsOptional() @IsDateString()
  endsAt?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  usageLimit?: number;
}

export class MoreCodesDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(10000)
  count: number;

  @IsOptional() @Matches(/^[A-Z0-9]{0,10}$/i)
  prefix?: string;
}

export class CampaignQueryDto extends PageQueryDto {
  @IsOptional() @IsString()
  search?: string;
}

export class CodesQueryDto extends PageQueryDto {
  /** true = return every code (for CSV export) */
  @IsOptional() @IsString()
  all?: string;
}

type Campaign = Prisma.CouponCampaignGetPayload<object>;

export interface CouponCheck {
  code: Prisma.CouponCodeGetPayload<object>;
  campaign: Campaign;
}

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: PageQueryDto & { search?: string }) {
    const where: Prisma.CouponCampaignWhereInput = q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {};
    const [rows, total] = await Promise.all([
      this.prisma.couponCampaign.findMany({ where, orderBy: { createdAt: 'desc' }, include: { _count: { select: { codes: true } } }, ...pageArgs(q) }),
      this.prisma.couponCampaign.count({ where }),
    ]);
    const sums = await this.prisma.couponRedemption.groupBy({ by: ['campaignId'], where: { campaignId: { in: rows.map((r) => r.id) } }, _sum: { discount: true } });
    const given = new Map(sums.map((x) => [x.campaignId, x._sum.discount]));
    return toPage(rows.map((r) => ({ ...r, discountGiven: given.get(r.id) ?? 0 })), total, q);
  }

  async get(id: string) {
    const c = await this.prisma.couponCampaign.findUniqueOrThrow({ where: { id }, include: { _count: { select: { codes: true } } } });
    const agg = await this.prisma.couponRedemption.aggregate({ where: { campaignId: id }, _sum: { discount: true }, _count: true });
    return { ...c, discountGiven: agg._sum.discount ?? 0, redemptions: agg._count };
  }

  async codes(id: string, q: CodesQueryDto) {
    const where = { campaignId: id };
    if (q.all === 'true') return this.prisma.couponCode.findMany({ where, orderBy: { createdAt: 'asc' }, select: { code: true, maxUses: true, usedCount: true } });
    const [rows, total] = await Promise.all([
      this.prisma.couponCode.findMany({ where, orderBy: { createdAt: 'asc' }, ...pageArgs(q) }),
      this.prisma.couponCode.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  async create(dto: CreateCampaignDto) {
    if (!dto.sharedCode && !dto.uniqueCount) throw new BadRequestException('Give a shared code or a number of unique codes');
    if (dto.type === 'PERCENT' && dto.value > 100) throw new BadRequestException('Percent must be 100 or less');
    const { sharedCode, uniqueCount, prefix, ...data } = dto;
    const campaign = await this.prisma.couponCampaign.create({ data });
    if (sharedCode) {
      await this.prisma.couponCode.create({ data: { campaignId: campaign.id, code: sharedCode.toUpperCase(), maxUses: null } }).catch(async (e) => {
        await this.prisma.couponCampaign.delete({ where: { id: campaign.id } });
        throw e;
      });
    } else await this.addCodes(campaign.id, uniqueCount!, prefix);
    return this.get(campaign.id);
  }

  async addCodes(campaignId: string, count: number, prefix?: string) {
    const pre = prefix ? `${prefix.toUpperCase()}-` : '';
    const codes = new Set<string>();
    while (codes.size < count) codes.add(pre + randomCode(8));
    const res = await this.prisma.couponCode.createMany({ data: [...codes].map((code) => ({ campaignId, code, maxUses: 1 })), skipDuplicates: true });
    return { created: res.count };
  }

  update(id: string, dto: UpdateCampaignDto) {
    return this.prisma.couponCampaign.update({ where: { id }, data: dto });
  }

  /**
   * Check a code for a sale without using it. Throws with a clear reason.
   * `base` = sale value after line discounts and promotions, before tax.
   */
  async check(code: string, ctx: { storeId: string; customerId?: string | null; base?: number; at?: Date }): Promise<CouponCheck & { discount: number }> {
    const row = await this.prisma.couponCode.findUnique({ where: { code: code.trim().toUpperCase() }, include: { campaign: true } });
    if (!row) throw new NotFoundException('Coupon code not found');
    const { campaign, ...c } = row;
    const at = ctx.at ?? new Date();
    if (!campaign.isActive || !c.isActive) throw new BadRequestException('This coupon is not active');
    if (campaign.startsAt && at < campaign.startsAt) throw new BadRequestException('This coupon is not valid yet');
    if (campaign.endsAt && at >= campaign.endsAt) throw new BadRequestException('This coupon has expired');
    if (campaign.storeIds.length && !campaign.storeIds.includes(ctx.storeId)) throw new BadRequestException('This coupon cannot be used in this store');
    if (c.maxUses != null && c.usedCount >= c.maxUses) throw new BadRequestException('This coupon code has already been used');
    if (campaign.usageLimit != null && campaign.usedCount >= campaign.usageLimit) throw new BadRequestException('This coupon campaign is fully used');
    if (campaign.membersOnly && !ctx.customerId) throw new BadRequestException('This coupon is for members only: add the customer first');
    if (campaign.perCustomerLimit != null) {
      if (!ctx.customerId) throw new BadRequestException('Add the customer: this coupon is limited per customer');
      const used = await this.prisma.couponRedemption.count({ where: { campaignId: campaign.id, customerId: ctx.customerId } });
      if (used >= campaign.perCustomerLimit) throw new BadRequestException('This customer has already used this coupon');
    }
    let discount = 0;
    if (ctx.base !== undefined) {
      const r = couponDiscount({ ...campaign, value: campaign.value.toString(), minSpend: campaign.minSpend.toString(), maxDiscount: campaign.maxDiscount?.toString() }, ctx.base);
      if (r.error) throw new BadRequestException(r.error);
      discount = r.discount;
    }
    return { code: c, campaign, discount };
  }

  /**
   * Inside the sale transaction: count the use atomically. The UPDATEs lock the code and
   * campaign rows, so two tills cannot both use the last allowed use.
   */
  async redeem(tx: Prisma.TransactionClient, chk: CouponCheck, ctx: { saleId: string; storeId: string; customerId?: string | null; discount: number }) {
    const codeOk = await tx.$executeRaw`
      UPDATE coupon_codes SET used_count = used_count + 1 WHERE id = ${chk.code.id}::uuid AND (max_uses IS NULL OR used_count < max_uses)`;
    if (!codeOk) throw new BadRequestException('This coupon code has already been used');
    const campOk = await tx.$executeRaw`
      UPDATE coupon_campaigns SET used_count = used_count + 1 WHERE id = ${chk.campaign.id}::uuid AND (usage_limit IS NULL OR used_count < usage_limit)`;
    if (!campOk) throw new BadRequestException('This coupon campaign is fully used');
    if (chk.campaign.perCustomerLimit != null && ctx.customerId) {
      const used = await tx.couponRedemption.count({ where: { campaignId: chk.campaign.id, customerId: ctx.customerId } });
      if (used >= chk.campaign.perCustomerLimit) throw new BadRequestException('This customer has already used this coupon');
    }
    await tx.couponRedemption.create({
      data: { codeId: chk.code.id, campaignId: chk.campaign.id, saleId: ctx.saleId, customerId: ctx.customerId, storeId: ctx.storeId, discount: ctx.discount },
    });
  }
}

@ApiTags('Coupons')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('coupons')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Roles(Role.STORE_MANAGER)
  @Scopes('promotions:read')
  @Get()
  list(@Query() q: CampaignQueryDto) {
    return this.coupons.list(q);
  }

  /** Check a code for the POS (does not use it). */
  @Scopes('sales:write')
  @Get('check')
  async check(@Query('code') code: string, @Query('storeId', ParseUUIDPipe) storeId: string, @Query('customerId') customerId?: string) {
    const r = await this.coupons.check(code ?? '', { storeId, customerId: customerId || null });
    const c = r.campaign;
    return { code: r.code.code, name: c.name, type: c.type, value: c.value, minSpend: c.minSpend, maxDiscount: c.maxDiscount, membersOnly: c.membersOnly };
  }

  @Roles(Role.STORE_MANAGER)
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.coupons.get(id);
  }

  /** Codes of a campaign. ?all=true returns every code (for CSV export). */
  @Roles(Role.STORE_MANAGER)
  @Get(':id/codes')
  codes(@Param('id', ParseUUIDPipe) id: string, @Query() q: CodesQueryDto) {
    return this.coupons.codes(id, q);
  }

  @Roles(Role.SUPER_ADMIN)
  @Scopes('promotions:write')
  @Post()
  create(@Body() dto: CreateCampaignDto) {
    return this.coupons.create(dto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Post(':id/codes')
  more(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MoreCodesDto) {
    return this.coupons.addCodes(id, dto.count, dto.prefix);
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCampaignDto) {
    return this.coupons.update(id, dto);
  }
}

@Module({ controllers: [CouponsController], providers: [CouponsService], exports: [CouponsService] })
export class CouponsModule {}
