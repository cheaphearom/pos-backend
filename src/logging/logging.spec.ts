import { BadRequestException } from '@nestjs/common';
import { EventEmitter } from 'events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describeQuery } from '../prisma/prisma.service';
import { accessLog, normalizePath } from './access-log.middleware';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { errorFields, JsonNestLogger, logContext, logEvent, rememberStoreName, scrubText, setLogSinkForTests, writeLog } from './logger';
import { RotatingFile } from './rotating-file';

let lines: string[] = [];
const records = () => lines.map((l) => JSON.parse(l));

beforeEach(() => {
  lines = [];
  setLogSinkForTests((l) => lines.push(l));
});
afterAll(() => setLogSinkForTests(null));

describe('JSON log format', () => {
  it('writes the e-commerce format: @timestamp, uppercase level, service, logger_name, kv message, fields', () => {
    logContext.run({ traceId: 'abc123' }, () =>
      logEvent('info', 'sale_completed', 'Sale completed', { storeId: 's1', amount: 12.5, durationMs: 42 }),
    );
    const [r] = records();
    expect(r['@timestamp']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(r).toMatchObject({
      level: 'INFO', service: 'pos-api', logger_name: 'BusinessEvent', event: 'sale_completed',
      storeId: 's1', amount: 12.5, durationMs: 42, traceId: 'abc123',
      message: 'Sale completed event=sale_completed storeId=s1 amount=12.5 durationMs=42',
    });
  });

  it('uses WARN and ERROR, and service=pos-worker for the worker', () => {
    logEvent('warn', 'webhook_failed', 'Webhook delivery failed', {}, { service: 'pos-worker' });
    writeLog('error', 'boom');
    expect(records().map((r) => [r.level, r.service])).toEqual([['WARN', 'pos-worker'], ['ERROR', 'pos-api']]);
  });

  it('adds the store name to events that have a known storeId', () => {
    rememberStoreName('store-9', 'Siem Reap - Pub Street');
    logEvent('warn', 'payment_failed', 'Payment failed', { storeId: 'store-9', method: 'KHQR' });
    logEvent('warn', 'payment_failed', 'Payment failed', { storeId: 'unknown-store' });
    expect(records()[0].storeName).toBe('Siem Reap - Pub Street');
    expect(records()[1]).not.toHaveProperty('storeName');
  });

  it("routes Nest's own logger through the same format", () => {
    new JsonNestLogger().log('Mapped route', 'RouterExplorer');
    expect(records()[0]).toMatchObject({ level: 'INFO', logger_name: 'RouterExplorer', message: 'Mapped route' });
  });

  it('writes exception, errorMessage and stack_trace', () => {
    const f = errorFields(new TypeError('x is undefined'));
    expect(f).toMatchObject({ exception: 'TypeError', errorMessage: 'x is undefined' });
    expect(String(f.stack_trace)).toContain('TypeError');
  });
});

describe('privacy', () => {
  const SECRETS = {
    password: 'hunter2-Password!',
    newPassword: 'n3w-Passw0rd',
    accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
    refreshToken: 'r7Qm2xY8kLp4Zt6Vb9Nc3Hd5Jf1Gs0Aw-rT_yUiOpLkJh',
    apiKey: 'pos_AbCdEfGhIjKlMnOpQrStUvWx',
    'x-api-key': 'pos_ZyXwVuTsRqPoNmLkJiHgFeDc',
    authorization: 'Bearer abc.def.ghi',
    pin: '4321',
    managerPin: '9876',
    cardNumber: '8899123456789012',
    walletNumber: '8899000011112222',
    phone: '012345678',
    email: 'customer@example.com',
    secret: 'whsec_0123456789abcdef0123456789abcdef',
    code: '123456',
  };

  it('never writes passwords, tokens, keys, PINs, card or wallet numbers, phone or email', () => {
    logEvent('warn', 'login_failed', 'Login failed', { ...SECRETS, storeId: 'store-1' });
    // Secrets can also hide in free text: messages and exception text are scrubbed.
    writeLog('error', 'Could not send code to customer@example.com, phone 012 345 678, card 8899123456789012', {
      errorMessage: 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl rejected; key pos_AbCdEfGhIjKlMnOpQrStUvWx',
    });
    new JsonNestLogger().error('Bearer abcdefghijklmnop failed for +85512345678', 'Error: at x', 'MemberAuth');

    const out = lines.join('\n');
    for (const [key, value] of Object.entries(SECRETS)) {
      expect(out).not.toContain(value);
      expect(records()[0]).not.toHaveProperty(key);
    }
    expect(out).not.toContain('012 345 678');
    expect(out).not.toContain('abcdefghijklmnop');
    expect(out).not.toContain('12345678');
    expect(records()[0].storeId).toBe('store-1'); // safe fields are kept
  });

  it('does not log nested objects (they may contain customer data)', () => {
    logEvent('info', 'online_order_created', 'Online order', { customer: { name: 'A', phone: '012345678' } as any, amount: 3 });
    expect(records()[0]).not.toHaveProperty('customer');
    expect(lines[0]).not.toContain('012345678');
  });

  it('keeps ids readable (UUIDs that start with digits are not phone numbers)', () => {
    logEvent('info', 'sale_completed', 'Sale', { storeId: '12345678-55c5-41bc-a4f6-1ffb057d6ed3' });
    expect(records()[0].storeId).toBe('12345678-55c5-41bc-a4f6-1ffb057d6ed3');
  });

  it('keeps ordinary text readable', () => {
    expect(scrubText('Not enough stock for Latte (SKU-12): available 3, needed 5')).toBe('Not enough stock for Latte (SKU-12): available 3, needed 5');
  });
});

describe('normalizePath', () => {
  it.each([
    ['/api/v1/sales/0b6f1c1e-8a4e-4a52-9a0b-1c2d3e4f5a6b', '/api/v1/sales/{id}'],
    ['/api/v1/sales/S-PP01-20261112-0001/receipt', '/api/v1/sales/{id}/receipt'],
    ['/api/v1/products/barcode/8851234567890', '/api/v1/products/barcode/{id}'],
    ['/api/v1/customers/42?page=2', '/api/v1/customers/{id}'],
    ['/api/v1/online/PP01/menu', '/api/v1/online/{id}/menu'],
    ['/api/v1/payments/khqr/d41d8cd98f00b204e9800998ecf8427e', '/api/v1/payments/khqr/{id}'],
    ['/api/v1/reports/dashboard', '/api/v1/reports/dashboard'],
  ])('%s → %s', (input, expected) => expect(normalizePath(input)).toBe(expected));
});

describe('describeQuery (slow query log)', () => {
  it('gives the table and statement, never the parameters', () => {
    expect(describeQuery('SELECT "public"."sales"."id" FROM "public"."sales" WHERE "public"."sales"."id" = $1')).toEqual({ model: 'sales', action: 'SELECT' });
    expect(describeQuery('UPDATE inventory SET quantity = quantity + $1')).toEqual({ model: 'inventory', action: 'UPDATE' });
    expect(describeQuery('INSERT INTO "public"."stock_movements" ("id") VALUES ($1)')).toEqual({ model: 'stock_movements', action: 'INSERT' });
  });
});

function fakeHttp(path: string, headers: Record<string, string> = {}) {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {} as Record<string, string>,
    headersSent: false,
    body: undefined as unknown,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  });
  const req = { method: 'POST', path: path.split('?')[0], originalUrl: path, url: path, headers, baseUrl: '' } as any;
  return { req, res };
}

