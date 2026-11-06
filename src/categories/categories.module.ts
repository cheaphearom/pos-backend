import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags, PartialType } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { Roles, Scopes } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

export class CreateCategoryDto {
  @IsString() @MaxLength(100)
  name: string;

  /** Khmer name */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(100)
  nameKm?: string | null;

  @IsOptional() @IsUUID()
  parentId?: string;
}

export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
  }

  create(dto: CreateCategoryDto) {
    return this.prisma.category.create({ data: dto });
  }

  update(id: string, dto: UpdateCategoryDto) {
    return this.prisma.category.update({ where: { id }, data: dto });
  }

  remove(id: string) {
    // Products in this category become uncategorised (onDelete: SetNull).
    return this.prisma.category.delete({ where: { id } });
  }
}

@ApiTags('Categories')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Scopes('products:read')
  @Get()
  list() {
    return this.categories.list();
  }

  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Post()
  create(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.categories.remove(id);
  }
}

@Module({ controllers: [CategoriesController], providers: [CategoriesService] })
export class CategoriesModule {}
