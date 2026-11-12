import { LoggerService } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import pino, { Logger as Pino } from 'pino';
import { RotatingFile } from './rotating-file';

/**
 * Structured JSON logs, in the same format as the e-commerce services, so the ML detector
 * (monitoring/ml-detector) can read them:
 *
 *   {"@timestamp":"…","level":"INFO","service":"pos-api","logger_name":"HttpAccess",
 *    "message":"HTTP request event=http_request method=POST path=/api/v1/sales status=201 durationMs=42",
 *    "event":"http_request","method":"POST","path":"/api/v1/sales","status":201,"durationMs":42,"traceId":"…"}
 *
 * Lines go to stdout and to ${LOG_DIR:-./logs}/pos-api.log (rotated daily and by size).
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Fields = Record<string, unknown>;

/** Request id of the current HTTP request (or BullMQ job), added to every line as traceId. */
export const logContext = new AsyncLocalStorage<{ traceId: string }>();

// ─── Privacy ─────────────────────────────────────────────────────────────────

/** Field names whose values are never written: passwords, tokens, keys, PINs, card / wallet numbers, phone, email. */
const SENSITIVE_KEY =
  /pass(word|wd)?|secret|token|authori[sz]ation|cookie|api[-_]?key|^pin$|pin([-_]?(hash|code))?$|otp|signature|card[-_]?(no|num|number)$|^card$|wallet[-_]?(no|num|number)$|serial|phone|e-?mail|^code$/i;

const TEXT_RULES: [RegExp, string][] = [
  [/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, '[email]'], // e-mail addresses
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]'], // JWTs
  [/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 [token]'],
  [/\b(pos|whsec|sk|pk)_[\w-]{12,}/g, '[secret]'], // API keys, webhook secrets
  [/[\w-]{40,}/g, '[token]'], // long random strings (refresh tokens, base64 secrets)
  [/(?<![\w-])\+?\d{8,}(?![\w-])/g, '[number]'], // card / wallet / phone numbers (not digits inside ids or hashes)
  [/(\+855|\b0)\d{1,2}[ -]\d{3}[ -]\d{3,4}\b/g, '[number]'], // phone numbers with spaces
];

/** Masks e-mails, tokens, keys and long numbers (cards, wallets, phones) in free text. */
export function scrubText(s: string): string {
  let out = s;
  for (const [re, by] of TEXT_RULES) out = out.replace(re, by);
  return out;
}

/** Copy of `fields` without sensitive values. Strings are scrubbed; nested objects are not logged. */
export function sanitize(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (SENSITIVE_KEY.test(k)) continue;
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = scrubText(v);
    else if (typeof v === 'bigint') out[k] = v.toString();
    else if (typeof (v as any)?.toFixed === 'function') out[k] = Number(v); // Prisma.Decimal
    else if (v instanceof Date) out[k] = v.toISOString();
    // objects and arrays are skipped on purpose: they could carry personal data
  }
  return out;
}

const kvValue = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 300) : String(v));

/** "key=value key=value", like logstash StructuredArguments.kv(...) in the e-commerce services. */
export function kv(fields: Fields): string {
  return Object.entries(fields)
    .filter(([k, v]) => v !== undefined && v !== null && k !== 'stack_trace')
    .map(([k, v]) => `${k}=${kvValue(v)}`)
    .join(' ');
}

// ─── Destinations ────────────────────────────────────────────────────────────

function makeLogger(service: string, dest: pino.DestinationStream, level: string): Pino {
  return pino(
    {
      level,
      messageKey: 'message',
      base: { service },
      timestamp: () => `,"@timestamp":"${new Date().toISOString()}"`,
      formatters: { level: (label) => ({ level: label.toUpperCase() }) },
      mixin: () => {
        const ctx = logContext.getStore();
        return ctx ? { traceId: ctx.traceId } : {};
      },
    },
    dest,
  );
}

type Root = { api: Pino; worker: Pino; file: RotatingFile | null };
let root: Root | null = null;

function buildRoot(): Root {
  const dir = process.env.LOG_DIR || './logs';
  const toFile = process.env.LOG_TO_FILE !== 'false' && process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID;
  let file: RotatingFile | null = null;
  if (toFile) {
    try {
      file = new RotatingFile(dir, 'pos-api', {
        maxBytes: Number(process.env.LOG_MAX_MB || 100) * 1024 * 1024,
        maxFiles: Number(process.env.LOG_MAX_FILES || 14),
      });
    } catch (e) {
      process.stderr.write(`Cannot write logs to ${dir}: ${(e as Error).message}\n`);
    }
  }
  const streams: pino.StreamEntry[] = [{ level: 'debug', stream: process.stdout }];
  if (file) streams.push({ level: 'debug', stream: file });
  const dest = pino.multistream(streams);
  const level = (process.env.LOG_LEVEL || 'info').toLowerCase();
  const make = (service: string) => makeLogger(service, dest, level);
  return { api: make('pos-api'), worker: make('pos-worker'), file };
}

