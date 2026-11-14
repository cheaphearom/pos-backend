import { Body, Controller, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { AuditService } from '../audit/audit.module';
import { CurrentPrincipal, Roles } from '../common/decorators';
import { Principal } from '../common/principal';
import { BrownSyncDto } from './brown.dto';
import { BrownService } from './brown.service';

@ApiTags('Stores')
@ApiBearerAuth()
@Controller('stores')
export class BrownController {
  constructor(
    private readonly brown: BrownService,
    private readonly audit: AuditService,
  ) {}

  /** Sync this store's menu from the BROWN system: new items are created, existing ones (same SKU) updated. */
  @Roles(Role.SUPER_ADMIN)
  @Post(':id/brown-sync')
  async sync(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BrownSyncDto) {
    const r = await this.brown.sync(id, dto);
    this.audit.add(p, {
      action: 'BROWN_MENU_SYNCED', storeId: id, entityType: 'store', entityId: r.store,
      summary: `BROWN menu synced for ${r.store}: ${r.items} items (${r.productsCreated} new, ${r.productsUpdated} updated)`,
      details: { ...r, source: dto.response ? 'pasted' : 'api' },
    });
    return r;
  }
}

@Module({ controllers: [BrownController], providers: [BrownService] })
export class BrownModule {}
