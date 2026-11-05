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
  create(@Body() dto: CreateSupplierDto) {
    return this.purchasing.createSupplier(dto);
  }

  @Scopes('purchasing:write')
  @Patch(':id')
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
  create(@CurrentPrincipal() p: Principal, @Body() dto: CreatePurchaseOrderDto) {
    return this.purchasing.create(p, dto);
  }

  @Scopes('purchasing:write')
  @Patch(':id')
  update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePurchaseOrderDto) {
    return this.purchasing.update(p, id, dto);
  }

  /** Draft → Ordered (sent to supplier). */
  @Scopes('purchasing:write')
  @Post(':id/order')
  order(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.purchasing.order(p, id);
  }

  /** Record a delivery (all or part of the order). Adds stock. */
  @Scopes('purchasing:write')
  @Post(':id/receive')
  receive(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceivePurchaseOrderDto) {
    return this.purchasing.receive(p, id, dto);
  }

  @Scopes('purchasing:write')
  @Post(':id/cancel')
  cancel(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.purchasing.cancel(p, id);
  }
}
