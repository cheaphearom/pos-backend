import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Scopes } from '../common/decorators';
import { Principal } from '../common/principal';
import { CreateRefundDto, CreateSaleDto, SaleQueryDto, VoidSaleDto } from './sales.dto';
import { SalesService } from './sales.service';

@ApiTags('Sales')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  /** Checkout: create a sale, take payment, deduct stock, update loyalty points. */
  @Scopes('sales:write')
  @Post()
  create(@CurrentPrincipal() p: Principal, @Body() dto: CreateSaleDto) {
    return this.sales.create(p, dto);
  }

  @Scopes('sales:read')
  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() q: SaleQueryDto) {
    return this.sales.list(p, q);
  }

  /** Receipt by sale id or receipt number (e.g. PP01-00000042). */
  @Scopes('sales:read')
  @Get(':idOrReceipt')
  get(@CurrentPrincipal() p: Principal, @Param('idOrReceipt') id: string) {
    return this.sales.get(p, id);
  }

  /** Managers refund; cashiers too, with a manager PIN when the store requires it (see /approvals). */
  @Scopes('sales:refund')
  @Post(':id/refunds')
  refund(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateRefundDto) {
    return this.sales.refund(p, id, dto);
  }

  /** Cancel a whole sale from today. Cashiers need a manager PIN when the store requires it. */
  @Scopes('sales:refund')
  @HttpCode(200)
  @Post(':id/void')
  void(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VoidSaleDto) {
    return this.sales.void(p, id, dto);
  }
}
