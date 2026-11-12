import { Body, CallHandler, Controller, Delete, ExecutionContext, Get, HttpCode, Injectable, Module, NestInterceptor, Post } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsIn, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { from, Observable, switchMap } from 'rxjs';
import { setTimeout as sleep } from 'timers/promises';
import { Roles } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { ChaosService, FaultType } from './chaos.service';

/** Requests that are never slowed down or failed, so a fault can always be watched and switched off. */
const EXEMPT = [/^\/api\/v1\/chaos(\/|$)/, /^\/api\/v1\/monitoring(\/|$)/, /^\/health(\/|$)/, /^\/api\/v1\/?$/];

/** Applies the active fault to every API request (after login checks, before the handler). */
@Injectable()
export class ChaosInterceptor implements NestInterceptor {
  constructor(
    private readonly chaos: ChaosService,
    private readonly prisma: PrismaService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    if (!this.chaos.active() || EXEMPT.some((re) => re.test(req.path))) return next.handle();
    const operation = `${ctx.getClass().name}.${ctx.getHandler().name}`;
    const dbSleep = (ms: number) => this.prisma.$queryRawUnsafe(`SELECT pg_sleep(${(ms / 1000).toFixed(3)})`);
    return from(this.chaos.apply(operation, (ms) => sleep(ms), dbSleep)).pipe(switchMap(() => next.handle()));
  }
}

class FaultDto {
  @IsIn(['LATENCY', 'ERROR', 'DB_TIMEOUT'])
  type: FaultType;

  /** LATENCY / DB_TIMEOUT: delay per request (±25 %). Default 2000 / 3000 */
  @IsOptional() @IsInt() @Min(0) @Max(30_000)
  latencyMs?: number;

  /** ERROR / DB_TIMEOUT: share of requests that fail (0–1). Default 0.3 / 0.4 */
  @IsOptional() @IsNumber() @Min(0) @Max(1)
  errorRate?: number;

  /** The fault ends by itself after this many seconds. Default 120 */
  @IsOptional() @IsInt() @Min(5) @Max(1800)
  durationSec?: number;
}

/** Fault injection for testing alerts. Only exists when CHAOS_ENABLED=true (never in production). */
@ApiTags('Chaos (testing only)')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('chaos')
export class ChaosController {
  constructor(private readonly chaos: ChaosService) {}

  @Get()
  status() {
    return this.chaos.status();
  }

  @Post()
  start(@Body() dto: FaultDto) {
    this.chaos.activate(dto);
    return this.chaos.status();
  }

  @Delete()
  @HttpCode(200)
  stop() {
    this.chaos.clear();
    return this.chaos.status();
  }
}

@Module({
  controllers: [ChaosController],
  providers: [
    { provide: ChaosService, useFactory: () => new ChaosService() },
    { provide: APP_INTERCEPTOR, useClass: ChaosInterceptor },
  ],
})
export class ChaosModule {}
