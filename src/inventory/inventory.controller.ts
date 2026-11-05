import { AuditService } from '../audit/audit.module';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentPrincipal, Roles, Scopes } from '../common/decorators';
import { Principal } from '../common/principal';
import { AdjustStockDto, CreateTransferDto, InventoryQueryDto, MovementQueryDto, TransferQueryDto, UpdateInventoryDto } from './inventory.dto';
import { InventoryService } from './inventory.service';

@ApiTags('Inventory')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  /** Stock levels of a store. Use lowStock=true for the reorder list. */
  @Scopes('inventory:read')
  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() q: InventoryQueryDto) {
    return this.inventory.list(p, q);
  }

  /** Stock history (every in/out). */
  @Scopes('inventory:read')
  @Get('movements')
  movements(@CurrentPrincipal() p: Principal, @Query() q: MovementQueryDto) {
    return this.inventory.movements(p, q);
  }

  /** Receive goods from a supplier or correct stock counts. */
  @Roles(Role.STORE_MANAGER)
  @Scopes('inventory:write')
  @Post('adjustments')
  async adjust(@CurrentPrincipal() p: Principal, @Body() dto: AdjustStockDto) {
    const r = await this.inventory.adjust(p, dto);
    this.audit.add(p, {
      action: dto.type === 'PURCHASE' ? 'STOCK_RECEIVED' : 'STOCK_ADJUSTED', storeId: dto.storeId, entityType: 'stock', entityId: dto.reference ?? null,
      summary: `${dto.type === 'PURCHASE' ? 'Stock received' : 'Stock adjusted'}: ${dto.items.length} item(s)${dto.note ? ` (${dto.note})` : ''}`, details: dto,
    });
    return r;
  }

  /** Set reorder level and store-specific price. */
  @Roles(Role.STORE_MANAGER)
  @Scopes('inventory:write')
  @Put(':storeId/:productId')
  update(
    @CurrentPrincipal() p: Principal,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: UpdateInventoryDto,
  ) {
    return this.inventory.update(p, storeId, productId, dto);
  }
}

@ApiTags('Inventory')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('transfers')
export class TransfersController {
  constructor(private readonly inventory: InventoryService) {}

  @Scopes('inventory:read')
  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() q: TransferQueryDto) {
    return this.inventory.listTransfers(p, q);
  }

  @Scopes('inventory:read')
  @Get(':id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.getTransfer(p, id);
  }

  /** Send stock to another store. Stock leaves the source store now. */
  @Roles(Role.STORE_MANAGER)
  @Scopes('inventory:write')
  @Post()
  create(@CurrentPrincipal() p: Principal, @Body() dto: CreateTransferDto) {
    return this.inventory.createTransfer(p, dto);
  }

  /** Destination store confirms the goods arrived. */
  @Roles(Role.STORE_MANAGER)
  @Scopes('inventory:write')
  @Post(':id/receive')
  receive(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.receiveTransfer(p, id);
  }

  /** Cancel an in-transit transfer; stock returns to the source store. */
  @Roles(Role.STORE_MANAGER)
  @Scopes('inventory:write')
  @Post(':id/cancel')
  cancel(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.cancelTransfer(p, id);
  }
}
