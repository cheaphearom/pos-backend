// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags, PartialType } from '@nestjs/swagger';
import { Prisma, PromotionType, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { REPORT_TIMEZONE } from '../config';
import { CurrentPrincipal, Permission, Roles, Scopes } from '../common/decorators';
import { PageQueryDto, pageArgs, toPage } from '../common/pagination';
import { assertStoreAccess, Principal } from '../common/principal';
import { AuditService } from '../audit/audit.module';
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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

  async create(dto: CreatePromotionDto, by?: Principal) {
    this.validate(dto);
    const p = await this.prisma.promotion.create({ data: dto });
    this.cache.clear();
    if (by) {
      this.audit.add(by, {
        action: 'PROMOTION_CREATED', entityType: 'promotion', entityId: p.id, storeId: p.storeIds.length === 1 ? p.storeIds[0] : undefined,
        summary: `New promotion "${p.name}": ${p.type} ${Number(p.value)}${p.isActive ? '' : ' (off)'}`, details: promoSnapshot(p),
      });
    }
    return p;
  }

  async update(id: string, dto: UpdatePromotionDto, by?: Principal) {
    const existing = await this.get(id);
    this.validate({ ...toRule(existing), ...dto, value: dto.value ?? Number(existing.value) } as CreatePromotionDto);
    const p = await this.prisma.promotion.update({ where: { id }, data: dto });
    this.cache.clear();
    if (by) {
      const before = promoSnapshot(existing);
      const after = promoSnapshot(p);
      const changes = (Object.keys(after) as (keyof typeof after)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      if (changes.length) {
        const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : Array.isArray(v) ? `${v.length} chosen` : String(v));
        this.audit.add(by, {
          action: 'PROMOTION_CHANGED', entityType: 'promotion', entityId: p.id, storeId: p.storeIds.length === 1 ? p.storeIds[0] : undefined,
          summary: `Promotion "${p.name}": ${changes.map((k) => `${k} ${show(before[k])} → ${show(after[k])}`).join(', ')}`,
          details: { changes: Object.fromEntries(changes.map((k) => [k, { from: before[k], to: after[k] }])) },
        });
      }
    }
    return p;
  }

  async remove(id: string, by?: Principal) {
    const existing = await this.prisma.promotion.findUnique({ where: { id } });
    await this.prisma.promotion.delete({ where: { id } });
    this.cache.clear();
    if (by && existing) {
      this.audit.add(by, {
        action: 'PROMOTION_DELETED', entityType: 'promotion', entityId: id, storeId: existing.storeIds.length === 1 ? existing.storeIds[0] : undefined,
        summary: `Promotion "${existing.name}" deleted`, details: promoSnapshot(existing),
      });
    }
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
    // a promotion on a category also covers the categories under it (a BROWN group such as Beverages > Hot Coffee)
    if (rules.some((r) => r.categoryIds.length)) {
      const cats = await this.prisma.category.findMany({ select: { id: true, parentId: true } });
      const kids = new Map<string, string[]>();
      for (const c of cats) if (c.parentId) kids.set(c.parentId, [...(kids.get(c.parentId) ?? []), c.id]);
      for (const r of rules) {
        const all = new Set(r.categoryIds);
        const todo = [...r.categoryIds];
        while (todo.length) for (const k of kids.get(todo.pop()!) ?? []) if (!all.has(k)) { all.add(k); todo.push(k); }
        r.categoryIds = [...all];
      }
    }
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

  @Roles(Role.SUPER_ADMIN) @Permission('marketing')
  @Scopes('products:write')
  @Post()
  create(@CurrentPrincipal() p: Principal, @Body() dto: CreatePromotionDto) {
    return this.promotions.create(dto, p);
  }

  @Roles(Role.SUPER_ADMIN) @Permission('marketing')
  @Scopes('products:write')
  @Patch(':id')
  update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePromotionDto) {
    return this.promotions.update(id, dto, p);
  }

  @Roles(Role.SUPER_ADMIN) @Permission('marketing')
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.promotions.remove(id, p);
  }
}

/** The fields shown in the audit log (values as plain JSON). */
function promoSnapshot(p: Prisma.PromotionGetPayload<object>) {
  const r = p as unknown as Record<string, unknown>;
  const plain = (v: unknown) => (v instanceof Date ? v.toISOString() : v !== null && typeof v === 'object' && 'toFixed' in (v as object) ? Number(v) : v);
  const keys = ['name', 'description', 'type', 'value', 'buyQty', 'getQty', 'isActive', 'allProducts', 'productIds', 'categoryIds', 'storeIds', 'startsAt', 'endsAt', 'daysOfWeek', 'startMinute', 'endMinute', 'priority'];
  return Object.fromEntries(keys.filter((k) => k in r).map((k) => [k, plain(r[k])]));
}

@Module({ controllers: [PromotionsController], providers: [PromotionsService], exports: [PromotionsService] })
export class PromotionsModule {}
