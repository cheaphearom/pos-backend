import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from './common/decorators';
import { MonitoringService } from './monitoring/monitoring.module';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly monitoring: MonitoringService) {}

  /**
   * For load balancers and uptime monitors: database and Redis, each "ok" or "fail" (no details,
   * no login). HTTP 503 when one of them fails. Details are in GET /api/v1/monitoring/status.
   */
  @Public()
  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const [db, redis] = await Promise.all([this.monitoring.pingDatabase(), this.monitoring.pingRedis()]);
    const ok = (s: string) => (s === 'fail' ? 'fail' : 'ok');
    const body = { status: ok(db.status) === 'ok' && ok(redis.status) === 'ok' ? 'ok' : 'fail', database: ok(db.status), redis: ok(redis.status), time: new Date().toISOString() };
    if (body.status !== 'ok') res.status(503);
    return body;
  }
}

/** GET /api/v1 — shows that the API is reachable and where the documentation is. */
@ApiTags('Health')
@Controller()
export class ApiRootController {
  @Public()
  @Get()
  root() {
    return { name: 'POS System API', status: 'ok', version: 'v1', docs: '/docs', health: '/health' };
  }
}