describe('access log middleware', () => {
  it('logs one line per request with the route, status, duration and trace id', () => {
    const { req, res } = fakeHttp('/api/v1/sales/0b6f1c1e-8a4e-4a52-9a0b-1c2d3e4f5a6b/refunds', { 'x-request-id': 'req-12345678' });
    let traceInside: string | undefined;
    accessLog(req, res as any, () => (traceInside = logContext.getStore()?.traceId));
    res.statusCode = 404;
    res.emit('finish');
    expect(traceInside).toBe('req-12345678');
    expect(res.headers['X-Request-Id']).toBe('req-12345678');
    expect(records()[0]).toMatchObject({
      level: 'WARN', logger_name: 'HttpAccess', event: 'http_request', method: 'POST',
      path: '/api/v1/sales/{id}/refunds', status: 404, traceId: 'req-12345678',
    });
    expect(records()[0].message).toMatch(/^HTTP request event=http_request method=POST path=\/api\/v1\/sales\/\{id\}\/refunds status=404 durationMs=\d+$/);
  });

  it('uses the matched route, INFO for 2xx and ERROR for 5xx, and generates a trace id', () => {
    const a = fakeHttp('/api/v1/products/8851234567890');
    a.req.route = { path: '/api/v1/products/:id' };
    accessLog(a.req, a.res as any, () => undefined);
    a.res.emit('finish');
    const b = fakeHttp('/api/v1/sales');
    accessLog(b.req, b.res as any, () => undefined);
    b.res.statusCode = 503;
    b.res.emit('finish');
    expect(records().map((r) => [r.level, r.path])).toEqual([['INFO', '/api/v1/products/{id}'], ['ERROR', '/api/v1/sales']]);
    expect(records()[0].traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('skips /health and the monitoring endpoints', () => {
    for (const p of ['/health', '/api/v1/monitoring/status']) {
      const { req, res } = fakeHttp(p);
      accessLog(req, res as any, () => undefined);
      res.emit('finish');
    }
    expect(lines).toHaveLength(0);
  });
});

describe('global exception filter', () => {
  const host = (req: any, res: any) => ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) }) as any;

  it('logs unexpected errors as unhandled_exception and keeps the 500 response', () => {
    const { req, res } = fakeHttp('/api/v1/sales');
    new AllExceptionsFilter().catch(new RangeError('Invalid time value'), host(req, res));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(records()[0]).toMatchObject({ level: 'ERROR', event: 'unhandled_exception', exception: 'RangeError', errorMessage: 'Invalid time value' });
    expect(records()[0].stack_trace).toContain('RangeError');
  });

  it('returns HTTP errors unchanged and does not log them as unhandled', () => {
    const { req, res } = fakeHttp('/api/v1/sales');
    new AllExceptionsFilter().catch(new BadRequestException('Payment 5 is less than amount due 6'), host(req, res));
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ statusCode: 400, message: 'Payment 5 is less than amount due 6', error: 'Bad Request' });
    expect(lines).toHaveLength(0);
  });
});

describe('RotatingFile', () => {
  it('keeps writing to pos-api.log and gzips rolled files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poslog-'));
    try {
      const f = new RotatingFile(dir, 'pos-api', { maxBytes: 200, maxFiles: 2 });
      for (let i = 0; i < 20; i++) f.write(`{"n":${i},"pad":"${'x'.repeat(40)}"}\n`);
      // gzip runs in the background: wait until a rolled file exists (not a fixed time, which a slow machine can miss)
      for (let i = 0; i < 100 && !readdirSync(dir).some((n) => n.endsWith('.log.gz')); i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 100)); // let the last rolling finish
      f.close();
      expect(existsSync(join(dir, 'pos-api.log'))).toBe(true);
      const rolled = readdirSync(dir).filter((n) => n.endsWith('.log.gz'));
      expect(rolled.length).toBeGreaterThan(0);
      expect(rolled.length).toBeLessThanOrEqual(2);
      expect(readFileSync(join(dir, 'pos-api.log'), 'utf8')).toContain('"n":19');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
