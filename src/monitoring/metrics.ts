import { Fields } from '../logging/logger';

const MAX_SAMPLES = 2000; // latency samples kept per minute (reservoir), enough for a stable p95

interface Bucket {
  minute: number; // epoch minute
  requests: number;
  errors: number; // HTTP 5xx
  clientErrors: number; // HTTP 4xx
  durations: number[];
  seen: number; // requests offered to the reservoir
  sales: number;
  failedSales: number;
  failedPayments: number;
}

export interface MinutePoint {
  time: string;
  requests: number;
  errorRate: number;
  clientErrors: number;
  p95Ms: number | null;
  sales: number;
  failedSales: number;
  failedPayments: number;
}

/**
 * Per-minute request and sales metrics of this API process, kept in memory for `keepMinutes`
 * (a ring buffer: nothing is stored in the database and it starts empty after a restart).
 * Fed from the structured log events (event=http_request, sale_completed, …).
 */
export class MinuteMetrics {
  private readonly buckets = new Map<number, Bucket>();

  constructor(
    private readonly keepMinutes = 180,
    private readonly now: () => number = Date.now,
  ) {}

  record(event: string, fields: Fields) {
    const b = this.bucket();
    switch (event) {
      case 'http_request': {
        b.requests++;
        const status = Number(fields.status);
        if (status >= 500) b.errors++;
        else if (status >= 400) b.clientErrors++;
        const d = Number(fields.durationMs);
        if (Number.isFinite(d)) {
          b.seen++;
          if (b.durations.length < MAX_SAMPLES) b.durations.push(d);
          else {
            const i = Math.floor(Math.random() * b.seen);
            if (i < MAX_SAMPLES) b.durations[i] = d;
          }
        }
        break;
      }
      case 'sale_completed':
        b.sales++;
        break;
      case 'sale_failed':
        b.failedSales++;
        break;
      case 'payment_failed':
        b.failedPayments++;
        break;
    }
  }

  /** One point per minute for the last `minutes` minutes (oldest first; minutes without traffic are zeros). */
  series(minutes: number): MinutePoint[] {
    const current = Math.floor(this.now() / 60_000);
    const out: MinutePoint[] = [];
    for (let m = current - minutes + 1; m <= current; m++) {
      const b = this.buckets.get(m);
      out.push({
        time: new Date(m * 60_000).toISOString(),
        requests: b?.requests ?? 0,
        errorRate: b?.requests ? round(b.errors / b.requests, 4) : 0,
        clientErrors: b?.clientErrors ?? 0,
        p95Ms: b?.durations.length ? percentile(b.durations, 95) : null,
        sales: b?.sales ?? 0,
        failedSales: b?.failedSales ?? 0,
        failedPayments: b?.failedPayments ?? 0,
      });
    }
    return out;
  }

  private bucket(): Bucket {
    const minute = Math.floor(this.now() / 60_000);
    let b = this.buckets.get(minute);
    if (!b) {
      b = { minute, requests: 0, errors: 0, clientErrors: 0, durations: [], seen: 0, sales: 0, failedSales: 0, failedPayments: 0 };
      this.buckets.set(minute, b);
      for (const key of this.buckets.keys()) if (key <= minute - this.keepMinutes) this.buckets.delete(key);
    }
    return b;
  }
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  // linear interpolation, like numpy.percentile (used by the detector)
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return round(sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo), 1);
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
