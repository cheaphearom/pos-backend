import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { logContext, writeLog } from './logger';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_REQUEST_ID = /^[\w.:-]{8,128}$/;

/** Paths that are not access-logged: health checks and the monitoring page's own polling. */
export const SKIP_ACCESS_LOG = [/^\/health(\/|$)/, /^\/api\/v1\/monitoring(\/|$)/];

/**
 * Replaces ids in a path with {id}: UUIDs, numbers, receipt numbers (S-PP01-…), barcodes,
 * KHQR hashes, tokens. Words like "v1", "sales", "barcode" are kept.
 */
export function normalizePath(path: string): string {
  const clean = path.split('?')[0].replace(/\/{2,}/g, '/');
  return (
    clean
      .split('/')
      .map((seg) => {
        if (!seg) return seg;
        if (UUID.test(seg) || /^\d+$/.test(seg)) return '{id}';
        if (/^v\d+$/i.test(seg)) return seg; // api version
        if (/\d/.test(seg) && seg.length >= 4) return '{id}'; // receipt numbers, barcodes, SKUs, codes like PP01
        if (seg.length >= 20) return '{id}'; // tokens, hashes
        return seg;
      })
      .join('/') || '/'
  );
}

/** Route pattern Express matched (`/api/v1/sales/:id` → `/api/v1/sales/{id}`), or the normalized URL. */
function routeOf(req: Request): string {
  const route = (req as any).route?.path;
  if (typeof route === 'string') {
    return normalizePath(((req.baseUrl || '') + route).replace(/:\w+/g, '{id}'));
  }
  return normalizePath(req.originalUrl || req.url);
}

/**
 * One line per HTTP request: event=http_request method path status durationMs traceId.
 * INFO for 2xx/3xx, WARN for 4xx, ERROR for 5xx. Also sets the request id for every log line
 * written while the request runs, and returns it in the X-Request-Id header.
 */
export function accessLog(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  const traceId = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID().replace(/-/g, '');
  res.setHeader('X-Request-Id', traceId);
  const skip = SKIP_ACCESS_LOG.some((re) => re.test(req.path));
  const start = process.hrtime.bigint();

  if (!skip) {
    res.on('finish', () => {
      const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
      const status = res.statusCode;
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      logContext.run({ traceId }, () =>
        writeLog(level, 'HTTP request', { event: 'http_request', method: req.method, path: routeOf(req), status, durationMs }, { logger: 'HttpAccess' }),
      );
    });
  }
  logContext.run({ traceId }, () => next());
}
