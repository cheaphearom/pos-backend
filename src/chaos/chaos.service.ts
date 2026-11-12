import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export type FaultType = 'LATENCY' | 'ERROR' | 'DB_TIMEOUT';

export interface Fault {
  type: FaultType;
  latencyMs: number;
  errorRate: number;
  durationSec: number;
  startedAt: Date;
  endsAt: Date;
}

/** An unexpected server error, as a bug or a broken dependency would throw. */
export class ServiceFailureError extends Error {}

/**
 * Development-only fault injection, like the e-commerce ChaosService:
 *  LATENCY     every request waits about latencyMs (±25 %)
 *  ERROR       errorRate of the requests fail with an unexpected error (HTTP 500)
 *  DB_TIMEOUT  every request holds a database connection for about latencyMs (SELECT pg_sleep), and errorRate
 *              of them fail with Prisma's connection-pool timeout (P2024): slow queries, a busy pool, 500s
 * A fault ends by itself after durationSec. The faults write no log lines of their own: only their effects
 * (slow requests, 5xx, unhandled exceptions, slow queries) appear in the logs, as in a real incident.
 */
@Injectable()
export class ChaosService {
  private fault: Fault | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  activate(f: { type: FaultType; latencyMs?: number; errorRate?: number; durationSec?: number }): Fault {
    const defaults: Record<FaultType, { latencyMs: number; errorRate: number }> = {
      LATENCY: { latencyMs: 2000, errorRate: 0 },
      ERROR: { latencyMs: 0, errorRate: 0.3 },
      DB_TIMEOUT: { latencyMs: 3000, errorRate: 0.4 },
    };
    const durationSec = f.durationSec ?? 120;
    const start = this.now();
    this.fault = {
      type: f.type,
      latencyMs: f.latencyMs ?? defaults[f.type].latencyMs,
      errorRate: f.errorRate ?? defaults[f.type].errorRate,
      durationSec,
      startedAt: new Date(start),
      endsAt: new Date(start + durationSec * 1000),
    };
    return this.fault;
  }

  clear() {
    this.fault = null;
  }

  /** The active fault, or null (an expired one is cleared). */
  active(): Fault | null {
    if (this.fault && this.now() >= this.fault.endsAt.getTime()) this.fault = null;
    return this.fault;
  }

  status() {
    const f = this.active();
    return f ? { active: true, ...f, secondsLeft: Math.ceil((f.endsAt.getTime() - this.now()) / 1000) } : { active: false };
  }

  /** Delay to apply now: latencyMs ± 25 %. */
  jitter(ms: number) {
    return Math.max(0, Math.round(ms * (0.75 + 0.5 * this.random())));
  }

  shouldFail(rate: number) {
    return this.random() < rate;
  }

  /**
   * Applies the active fault to one request. `sleep` waits; `dbSleep` holds a database connection
   * (DB_TIMEOUT). Throws the injected error.
   */
  async apply(operation: string, sleep: (ms: number) => Promise<unknown>, dbSleep: (ms: number) => Promise<unknown>) {
    const f = this.active();
    if (!f) return;
    if (f.type === 'LATENCY') {
      await sleep(this.jitter(f.latencyMs));
      return;
    }
    if (f.type === 'ERROR') {
      if (this.shouldFail(f.errorRate)) {
        throw new ServiceFailureError(`Upstream call failed while handling ${operation}: connection reset by peer`);
      }
      return;
    }
    // DB_TIMEOUT
    const ms = this.jitter(f.latencyMs);
    await dbSleep(ms).catch(() => undefined);
    if (this.shouldFail(f.errorRate)) {
      throw new Prisma.PrismaClientKnownRequestError(
        `Timed out fetching a new connection from the connection pool during ${operation}. (Current connection pool timeout: ${Math.round(ms / 1000)}, connection limit: 5)`,
        { code: 'P2024', clientVersion: Prisma.prismaVersion.client },
      );
    }
  }
}
