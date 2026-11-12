import { Prisma } from '@prisma/client';
import { spawnSync } from 'child_process';
import { ChaosService, ServiceFailureError } from './chaos.service';

const seq = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe('ChaosService', () => {
  const noop = async () => undefined;

  it('is off by default and then does nothing', async () => {
    const c = new ChaosService();
    const sleep = jest.fn(noop);
    await c.apply('op', sleep, sleep);
    expect(c.status()).toEqual({ active: false });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('LATENCY waits about latencyMs (±25 %) and never fails', async () => {
    const c = new ChaosService(Date.now, Math.random);
    c.activate({ type: 'LATENCY', latencyMs: 1000, durationSec: 60 });
    const waits: number[] = [];
    for (let i = 0; i < 300; i++) await c.apply('op', async (ms) => waits.push(ms), noop);
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(750);
    expect(Math.max(...waits)).toBeLessThanOrEqual(1250);
    const mean = waits.reduce((a, b) => a + b, 0) / waits.length;
    expect(mean).toBeGreaterThan(900);
    expect(mean).toBeLessThan(1100);
  });

  it('ERROR fails about errorRate of the requests with an unexpected error', async () => {
    const c = new ChaosService();
    c.activate({ type: 'ERROR', errorRate: 0.3, durationSec: 60 });
    let failures = 0;
    for (let i = 0; i < 2000; i++) {
      try {
        await c.apply('SalesController.create', noop, noop);
      } catch (e) {
        expect(e).toBeInstanceOf(ServiceFailureError);
        expect((e as Error).message).toContain('SalesController.create');
        failures++;
      }
    }
    expect(failures / 2000).toBeGreaterThan(0.25);
    expect(failures / 2000).toBeLessThan(0.35);
  });

  it("DB_TIMEOUT holds a database connection, then fails with Prisma's pool timeout (P2024)", async () => {
    const c = new ChaosService(Date.now, seq([0.5, 0.1])); // jitter 1.0x, then 0.1 < 0.4 → fail
    c.activate({ type: 'DB_TIMEOUT', latencyMs: 2000, errorRate: 0.4 });
    const dbSleep = jest.fn(noop);
    const err = await c.apply('ProductsController.list', noop, dbSleep).catch((e) => e);
    expect(dbSleep).toHaveBeenCalledWith(2000);
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(err.code).toBe('P2024');
    expect(err.message).toContain('Timed out fetching a new connection from the connection pool during ProductsController.list');
  });

  it('uses sensible defaults and ends by itself', () => {
    let now = Date.parse('2026-11-12T06:00:00Z');
    const c = new ChaosService(() => now);
    expect(c.activate({ type: 'DB_TIMEOUT' })).toMatchObject({ latencyMs: 3000, errorRate: 0.4, durationSec: 120 });
    now += 119_000;
    expect(c.status()).toMatchObject({ active: true, type: 'DB_TIMEOUT', secondsLeft: 1 });
    now += 1_000;
    expect(c.status()).toEqual({ active: false });
    c.activate({ type: 'ERROR' });
    c.clear();
    expect(c.active()).toBeNull();
  });
});

describe('CHAOS_ENABLED', () => {
  const load = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', "require('./src/config')"], {
      env: { PATH: process.env.PATH ?? '', JWT_ACCESS_SECRET: 'a-long-production-secret-0123456789', MEMBER_OTP_MODE: 'webhook', ...env },
      encoding: 'utf8',
    });

  it('cannot be used in production', () => {
    const r = load({ NODE_ENV: 'production', CHAOS_ENABLED: 'true' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('CHAOS_ENABLED=true is not allowed in production');
  });

  it('is fine in development, and off in production', () => {
    expect(load({ NODE_ENV: 'development', CHAOS_ENABLED: 'true' }).status).toBe(0);
    expect(load({ NODE_ENV: 'production' }).status).toBe(0);
  });
});