function getRoot(): Root {
  return (root ??= buildRoot());
}

/** For tests: send every line to `write` instead of stdout / file. */
export function setLogSinkForTests(write: ((line: string) => void) | null) {
  if (!write) {
    root = null;
    return;
  }
  const stream = { write: (s: string) => (write(s), true) };
  const make = (service: string) => makeLogger(service, stream as any, 'debug');
  root = { api: make('pos-api'), worker: make('pos-worker'), file: null };
}

// ─── Writing ─────────────────────────────────────────────────────────────────

export interface LogOptions {
  service?: 'pos-api' | 'pos-worker';
  logger?: string;
}

/**
 * One structured line. `text` starts the message; the fields are appended as key=value and
 * also written as JSON fields (stack_trace only as a field).
 */
export function writeLog(level: Level, text: string, fields: Fields = {}, opts: LogOptions = {}) {
  try {
    const r = getRoot();
    const logger = opts.service === 'pos-worker' ? r.worker : r.api;
    const safe = sanitize(fields);
    const pairs = kv(safe);
    const message = scrubText(pairs ? `${text} ${pairs}` : text);
    logger[level]({ logger_name: opts.logger ?? 'App', ...safe }, message);
    if (typeof safe.event === 'string') for (const fn of eventListeners) fn(safe.event, safe);
  } catch {
    /* logging must never break a request */
  }
}

type EventListener = (event: string, fields: Fields) => void;
const eventListeners = new Set<EventListener>();

/** Called for every logged line that has an `event` (used by the in-memory monitoring metrics). */
export function onLogEvent(fn: EventListener): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

/** Store names by id, so every event with a storeId also names the store (the detector's alerts show it). */
const storeNames = new Map<string, string>();
export function rememberStoreName(id: string, name: string) {
  if (id && name) storeNames.set(id, name);
}

/** A business or technical event: `event=<name>` plus safe fields (and storeName when storeId is known). */
export function logEvent(level: Level, event: string, text: string, fields: Fields = {}, opts: LogOptions = {}) {
  const id = typeof fields.storeId === 'string' ? fields.storeId : undefined;
  const named = id && !fields.storeName && storeNames.has(id) ? { storeName: storeNames.get(id) } : {};
  writeLog(level, text, { event, ...fields, ...named }, { logger: 'BusinessEvent', ...opts });
}

/** Error fields in the e-commerce format: exception (class name), errorMessage, stack_trace. */
export function errorFields(e: unknown): Fields {
  const err = e instanceof Error ? e : new Error(String(e));
  return {
    exception: err.constructor?.name || 'Error',
    errorMessage: err.message.slice(0, 500),
    stack_trace: err.stack ? scrubText(err.stack).slice(0, 4000) : undefined,
  };
}

/** Nest's LoggerService: Nest's own messages and `new Logger(ctx)` calls become JSON lines too. */
export class JsonNestLogger implements LoggerService {
  log(message: any, ...rest: any[]) {
    this.write('info', message, rest);
  }
  warn(message: any, ...rest: any[]) {
    this.write('warn', message, rest);
  }
  error(message: any, ...rest: any[]) {
    // Nest calls error(message, stack?, context?)
    const ctx = rest.length ? rest[rest.length - 1] : undefined;
    const stack = rest.length > 1 ? rest[0] : undefined;
    writeLog('error', String(message instanceof Error ? message.message : message), typeof stack === 'string' ? { stack_trace: scrubText(stack) } : {}, {
      logger: typeof ctx === 'string' ? ctx : 'App',
    });
  }
  debug(message: any, ...rest: any[]) {
    this.write('debug', message, rest);
  }
  verbose(message: any, ...rest: any[]) {
    this.write('debug', message, rest);
  }
  fatal(message: any, ...rest: any[]) {
    this.write('error', message, rest);
  }
  private write(level: Level, message: any, rest: any[]) {
    const ctx = rest.length ? rest[rest.length - 1] : undefined;
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    writeLog(level, text, {}, { logger: typeof ctx === 'string' ? ctx : 'App' });
  }
}
