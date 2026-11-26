// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { Audit, fieldsOf, safeBody } from '../audit/audited';
import { AuditService } from '../audit/audit.module';
import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sniffImage, SLIDE_TYPES } from '../display/display.module';
import { PrismaService } from '../prisma/prisma.service';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentPrincipal, Permission, Public, Roles, Scopes } from '../common/decorators';
import { Principal } from '../common/principal';
import { BulkPriceDto, BulkUpsertProductsDto, CreateProductDto, ProductQueryDto, SetSizePricesDto, UpdateProductDto } from './products.dto';
import { ProductsService } from './products.service';
import { priceChangeLabel, PriceScheduleService, SchedulePriceDto } from './price-schedule';
import { metaOf, PriceHistoryService } from '../prices/price-history.module';

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
    private readonly schedules: PriceScheduleService,
    private readonly history: PriceHistoryService,
  ) {}

  /**
   * Upload the product's photo: the picture itself as the body (JPG, PNG or WebP, at most 2 MB; the portal sends it
   * resized to 800 px). Kept on this server; the product's imageUrl then points to it.
   */
  @Roles(Role.SUPER_ADMIN) @Permission('products')
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
  @Roles(Role.SUPER_ADMIN) @Permission('products')
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

  @Roles(Role.SUPER_ADMIN) @Permission('products')
  @Scopes('products:write')
  @Put(':id/size-prices')
  async setSizePrices(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetSizePricesDto) {
    const out = await this.history.track([id], metaOf(p, 'SIZE_PRICES'), () => this.products.setSizePrices(id, dto));
    const product = await this.products.get(p, id).catch(() => null);
    this.audit.add(p, { action: 'PRODUCT_SIZE_PRICES_CHANGED', entityType: 'product', entityId: product?.sku ?? id,
      summary: `${product?.name ?? 'Product'}: size prices changed in ${dto.stores.length} store(s)` });
    return out;
  }

  /** Scheduled price changes: waiting, done, failed and cancelled (latest 100). */
  @Roles(Role.SUPER_ADMIN) @Permission('products')
  @Scopes('products:read')
  @Get('price-schedules')
  priceSchedules() {
    return this.schedules.list();
  }

  @Scopes('products:read')
  @Get(':id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Query('storeId') storeId?: string) {
    return this.products.get(p, id, storeId);
  }

  @Roles(Role.SUPER_ADMIN) @Permission('products')
  @Scopes('products:write')
  @Post()
  @Audit('PRODUCT_CREATED', ({ result: r, body }) => ({ entityType: 'product', entityId: r?.sku ?? body?.sku, summary: `Product ${r?.sku ?? body?.sku} ${r?.name ?? body?.name} created, price $${Number(r?.sellPrice ?? body?.sellPrice ?? 0).toFixed(2)}${(body?.stores ?? []).length ? `, sold in ${body.stores.length} store(s)` : ''}` }))
  async create(@CurrentPrincipal() p: Principal, @Body() dto: CreateProductDto) {
    const out = await this.products.create(dto);
    await this.history.record(new Map(), await this.history.snapshot([out.id]), metaOf(p, 'CREATE'), true);
    return out;
  }

  /** Bulk price change: what would change (nothing is saved). */
  @Roles(Role.SUPER_ADMIN) @Permission('products')
  @Scopes('products:write')
  @Post('bulk-price/preview')
  @HttpCode(200)
  bulkPricePreview(@Body() dto: BulkPriceDto) {
    return this.products.bulkPrice(dto, false);
  }

  /** Bulk price change: apply it (all products in one go) and record it in the audit log. */
  @Roles(Role.SUPER_ADMIN) @Permission('products')
  @Scopes('products:write')
  @Post('bulk-price')
  @HttpCode(200)
  async bulkPrice(@CurrentPrincipal() p: Principal, @Body() dto: BulkPriceDto) {
    const code = dto.scope === 'STORE' && dto.storeId ? (await this.prisma.store.findUnique({ where: { id: dto.storeId }, select: { code: true } }))?.code : undefined;
    const out = await this.products.bulkPrice(dto, true, metaOf(p, 'BULK', priceChangeLabel(dto, code)));
    const label = priceChangeLabel(dto, out.rows.find((r) => r.stores[0])?.stores[0]?.code);
    this.audit.add(p, {
      action: 'PRODUCT_PRICES_BULK', entityType: 'product', storeId: dto.scope === 'STORE' ? dto.storeId : undefined,
      summary: `Prices ${label}: ${out.changed} product(s)${out.skipped ? `, ${out.skipped} skipped` : ''}`,
      details: out.rows.filter((r) => !r.skipped).slice(0, 100).map((r) => ({
        sku: r.sku,
        normal: r.normal ? `${r.normal.before} -> ${r.normal.after}` : undefined,
        stores: r.stores
          .map((st) => (st.sizes
            ? `${st.code}: ${st.sizes.filter((z) => z.before !== null).map((z) => `${z.name} ${z.before}->${z.after}`).join(', ')}`
            : `${st.code}: ${st.before}->${st.after}`))
          .join(' | '),
      })),
    });
    return out;
  }

  /** Schedule a bulk price change for later (applied by the server at runAt). */
  @Roles(Role.SUPER_ADMIN) @Permission('products')
  @Scopes('products:write')
  @Post('bulk-price/schedule')
  schedulePrices(@CurrentPrincipal() p: Principal, @Body() dto: SchedulePriceDto) {
    return this.schedules.create(p, dto);
  }

  @Roles(Role.SUPER_ADMIN) @Permission('products')
  @Scopes('products:write')
  @Post('price-schedules/:id/cancel')
  @HttpCode(200)
  cancelPriceSchedule(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.schedules.cancel(p, id);
  }

  /** Create or update up to 1000 products at once, matched by SKU. */
  @Roles(Role.SUPER_ADMIN) @Permission('products')
  @Scopes('products:write')
  @Post('bulk')
  @Audit('PRODUCTS_IMPORTED', ({ body, result: r }) => ({ entityType: 'product', summary: `Products imported: ${(body?.products ?? []).length} row(s)${r?.created !== undefined ? ` (${r.created} new, ${r.updated ?? 0} updated)` : ''}` }))
  bulk(@CurrentPrincipal() p: Principal, @Body() dto: BulkUpsertProductsDto) {
    return this.history.track(null, metaOf(p, 'IMPORT'), () => this.products.bulkUpsert(dto.products));
  }

  @Roles(Role.SUPER_ADMIN) @Permission('products')
  @Scopes('products:write')
  @Patch(':id')
  async update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    const before = await this.products.get(p, id).catch(() => null);
    const after = await this.history.track([id], metaOf(p, 'EDIT'), () => this.products.update(id, dto));
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
