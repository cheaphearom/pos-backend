import { InjectQueue } from '@nestjs/bullmq';
import { Controller, Get, HttpCode, Injectable, Module, OnModuleDestroy, OnModuleInit, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Queue } from 'bullmq';
import { Roles } from '../common/decorators';
import { onLogEvent, rememberStoreName } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import { WEBHOOK_QUEUE } from '../webhooks/webhook-events';
import { DetectorClient } from './detector.client';
import { MinuteMetrics } from './metrics';

export type Level = 'ok' | 'warn' | 'fail';
const worst = (levels: Level[]): Level => (levels.includes('fail') ? 'fail' : levels.includes('warn') ? 'warn' : 'ok');

/** The promise's value, or a rejection ('timeout') after `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Elapsed milliseconds of `fn`, or a rejection after 3 s. */
async function timed(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await withTimeout(fn());
  return Math.round((performance.now() - start) * 10) / 10;
}

/** ok below `slowMs`, warn above, fail on error or timeout. */
export async function probe(fn: () => Promise<unknown>, slowMs: number) {
  try {
    const ms = await timed(fn);
    return { status: (ms > slowMs ? 'warn' : 'ok') as Level, ms };
  } catch (e) {
    return { status: 'fail' as Level, ms: null, error: (e as Error).message === 'timeout' ? 'no answer within 3 s' : 'not reachable' };
  }
}

@Injectable()
export class MonitoringService implements OnModuleInit, OnModuleDestroy {
  readonly metrics = new MinuteMetrics();
  private readonly unsubscribe = onLogEvent((event, fields) => this.metrics.record(event, fields));
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue,
    private readonly detector: DetectorClient,
  ) {}

  /** Store names for the log events (an alert can then say which store the failures come from). */
  async onModuleInit() {
    try {
      for (const s of await this.prisma.store.findMany({ select: { id: true, name: true } })) rememberStoreName(s.id, s.name);
    } catch {
      /* the database may not be ready yet; sales fill the names in later */
    }
  }

  onModuleDestroy() {
    this.unsubscribe();
  }

  pingDatabase() {
    return probe(() => this.prisma.$queryRaw`SELECT 1`, 200);
  }

  pingRedis() {
    // the queue's own connection (ioredis) answers PING
    return probe(async () => ((await this.queue.client) as unknown as { ping(): Promise<string> }).ping(), 100);
  }

  async status() {
    const [database, redis, queue, detector] = await Promise.all([this.pingDatabase(), this.pingRedis(), this.queueStatus(), this.detectorStatus()]);
    const mem = process.memoryUsage();
    const api = {
      status: 'ok' as Level,
      uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      memoryMb: Math.round(mem.rss / 1048576),
      node: process.version,
    };
    return {
      status: worst([api.status, database.status, redis.status, queue.status, detector.status]),
      time: new Date().toISOString(),
      api, database, redis, queue, detector,
    };
  }

  /** Webhook queue: jobs waiting / running / retrying (delayed) / failed, and failures in the last hour. */
  async queueStatus() {
    try {
      const [counts, recentFailed] = await withTimeout(
        Promise.all([this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed'), this.queue.getJobs(['failed'], 0, 199)]),
      );
      const hourAgo = Date.now() - 3_600_000;
      const failedLastHour = recentFailed.filter((j) => (j?.finishedOn ?? 0) > hourAgo).length;
      // delayed = deliveries waiting for a retry after a failed attempt
      const status: Level = counts.waiting > 100 || counts.delayed > 0 || failedLastHour > 0 ? 'warn' : 'ok';
      return { status, waiting: counts.waiting, active: counts.active, delayed: counts.delayed, failed: counts.failed, failedLastHour };
    } catch {
      return { status: 'fail' as Level, error: 'queue not reachable (Redis)' };
    }
  }

  /** Reachable, trained, and is the live loop still scoring new windows? */
  async detectorStatus() {
    try {
      const h = await this.detector.get('/health', 3000);
      const models = h.models ?? {};
      const trained = Boolean(models.pca || models.isolation_forest);
      const lastWindowEnd: string | null = h.last_window_end ?? null;
      const ageS = lastWindowEnd ? Math.round((Date.now() - Date.parse(lastWindowEnd)) / 1000) : null;
      const notes: string[] = [];
      if (!trained) notes.push('not trained yet: only the rules run');
      if (h.training?.warning) notes.push(h.training.warning);
      if (ageS === null) notes.push('no log window scored yet');
      else if (ageS > 180) notes.push(`last window scored ${Math.round(ageS / 60)} min ago (no new logs?)`);
      return {
        status: (notes.length ? 'warn' : 'ok') as Level,
        reachable: true,
        profile: h.profile,
        trained,
        trainedAt: models.trained_at ?? null,
        models: Object.fromEntries(Object.entries(models).filter(([k]) => k !== 'trained_at')),
        lastWindowEnd,
        telegram: Boolean(h.telegram_notifications),
        notifyMethods: h.notify_methods ?? [],
        notes,
      };
    } catch (e) {
      return { status: 'fail' as Level, reachable: false, error: (e as Error).message };
    }
  }
}

class MinutesQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(180)
  minutes?: number;
}

class LimitQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500)
  limit?: number;
}

/** System monitoring for super admins: health of every part, request metrics, anomaly detector. */
@ApiTags('Monitoring')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('monitoring')
export class MonitoringController {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly detector: DetectorClient,
  ) {}

  /** API, PostgreSQL, Redis, webhook queue and anomaly detector, each ok / warn / fail. */
  @Get('status')
  status() {
    return this.monitoring.status();
  }

  /** Per minute: requests, share of 5xx, p95 latency, sales, failed sales and payments (this API process, in memory). */
  @Get('metrics')
  metrics(@Query() q: MinutesQuery) {
    const minutes = q.minutes ?? 60;
    return { minutes, points: this.monitoring.metrics.series(minutes) };
  }

  /** Anomaly score and threshold of every detector per window (from the detector). */
  @Get('scores')
  scores(@Query() q: MinutesQuery) {
    return this.detector.get(`/scores?minutes=${q.minutes ?? 30}`);
  }

  /** Alerts raised by the detector, newest first, with their explanation. */
  @Get('alerts')
  alerts(@Query() q: LimitQuery) {
    return this.detector.get(`/alerts?limit=${q.limit ?? 50}`);
  }

  /** Sends a test message to the Telegram chat configured in the detector. */
  @Post('notify-test')
  @HttpCode(200)
  notifyTest() {
    return this.detector.post('/notify/test');
  }
}

@Module({
  controllers: [MonitoringController],
  providers: [MonitoringService, DetectorClient],
  exports: [MonitoringService],
})
export class MonitoringModule {}
