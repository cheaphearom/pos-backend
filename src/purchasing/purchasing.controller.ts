// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { Audit, fieldsOf, safeBody } from '../audit/audited';
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentPrincipal, Roles, Scopes } from '../common/decorators';
import { Principal } from '../common/principal';
import { CreatePurchaseOrderDto, CreateSupplierDto, PoQueryDto, ReceivePurchaseOrderDto, SupplierQueryDto, UpdatePurchaseOrderDto, UpdateSupplierDto } from './purchasing.dto';
import { PurchasingService } from './purchasing.service';

@ApiTags('Purchasing')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Roles(Role.STORE_MANAGER)
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly purchasing: PurchasingService) {}

  @Scopes('purchasing:read')
  @Get()
  list(@Query() q: SupplierQueryDto) {
    return this.purchasing.listSuppliers(q);
  }

  @Scopes('purchasing:read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchasing.getSupplier(id);
  }

  @Scopes('purchasing:write')
  @Post()
  @Audit('SUPPLIER_CREATED', ({ result: r }) => ({ entityType: 'supplier', entityId: r?.code, summary: `Supplier ${r?.code} ${r?.name} created` }))
  create(@Body() dto: CreateSupplierDto) {
    return this.purchasing.createSupplier(dto);
  }

  @Scopes('purchasing:write')
  @Patch(':id')
  @Audit('SUPPLIER_CHANGED', ({ result: r, body }) => ({ entityType: 'supplier', entityId: r?.code, summary: `Supplier ${r?.code} ${r?.name}: ${fieldsOf(body)}`, details: safeBody(body) }))
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierDto) {
    return this.purchasing.updateSupplier(id, dto);
  }
}

@ApiTags('Purchasing')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Roles(Role.STORE_MANAGER)
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly purchasing: PurchasingService) {}

  @Scopes('purchasing:read')
  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() q: PoQueryDto) {
    return this.purchasing.list(p, q);
  }

  /** Low-stock products with a suggested order quantity. */
  @Scopes('purchasing:read')
  @Get('suggestions')
  suggestions(@CurrentPrincipal() p: Principal, @Query('storeId', ParseUUIDPipe) storeId: string) {
    return this.purchasing.suggestions(p, storeId);
  }

  @Scopes('purchasing:read')
  @Get(':id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.purchasing.get(p, id);
  }

  /** Create a draft order. */
  @Scopes('purchasing:write')
  @Post()
  @Audit('PO_CREATED', ({ result: r }) => ({ entityType: 'purchase_order', entityId: r?.poNo, storeId: r?.storeId, summary: `Purchase order ${r?.poNo} created${r?.supplier?.name ? ` for ${r.supplier.name}` : ''}` }))
  create(@CurrentPrincipal() p: Principal, @Body() dto: CreatePurchaseOrderDto) {
    return this.purchasing.create(p, dto);
  }

  @Scopes('purchasing:write')
  @Patch(':id')
  @Audit('PO_CHANGED', ({ result: r, body }) => ({ entityType: 'purchase_order', entityId: r?.poNo, storeId: r?.storeId, summary: `Purchase order ${r?.poNo}: ${fieldsOf(body)}` }))
  update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePurchaseOrderDto) {
    return this.purchasing.update(p, id, dto);
  }

  /** Draft → Ordered (sent to supplier). */
  @Scopes('purchasing:write')
  @Post(':id/order')
  @Audit('PO_ORDERED', ({ result: r }) => ({ entityType: 'purchase_order', entityId: r?.poNo, storeId: r?.storeId, summary: `Purchase order ${r?.poNo} sent to the supplier` }))
  order(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.purchasing.order(p, id);
  }

  /** Record a delivery (all or part of the order). Adds stock. */
  @Scopes('purchasing:write')
  @Post(':id/receive')
  @Audit('PO_RECEIVED', ({ result: r, body }) => ({ entityType: 'purchase_order', entityId: r?.poNo, storeId: r?.storeId, summary: `Purchase order ${r?.poNo} received (${(body?.items ?? body?.lines ?? []).length} line(s))`, details: safeBody(body) }))
  receive(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceivePurchaseOrderDto) {
    return this.purchasing.receive(p, id, dto);
  }

  @Scopes('purchasing:write')
  @Post(':id/cancel')
  @Audit('PO_CANCELLED', ({ result: r }) => ({ entityType: 'purchase_order', entityId: r?.poNo, storeId: r?.storeId, summary: `Purchase order ${r?.poNo} cancelled` }))
  cancel(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.purchasing.cancel(p, id);
  }
}
