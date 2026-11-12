import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ROLES } from '../common/decorators';
import { logEvent, setLogSinkForTests, writeLog } from '../logging/logger';
import { DetectorClient } from './detector.client';
import { MinuteMetrics, percentile } from './metrics';
import { MonitoringController, MonitoringService, probe } from './monitoring.module';

const T0 = Date.parse('2026-11-12T06:30:10Z');

describe('MinuteMetrics', () => {
  it('counts requests, 5xx share, p95, sales and failed payments per minute', () => {
    let now = T0;
    const m = new MinuteMetrics(180, () => now);
    for (let i = 1; i <= 20; i++) m.record('http_request', { status: i <= 2 ? 500 : i <= 5 ? 404 : 200, durationMs: i * 10 });
    m.record('sale_completed', {});
    m.record('sale_completed', {});
    m.record('sale_failed', {});
    m.record('payment_failed', {});
    now += 60_000;
    m.record('http_request', { status: 200, durationMs: 5 });

    const [, , prev, current] = m.series(4);
    expect(prev).toEqual({
      time: '2026-11-12T06:30:00.000Z', requests: 20, errorRate: 0.1, clientErrors: 3, p95Ms: 190.5,
      sales: 2, failedSales: 1, failedPayments: 1,
    });
    expect(current).toMatchObject({ time: '2026-11-12T06:31:00.000Z', requests: 1, errorRate: 0, p95Ms: 5 });
  });

  it('gives zeros for quiet minutes and forgets old ones', () => {
    let now = T0;
    const m = new MinuteMetrics(5, () => now);
    m.record('http_request', { status: 200, durationMs: 1 });
    now += 10 * 60_000;
    m.record('http_request', { status: 200, durationMs: 1 });
    const series = m.series(15);
    expect(series).toHaveLength(15);
    expect(series.filter((p) => p.requests).length).toBe(1); // the old minute was dropped
    expect(series[0]).toMatchObject({ requests: 0, p95Ms: null, errorRate: 0 });
  });

  it('computes p95 like numpy (linear interpolation)', () => {
    expect(percentile([1, 2, 3, 4], 95)).toBe(3.9);
    expect(percentile([7], 95)).toBe(7);
  });

  it('is fed by the structured log events', () => {
    setLogSinkForTests(() => undefined);
    const service = new MonitoringService({} as any, {} as any, {} as any);
    try {
      writeLog('info', 'HTTP request', { event: 'http_request', status: 503, durationMs: 40 });
      logEvent('info', 'sale_completed', 'Sale completed', { amount: 3 });
      const last = service.metrics.series(1)[0];
      expect(last).toMatchObject({ requests: 1, errorRate: 1, p95Ms: 40, sales: 1 });
    } finally {
      service.onModuleDestroy();
      setLogSinkForTests(null);
    }
  });
});

describe('probe', () => {
  it('ok when fast, warn when slow, fail on errors', async () => {
    expect(await probe(async () => 1, 1000)).toMatchObject({ status: 'ok' });
    expect(await probe(() => new Promise((r) => setTimeout(r, 30)), 5)).toMatchObject({ status: 'warn' });
    expect(await probe(async () => { throw new Error('ECONNREFUSED'); }, 100)).toEqual({ status: 'fail', ms: null, error: 'not reachable' });
  });
});

describe('MonitoringService.detectorStatus', () => {
  const service = (health: () => Promise<any>) => new MonitoringService({} as any, {} as any, { get: health } as any);

  it('fail when the detector is not reachable', async () => {
    const s = service(() => Promise.reject(new ServiceUnavailableException('The anomaly detector is not reachable')));
    expect(await s.detectorStatus()).toEqual({ status: 'fail', reachable: false, error: 'The anomaly detector is not reachable' });
    s.onModuleDestroy();
  });

  it('warn until trained, ok when trained and scoring new windows', async () => {
    const health = (models: object, last: string | null) => async () => ({
      profile: 'pos', models: { rules: true, trained_at: null, ...models }, last_window_end: last, telegram_notifications: true, notify_methods: ['rules', 'pca'],
    });
    const fresh = new Date(Date.now() - 15_000).toISOString();
    const untrained = service(health({ pca: false, isolation_forest: false }, fresh));
    expect(await untrained.detectorStatus()).toMatchObject({ status: 'warn', trained: false, notes: ['not trained yet: only the rules run'] });
    const stale = service(health({ pca: true }, new Date(Date.now() - 600_000).toISOString()));
    expect((await stale.detectorStatus()).status).toBe('warn');
    const ok = service(health({ pca: true, isolation_forest: true }, fresh));
    expect(await ok.detectorStatus()).toMatchObject({ status: 'ok', reachable: true, trained: true, telegram: true, notes: [] });
    [untrained, stale, ok].forEach((x) => x.onModuleDestroy());
  });
});

describe('MonitoringController', () => {
  it('is for super admins only (and not for API keys: no @Scopes)', () => {
    expect(Reflect.getMetadata(ROLES, MonitoringController)).toEqual([Role.SUPER_ADMIN]);
    expect(Reflect.getMetadata('scopes', MonitoringController)).toBeUndefined();
  });
});

describe('DetectorClient', () => {
  const realFetch = global.fetch;
  afterEach(() => (global.fetch = realFetch));
  const respond = (status: number, body: unknown) => jest.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it('sends the API key and returns the JSON', async () => {
    const fetchMock = respond(200, { count: 0, alerts: [] });
    global.fetch = fetchMock as any;
    expect(await new DetectorClient().get('/alerts?limit=5')).toEqual({ count: 0, alerts: [] });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8000/alerts?limit=5');
  });

  it('503 when unreachable, passes on the detector message, 502 for a wrong key', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed')) as any;
    await expect(new DetectorClient().get('/health')).rejects.toBeInstanceOf(ServiceUnavailableException);

    global.fetch = respond(400, { detail: 'Telegram is not configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID' }) as any;
    const e = await new DetectorClient().post('/notify/test').catch((x) => x);
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(400);
    expect(e.getResponse().message).toContain('Telegram is not configured');

    global.fetch = respond(401, { detail: 'missing or wrong X-API-Key' }) as any;
    const k = await new DetectorClient().get('/alerts').catch((x) => x);
    expect(k.getStatus()).toBe(502);
    expect(k.getResponse().message).toContain('DETECTOR_API_KEY');
  });
});
