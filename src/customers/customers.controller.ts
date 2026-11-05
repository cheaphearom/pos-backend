import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles, Scopes } from '../common/decorators';
import { PageQueryDto } from '../common/pagination';
import { AdjustPointsDto, CreateCustomerDto, CustomerQueryDto, UpdateCustomerDto } from './customers.dto';
import { CustomersService } from './customers.service';

@ApiTags('Customers & Loyalty')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Scopes('customers:read')
  @Get()
  list(@Query() q: CustomerQueryDto) {
    return this.customers.list(q);
  }

  /** Earn rate and point value currently in use. */
  @Scopes('customers:read')
  @Get('loyalty-rules')
  rules() {
    return this.customers.loyaltyRules();
  }

  /** Find a member by phone number or member card code. */
  @Scopes('customers:read')
  @Get('lookup')
  lookup(@Query('code') code: string) {
    return this.customers.lookup(code);
  }

  @Scopes('customers:read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.get(id);
  }

  @Scopes('customers:read')
  @Get(':id/points')
  history(@Param('id', ParseUUIDPipe) id: string, @Query() q: PageQueryDto) {
    return this.customers.history(id, q);
  }

  @Scopes('customers:read')
  @Get(':id/purchases')
  purchases(@Param('id', ParseUUIDPipe) id: string, @Query() q: PageQueryDto) {
    return this.customers.purchases(id, q);
  }

  @Scopes('customers:write')
  @Post()
  create(@Body() dto: CreateCustomerDto) {
    return this.customers.create(dto);
  }

  @Scopes('customers:write')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(id, dto);
  }

  /** Manually add or remove points (complaints, promotions). */
  @Roles(Role.STORE_MANAGER)
  @Post(':id/points/adjust')
  adjust(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AdjustPointsDto) {
    return this.customers.adjustPoints(id, dto);
  }
}
