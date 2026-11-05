import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentPrincipal, Roles, Scopes } from '../common/decorators';
import { Principal } from '../common/principal';
import { BulkUpsertProductsDto, CreateProductDto, ProductQueryDto, UpdateProductDto } from './products.dto';
import { ProductsService } from './products.service';

@ApiTags('Products')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Scopes('products:read')
  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() q: ProductQueryDto) {
    return this.products.list(p, q);
  }

  /** Find a product by barcode or SKU, with price and stock for the store. */
  @Scopes('products:read')
  @Get('lookup')
  lookup(@CurrentPrincipal() p: Principal, @Query('code') code: string, @Query('storeId', ParseUUIDPipe) storeId: string) {
    return this.products.lookup(p, code, storeId);
  }

  @Scopes('products:read')
  @Get(':id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Query('storeId') storeId?: string) {
    return this.products.get(p, id, storeId);
  }

  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Post()
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  /** Create or update up to 1000 products at once, matched by SKU. */
  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Post('bulk')
  bulk(@Body() dto: BulkUpsertProductsDto) {
    return this.products.bulkUpsert(dto.products);
  }

  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(id, dto);
  }
}
