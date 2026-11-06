import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from './common/decorators';
import { PrismaService } from './prisma/prisma.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** For load balancers and uptime monitors. */
  @Public()
  @Get()
  async check() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', time: new Date().toISOString() };
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
