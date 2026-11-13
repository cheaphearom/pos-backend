import { AuditService } from '../audit/audit.module';
import { Body, Controller, Get, Param, ParseBoolPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentPrincipal, Roles, Scopes } from '../common/decorators';
import { Principal } from '../common/principal';
import { CreateStoreWithProductsDto, UpdateStoreDto } from './stores.dto';
import { StoresService } from './stores.service';

@ApiTags('Stores')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('stores')
export class StoresController {
  constructor(
    private readonly stores: StoresService,
    private readonly audit: AuditService,
  ) {}

  /** Stores the caller can access. */
  @Scopes('stores:read')
  @Get()
  list(@CurrentPrincipal() p: Principal, @Query('includeInactive', new ParseBoolPipe({ optional: true })) all?: boolean) {
    return this.stores.list(p, all);
  }

  /** id, code and name of every active store. */
  @Scopes('stores:read')
  @Get('directory')
  directory() {
    return this.stores.directory();
  }

  @Scopes('stores:read')
  @Get(':id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.stores.get(p, id);
  }

  @Roles(Role.SUPER_ADMIN)
  @Post()
  create(@Body() dto: CreateStoreWithProductsDto) {
    return this.stores.create(dto);
  }

  @Roles(Role.STORE_MANAGER)
  @Patch(':id')
  async update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStoreDto) {
    const s = await this.stores.update(p, id, dto);
    this.audit.add(p, { action: 'STORE_CHANGED', storeId: id, entityType: 'store', entityId: s.code, summary: `Store ${s.code}: ${Object.keys(dto).join(', ')}`, details: dto });
    return s;
  }
}
