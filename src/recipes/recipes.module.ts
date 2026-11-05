import { BadRequestException, Body, Controller, Get, Global, Injectable, Module, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Prisma, RecipeEffectType, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsNumber, IsOptional, IsUUID, Min, ValidateNested } from 'class-validator';
import { Roles, Scopes } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { ingredientUsage, RecipeEffect, usageCost } from './calc';

export class RecipeItemDto {
  @IsUUID()
  ingredientId: string;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001)
  quantity: number;
}

export class SaveRecipeDto {
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => RecipeItemDto)
  items: RecipeItemDto[];
}

export class EffectDto {
  @IsEnum(RecipeEffectType)
  type: RecipeEffectType;

  @IsOptional() @IsUUID()
  ingredientId?: string;

  @IsOptional() @IsUUID()
  replaceWithId?: string;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 })
  quantity?: number;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(-100)
  percent?: number;
}

export class SaveEffectsDto {
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => EffectDto)
  effects: EffectDto[];
}

export interface LineUsage {
  /** ingredientId → quantity for ONE unit of the product */
  perUnit: Map<string, number>;
  /** Cost of one unit from the recipe, or null if the product has no recipe */
  unitCost: number | null;
}

const toEffect = (e: Prisma.ModifierEffectGetPayload<object>): RecipeEffect => ({
  type: e.type, ingredientId: e.ingredientId, replaceWithId: e.replaceWithId,
  quantity: e.quantity === null ? null : Number(e.quantity), percent: e.percent === null ? null : Number(e.percent),
});

