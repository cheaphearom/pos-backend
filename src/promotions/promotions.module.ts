import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags, PartialType } from '@nestjs/swagger';
import { Prisma, PromotionType, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { REPORT_TIMEZONE } from '../config';
import { CurrentPrincipal, Roles, Scopes } from '../common/decorators';
import { PageQueryDto, pageArgs, toPage } from '../common/pagination';
import { assertStoreAccess, Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';
import { PromoRule } from './engine';

export class CreatePromotionDto {
  /** Shown on receipts, e.g. "Happy hour drinks" */
  @IsString() @MaxLength(100)
  name: string;

  @IsOptional() @IsString()
  description?: string;

  @IsEnum(PromotionType)
  type: PromotionType;

  /** PERCENT_OFF: percent (e.g. 10). AMOUNT_OFF: amount off each unit. Not used for BUY_X_GET_Y. */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  value?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  buyQty?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  getQty?: number;

  /** Applies to every product */
  @IsOptional() @IsBoolean()
  allProducts?: boolean;

  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true })
  productIds?: string[];

  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true })
  categoryIds?: string[];

  /** Empty = all stores */
  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true })
  storeIds?: string[];

  @IsOptional() @IsDateString()
  startsAt?: string;

  @IsOptional() @IsDateString()
  endsAt?: string;

  /** 0 = Sunday … 6 = Saturday. Empty = every day */
  @IsOptional() @IsArray() @ArrayUnique() @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true })
  daysOfWeek?: number[];

  /** Happy hour: minutes after midnight in store time, e.g. 17:00 = 1020 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1440)
  startMinute?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1440)
  endMinute?: number;

  /** Higher wins when two promotions give the same saving */
  @IsOptional() @Type(() => Number) @IsInt()
  priority?: number;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class UpdatePromotionDto extends PartialType(CreatePromotionDto) {}

export class PromotionQueryDto extends PageQueryDto {
  @IsOptional() @IsString()
  search?: string;
}

/** Convert a DB row into the engine's plain shape. */
export function toRule(p: Prisma.PromotionGetPayload<object>): PromoRule {
  return {
    id: p.id, name: p.name, type: p.type, value: p.value.toString(), buyQty: p.buyQty, getQty: p.getQty,
    allProducts: p.allProducts, productIds: p.productIds ?? [], categoryIds: p.categoryIds ?? [], storeIds: p.storeIds ?? [],
    startsAt: p.startsAt, endsAt: p.endsAt, daysOfWeek: p.daysOfWeek ?? [], startMinute: p.startMinute, endMinute: p.endMinute,
    priority: p.priority, isActive: p.isActive,
  };
}

@Injectable()
export class PromotionsService {
  private cache = new Map<string, { at: number; rules: PromoRule[] }>();

  constructor(private readonly prisma: PrismaService) {}

  async list(q: PromotionQueryDto) {
    const where: Prisma.PromotionWhereInput = q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {};
    const [rows, total] = await Promise.all([
      this.prisma.promotion.findMany({ where, orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }], ...pageArgs(q) }),
      this.prisma.promotion.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  get(id: string) {
    return this.prisma.promotion.findUniqueOrThrow({ where: { id } });
  }

  async create(dto: CreatePromotionDto) {
    this.validate(dto);
    const p = await this.prisma.promotion.create({ data: dto });
    this.cache.clear();
    return p;
  }

  async update(id: string, dto: UpdatePromotionDto) {
    const existing = await this.get(id);
    this.validate({ ...toRule(existing), ...dto, value: dto.value ?? Number(existing.value) } as CreatePromotionDto);
    const p = await this.prisma.promotion.update({ where: { id }, data: dto });
    this.cache.clear();
    return p;
  }

  async remove(id: string) {
    await this.prisma.promotion.delete({ where: { id } });
    this.cache.clear();
  }

  /**
   * Promotions that may apply in a store (not expired, active). The exact time checks
   * (weekday, happy hour) are done by the engine at the moment of the sale.
   * Cached for 30 seconds because every checkout needs it.
   */
  async forStore(storeId: string): Promise<PromoRule[]> {
    const hit = this.cache.get(storeId);
    if (hit && Date.now() - hit.at < 30_000) return hit.rules;
    const rows = await this.prisma.promotion.findMany({
      where: {
        isActive: true,
        OR: [{ storeIds: { isEmpty: true } }, { storeIds: { has: storeId } }],
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: new Date(Date.now() - 8 * 86_400_000) } }] }], // keep a week for offline sales
      },
    });
    const rules = rows.map(toRule);
    this.cache.set(storeId, { at: Date.now(), rules });
    return rules;
  }

  private validate(dto: CreatePromotionDto) {
    if (dto.type === 'BUY_X_GET_Y' && (!dto.buyQty || !dto.getQty)) throw new BadRequestException('Buy X get Y needs buyQty and getQty');
    if (dto.type !== 'BUY_X_GET_Y' && !dto.value) throw new BadRequestException('Enter the discount value');
    if (dto.type === 'PERCENT_OFF' && (dto.value ?? 0) > 100) throw new BadRequestException('Percent must be 100 or less');
    if (!dto.allProducts && !dto.productIds?.length && !dto.categoryIds?.length) {
      throw new BadRequestException('Choose products, categories, or "all products"');
    }
    if (dto.startsAt && dto.endsAt && new Date(dto.endsAt) <= new Date(dto.startsAt)) throw new BadRequestException('End must be after start');
  }
}

@ApiTags('Promotions')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  /** For the POS: promotions that may apply in this store, with the time zone used for happy hours. */
  @Scopes('products:read')
  @Get('active')
  async active(@CurrentPrincipal() p: Principal, @Query('storeId', ParseUUIDPipe) storeId: string) {
    assertStoreAccess(p, storeId);
    return { timeZone: REPORT_TIMEZONE, serverTime: new Date().toISOString(), promotions: await this.promotions.forStore(storeId) };
  }

  @Roles(Role.STORE_MANAGER)
  @Scopes('products:read')
  @Get()
  list(@Query() q: PromotionQueryDto) {
    return this.promotions.list(q);
  }

  @Roles(Role.STORE_MANAGER)
  @Scopes('products:read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.promotions.get(id);
  }

  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Post()
  create(@Body() dto: CreatePromotionDto) {
    return this.promotions.create(dto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePromotionDto) {
    return this.promotions.update(id, dto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentPrincipal() _p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.promotions.remove(id);
  }
}

@Module({ controllers: [PromotionsController], providers: [PromotionsService], exports: [PromotionsService] })
export class PromotionsModule {}
