import { AuditService } from '../audit/audit.module';
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
  constructor(
    private readonly products: ProductsService,
    private readonly audit: AuditService,
  ) {}

  @Scopes('products:read')
  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() q: ProductQueryDto) {
    return this.products.list(p, q);
  }

  /** Every product with store price and stock, for offline POS. Use `since` for changes only. */
  @Scopes('products:read')
  @Get('catalog')
  catalog(@CurrentPrincipal() p: Principal, @Query('storeId', ParseUUIDPipe) storeId: string, @Query('since') since?: string) {
    return this.products.catalog(p, storeId, since);
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
  async update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    const before = await this.products.get(p, id).catch(() => null);
    const after = await this.products.update(id, dto);
    if (before) {
      const changes = (['sellPrice', 'costPrice', 'isActive', 'taxable'] as const)
        .filter((k) => dto[k] !== undefined && String((before as any)[k]) !== String((after as any)[k]))
        .map((k) => ({ field: k, from: String((before as any)[k]), to: String((after as any)[k]) }));
      if (changes.length) {
        this.audit.add(p, { action: 'PRODUCT_CHANGED', entityType: 'product', entityId: after.sku, details: changes,
          summary: `${after.name}: ${changes.map((c) => `${c.field} ${c.from} → ${c.to}`).join(', ')}` });
      }
    }
    return after;
  }
}