@Injectable()
export class RecipesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Ingredient usage and recipe cost for sale lines (product + chosen option ids). */
  async usageForLines(lines: { productId: string; optionIds: string[] }[]): Promise<LineUsage[]> {
    const productIds = [...new Set(lines.map((l) => l.productId))];
    const optionIds = [...new Set(lines.flatMap((l) => l.optionIds))];
    const [recipes, effects] = await Promise.all([
      this.prisma.recipeItem.findMany({ where: { productId: { in: productIds } } }),
      optionIds.length ? this.prisma.modifierEffect.findMany({ where: { optionId: { in: optionIds } } }) : [],
    ]);
    if (!recipes.length && !effects.length) return lines.map(() => ({ perUnit: new Map(), unitCost: null }));
    const ingIds = new Set<string>();
    recipes.forEach((r) => ingIds.add(r.ingredientId));
    effects.forEach((e) => { if (e.ingredientId) ingIds.add(e.ingredientId); if (e.replaceWithId) ingIds.add(e.replaceWithId); });
    const ings = await this.prisma.product.findMany({ where: { id: { in: [...ingIds] } }, select: { id: true, unit: true, costPrice: true } });
    const info = new Map(ings.map((i) => [i.id, i]));
    return lines.map((l) => {
      const base = recipes.filter((r) => r.productId === l.productId).map((r) => ({ ingredientId: r.ingredientId, quantity: Number(r.quantity) }));
      const eff = effects.filter((e) => l.optionIds.includes(e.optionId)).map(toEffect);
      if (!base.length && !eff.length) return { perUnit: new Map(), unitCost: null };
      const perUnit = ingredientUsage(base, eff, (id) => info.get(id)?.unit);
      return { perUnit, unitCost: base.length ? usageCost(perUnit, (id) => Number(info.get(id)?.costPrice ?? 0)) : null };
    });
  }

  /** Sellable products with their recipe cost (default options) and margin. */
  async list() {
    const products = await this.prisma.product.findMany({
      where: { isActive: true, isIngredient: false, OR: [{ recipe: { some: {} } }, { modifierGroups: { some: {} } }, { trackStock: false }] },
      select: {
        id: true, sku: true, name: true, sellPrice: true, costPrice: true, unit: true,
        _count: { select: { recipe: true } },
        modifierGroups: { select: { group: { select: { options: { where: { isActive: true, isDefault: true }, select: { id: true } } } } } },
      },
      orderBy: { name: 'asc' },
    });
    const usage = await this.usageForLines(products.map((p) => ({ productId: p.id, optionIds: p.modifierGroups.flatMap((g) => g.group.options.map((o) => o.id)) })));
    return products.map((p, i) => {
      const cost = usage[i].unitCost;
      const price = Number(p.sellPrice);
      return {
        id: p.id, sku: p.sku, name: p.name, price, unit: p.unit, ingredients: p._count.recipe,
        recipeCost: cost === null ? null : Math.round(cost * 10000) / 10000,
        marginPercent: cost === null || !price ? null : Math.round(((price - cost) / price) * 1000) / 10,
      };
    });
  }

  async get(productId: string) {
    const product = await this.prisma.product.findUniqueOrThrow({
      where: { id: productId },
      select: {
        id: true, sku: true, name: true, sellPrice: true, unit: true,
        recipe: { include: { ingredient: { select: { id: true, sku: true, name: true, unit: true, costPrice: true } } }, orderBy: { ingredient: { name: 'asc' } } },
        modifierGroups: {
          orderBy: { sortOrder: 'asc' },
          select: { group: { select: { id: true, name: true, options: { where: { isActive: true }, orderBy: { sortOrder: 'asc' }, include: { effects: true } } } } },
        },
      },
    });
    return { ...product, groups: product.modifierGroups.map((g) => g.group), modifierGroups: undefined };
  }

  async saveRecipe(productId: string, items: RecipeItemDto[]) {
    const ids = items.map((i) => i.ingredientId);
    if (ids.includes(productId)) throw new BadRequestException('A product cannot be its own ingredient');
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Each ingredient only once');
    const found = await this.prisma.product.count({ where: { id: { in: ids }, isIngredient: true } });
    if (found !== ids.length) throw new BadRequestException('Recipe items must be products marked as ingredients');
    await this.prisma.$transaction([
      this.prisma.recipeItem.deleteMany({ where: { productId } }),
      this.prisma.recipeItem.createMany({ data: items.map((i) => ({ productId, ingredientId: i.ingredientId, quantity: i.quantity })) }),
    ]);
    return this.get(productId);
  }

  async saveEffects(optionId: string, effects: EffectDto[]) {
    for (const e of effects) {
      if (e.type === 'SCALE' && e.percent === undefined) throw new BadRequestException('Scale needs a percent');
      if (e.type === 'REPLACE' && (!e.ingredientId || !e.replaceWithId)) throw new BadRequestException('Replace needs both ingredients');
      if (e.type === 'ADD' && (!e.ingredientId || !e.quantity)) throw new BadRequestException('Add needs an ingredient and a quantity');
    }
    await this.prisma.$transaction([
      this.prisma.modifierEffect.deleteMany({ where: { optionId } }),
      this.prisma.modifierEffect.createMany({ data: effects.map((e) => ({ optionId, ...e })) }),
    ]);
    return this.prisma.modifierEffect.findMany({ where: { optionId } });
  }

  /** What one unit uses with the given options, and its cost. */
  async preview(productId: string, optionIds: string[]) {
    const [u] = await this.usageForLines([{ productId, optionIds }]);
    const ings = await this.prisma.product.findMany({ where: { id: { in: [...u.perUnit.keys()] } }, select: { id: true, name: true, unit: true, costPrice: true } });
    return {
      unitCost: u.unitCost,
      usage: [...u.perUnit].map(([id, quantity]) => {
        const i = ings.find((x) => x.id === id)!;
        return { ingredientId: id, name: i?.name, unit: i?.unit, quantity, cost: Math.round(quantity * Number(i?.costPrice ?? 0) * 10000) / 10000 };
      }),
    };
  }
}

@ApiTags('Recipes')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Roles(Role.STORE_MANAGER)
@Controller('recipes')
export class RecipesController {
  constructor(private readonly recipes: RecipesService) {}

  /** Drinks / dishes with recipe cost and margin. */
  @Scopes('products:read')
  @Get()
  list() {
    return this.recipes.list();
  }

  @Scopes('products:read')
  @Get(':productId')
  get(@Param('productId', ParseUUIDPipe) id: string) {
    return this.recipes.get(id);
  }

  /** Ingredient use and cost for one unit with options: ?options=id,id */
  @Scopes('products:read')
  @Get(':productId/preview')
  preview(@Param('productId', ParseUUIDPipe) id: string, @Query('options') options?: string) {
    return this.recipes.preview(id, (options ?? '').split(',').filter(Boolean));
  }

  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Put(':productId')
  save(@Param('productId', ParseUUIDPipe) id: string, @Body() dto: SaveRecipeDto) {
    return this.recipes.saveRecipe(id, dto.items);
  }

  /** How a drink option changes recipes (applies to every drink with that option). */
  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Put('options/:optionId/effects')
  effects(@Param('optionId', ParseUUIDPipe) id: string, @Body() dto: SaveEffectsDto) {
    return this.recipes.saveEffects(id, dto.effects);
  }
}

@Global()
@Module({ controllers: [RecipesController], providers: [RecipesService], exports: [RecipesService] })
export class RecipesModule {}
