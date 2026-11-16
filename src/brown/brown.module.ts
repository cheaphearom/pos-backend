import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { AuditService } from '../audit/audit.module';
import { CurrentPrincipal, Roles } from '../common/decorators';
import { Principal } from '../common/principal';
import { BrownSyncAllDto, BrownSyncDto } from './brown.dto';
import { BrownService } from './brown.service';

@ApiTags('Stores')
@ApiBearerAuth()
@Controller('stores')
export class BrownController {
  constructor(
    private readonly brown: BrownService,
    private readonly audit: AuditService,
  ) {}

  /** The default BROWN API address (shown in the Sync dialog). */
  @Roles(Role.SUPER_ADMIN)
  @Get('brown-sync/settings')
  settings() {
    return this.brown.settings();
  }

  /** Sync every active store that has a BROWN store id. Runs in the background; returns the run to follow with GET. */
  @Roles(Role.SUPER_ADMIN)
  @Post('brown-sync-all')
  async syncAll(@CurrentPrincipal() p: Principal, @Body() dto: BrownSyncAllDto) {
    return this.brown.startSyncAll(
      { devKid: dto.devKid, accessToken: dto.accessToken, dataEncryption: dto.dataEncryption || undefined, apiUrl: dto.apiUrl?.trim() || undefined, username: dto.username?.trim() || undefined, groupIds: dto.groupIds?.trim() || undefined },
      (job) => {
        const ok = job.results.filter((r) => r.ok);
        this.audit.add(p, {
          action: 'BROWN_MENU_SYNCED_ALL', entityType: 'store', entityId: 'all',
          summary: `BROWN menu synced for ${ok.length} of ${job.total} stores${job.stopped ? ' (stopped early)' : ''}`,
          details: { total: job.total, synced: ok.map((r) => r.store), failed: job.results.filter((r) => !r.ok).map((r) => ({ store: r.store, error: r.error })), stopped: job.stopped },
        });
      },
    );
  }

  /** Progress and results of a "sync all stores" run */
  @Roles(Role.SUPER_ADMIN)
  @Get('brown-sync-all/:jobId')
  syncAllStatus(@Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.brown.syncAllStatus(jobId);
  }

  /** Sync this store's menu from the BROWN system: new items are created, existing ones (same SKU) updated. */
  @Roles(Role.SUPER_ADMIN)
  @Post(':id/brown-sync')
  async sync(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BrownSyncDto) {
    const r = await this.brown.sync(id, dto);
    this.audit.add(p, {
      action: 'BROWN_MENU_SYNCED', storeId: id, entityType: 'store', entityId: r.store,
      summary: `BROWN menu synced for ${r.store}: ${r.items} items (${r.productsCreated} new, ${r.productsUpdated} updated)`,
      details: { ...r, source: dto.response ? 'pasted' : 'api', ...(!dto.response && { apiUrl: dto.apiUrl || 'default' }) },
    });
    return r;
  }
}

@Module({ controllers: [BrownController], providers: [BrownService] })
export class BrownModule {}
