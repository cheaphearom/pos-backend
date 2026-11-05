import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Prisma, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Roles, Scopes } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

export class OptionDto {
  /** Keep the id when editing an existing option */
  @IsOptional() @IsUUID()
  id?: string;

  @IsString() @MaxLength(60)
  name: string;

  /** Added to the item price, e.g. 0.50 for oat milk; can be negative */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(-1000)
  priceDelta: number;

  @IsOptional() @IsBoolean()
  isDefault?: boolean;
}

export class SaveGroupDto {
  @IsString() @MaxLength(60)
  name: string;

  /** 0 = optional, 1 or more = the customer must choose */
  @Type(() => Number) @IsInt() @Min(0) @Max(20)
  minSelect: number;

  /** 1 = choose one (size), more = several (toppings) */
  @Type(() => Number) @IsInt() @Min(1) @Max(20)
  maxSelect: number;

  @IsOptional() @Type(() => Number) @IsInt()
  sortOrder?: number;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => OptionDto)
  options: OptionDto[];
}

const groupInclude = {
  options: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
  _count: { select: { products: true } },
} satisfies Prisma.ModifierGroupInclude;

@Injectable()
export class ModifiersService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.modifierGroup.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: groupInclude });
  }

  async save(id: string | null, dto: SaveGroupDto) {
    if (dto.minSelect > dto.maxSelect) throw new BadRequestException('Minimum cannot be more than maximum');
    if (dto.minSelect > dto.options.length) throw new BadRequestException('Not enough options for the minimum');
    const { options, ...group } = dto;
    return this.prisma.$transaction(async (tx) => {
      const g = id ? await tx.modifierGroup.update({ where: { id }, data: group }) : await tx.modifierGroup.create({ data: group });
      // Options removed from the list are hidden (not deleted) so old receipts keep their names.
      const keep = options.filter((o) => o.id).map((o) => o.id!);
      await tx.modifierOption.updateMany({ where: { groupId: g.id, id: { notIn: keep } }, data: { isActive: false } });
      for (const [i, o] of options.entries()) {
        const data = { name: o.name, priceDelta: o.priceDelta, isDefault: !!o.isDefault, sortOrder: i, isActive: true };
        if (o.id) await tx.modifierOption.update({ where: { id: o.id, groupId: g.id }, data });
        else await tx.modifierOption.create({ data: { ...data, groupId: g.id } });
      }
      return tx.modifierGroup.findUniqueOrThrow({ where: { id: g.id }, include: groupInclude });
    });
  }

  async remove(id: string) {
    await this.prisma.modifierGroup.update({ where: { id }, data: { isActive: false } });
    await this.prisma.productModifierGroup.deleteMany({ where: { groupId: id } });
  }
}

@ApiTags('Drink options (modifiers)')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('modifiers')
export class ModifiersController {
  constructor(private readonly modifiers: ModifiersService) {}

  /** All option groups (Size, Sugar, Ice, Milk...) with their options. */
  @Scopes('products:read')
  @Get()
  list() {
    return this.modifiers.list();
  }

  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Post()
  create(@Body() dto: SaveGroupDto) {
    return this.modifiers.save(null, dto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveGroupDto) {
    return this.modifiers.save(id, dto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.modifiers.remove(id);
  }
}

@Module({ controllers: [ModifiersController], providers: [ModifiersService] })
export class ModifiersModule {}
