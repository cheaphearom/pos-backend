import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { logEvent } from '../logging/logger';

/** Queries slower than this are logged as event=db_query_slow (WARN). */
const SLOW_QUERY_MS = Number(process.env.DB_SLOW_QUERY_MS || 500);

/**
 * Table and statement type of a SQL query, e.g. { model: 'sales', action: 'SELECT' }.
 * The SQL text and its parameters are never logged.
 */
export function describeQuery(sql: string): { model: string; action: string } {
  const action = (sql.trim().match(/^\w+/)?.[0] ?? 'QUERY').toUpperCase();
  const table = sql.match(/\b(?:FROM|INTO|UPDATE|JOIN)\s+(?:"?\w+"?\.)?"?(\w+)"?/i)?.[1];
  return { model: table ?? 'raw', action };
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ log: [{ emit: 'event', level: 'query' }] });
    // Prisma query events: one per SQL statement, with its duration.
    (this as any).$on('query', (e: Prisma.QueryEvent) => {
      if (e.duration < SLOW_QUERY_MS) return;
      logEvent('warn', 'db_query_slow', 'Slow database query', { ...describeQuery(e.query), durationMs: Math.round(e.duration) }, { logger: 'PrismaQuery' });
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
