// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { AuditService } from '../audit/audit.module';
import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sniffImage, SLIDE_TYPES } from '../display/display.module';
import { PrismaService } from '../prisma/prisma.service';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentPrincipal, Public, Roles, Scopes } from '../common/decorators';
import { Principal } from '../common/principal';
import { BulkUpsertProductsDto, CreateProductDto, ProductQueryDto, SetSizePricesDto, UpdateProductDto } from './products.dto';
import { ProductsService } from './products.service';

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

@ApiTags('Products')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Upload the product's photo: the picture itself as the body (JPG, PNG or WebP, at most 2 MB; the portal sends it
   * resized to 800 px). Kept on this server; the product's imageUrl then points to it.
   */
  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Post(':id/image')
  @HttpCode(200)
  async uploadImage(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Headers('content-type') contentType?: string) {
    if (!Buffer.isBuffer(body) || !body.length) throw new BadRequestException('Send the picture itself as the body: a JPG, PNG or WebP file');
    if (body.length > MAX_PHOTO_BYTES) throw new BadRequestException('The photo is larger than 2 MB');
    const kind = sniffImage(body);
    if (!kind) throw new BadRequestException('This file is not a JPG, PNG or WebP picture');
    if (contentType && !SLIDE_TYPES.includes(contentType.split(';')[0].trim())) throw new BadRequestException('Use a JPG, PNG or WebP picture');
    const product = await this.prisma.product.findUnique({ where: { id }, select: { name: true, sku: true } });
    if (!product) throw new NotFoundException('Product not found');
    const data = { mimeType: kind, image: new Uint8Array(body), sizeBytes: body.length };
    await this.prisma.productPhoto.upsert({ where: { productId: id }, create: { productId: id, ...data }, update: data });
    const imageUrl = `/api/v1/products/${id}/image?v=${Date.now()}`;
    await this.prisma.product.update({ where: { id }, data: { imageUrl } }); // also marks it changed, so tills fetch it
    this.audit.add(p, { action: 'PRODUCT_PHOTO_CHANGED', entityType: 'product', entityId: product.sku, summary: `${product.name}: new photo (${Math.round(body.length / 1024)} KB)` });
    return { imageUrl };
  }

  /** Remove the uploaded photo. */
  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Delete(':id/image')
  @HttpCode(204)
  async removeImage(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const product = await this.prisma.product.findUnique({ where: { id }, select: { name: true, sku: true, imageUrl: true } });
    if (!product) throw new NotFoundException('Product not found');
    await this.prisma.productPhoto.deleteMany({ where: { productId: id } });
    if (product.imageUrl?.startsWith(`/api/v1/products/${id}/image`)) await this.prisma.product.update({ where: { id }, data: { imageUrl: null } });
    this.audit.add(p, { action: 'PRODUCT_PHOTO_REMOVED', entityType: 'product', entityId: product.sku, summary: `${product.name}: photo removed` });
  }

  /** The photo itself. Public, so POS tiles and the online menu show it with a plain <img>; ?v= changes with each upload. */
  @Public()
  @Get(':id/image')
  async image(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const row = await this.prisma.productPhoto.findUnique({ where: { productId: id }, select: { image: true, mimeType: true } });
    if (!row) throw new NotFoundException('No photo');
    res.setHeader('Content-Type', row.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(row.image));
  }

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

  /** Full price of each size (S / M / L) in each store */
  @Scopes('products:read')
  @Get(':id/size-prices')
  sizePrices(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.sizePrices(id);
  }

  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Put(':id/size-prices')
  async setSizePrices(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetSizePricesDto) {
    const out = await this.products.setSizePrices(id, dto);
    const product = await this.products.get(p, id).catch(() => null);
    this.audit.add(p, { action: 'PRODUCT_SIZE_PRICES_CHANGED', entityType: 'product', entityId: product?.sku ?? id,
      summary: `${product?.name ?? 'Product'}: size prices changed in ${dto.stores.length} store(s)` });
    return out;
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
