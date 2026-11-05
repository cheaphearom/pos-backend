import { Body, Controller, Get, Param, ParseBoolPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentPrincipal, Roles, Scopes } from '../common/decorators';
import { Principal } from '../common/principal';
import { CreateStoreDto, UpdateStoreDto } from './stores.dto';
import { StoresService } from './stores.service';

@ApiTags('Stores')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('stores')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  /** Stores the caller can access. */
  @Scopes('stores:read')
  @Get()
  list(@CurrentPrincipal() p: Principal, @Query('includeInactive', new ParseBoolPipe({ optional: true })) all?: boolean) {
    return this.stores.list(p, all);
  }

  @Scopes('stores:read')
  @Get(':id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.stores.get(p, id);
  }

  @Roles(Role.SUPER_ADMIN)
  @Post()
  create(@Body() dto: CreateStoreDto) {
    return this.stores.create(dto);
  }

  @Roles(Role.STORE_MANAGER)
  @Patch(':id')
  update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStoreDto) {
    return this.stores.update(p, id, dto);
  }
}
