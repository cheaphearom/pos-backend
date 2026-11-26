// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
/**
 * `@Audit(action, describe)` on a controller method writes an audit log entry after the request succeeds
 * (who: the logged-in user or API key; when; which store; a readable summary), so admin actions are recorded
 * without audit code inside every service. A failed request writes nothing.
 *
 * `load` (optional) runs BEFORE the action, e.g. to keep the name of something that is about to be deleted.
 * `describe` gets the request body, route params, query, the result and what `load` returned, and returns the
 * entry (or null to skip). Never put secrets in it (API keys, PINs, passwords).
 */
import { CallHandler, ExecutionContext, forwardRef, Inject, Injectable, Logger, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, Observable, switchMap, tap } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
// audit.module.ts imports this file too: AuditService is reached lazily (forwardRef)
import type { AuditEntry } from './audit.module';
import { AuditService } from './audit.module';

export interface AuditCtx {
  body: any;
  params: Record<string, string>;
  query: any;
  result: any;
  before: any;
}
type Entry = Omit<AuditEntry, 'action'> & { action?: string };
interface AuditMeta {
  action: string;
  describe: (c: AuditCtx) => Entry | null;
  load?: (prisma: PrismaService, c: Omit<AuditCtx, 'result' | 'before'>) => Promise<unknown>;
}

const AUDIT_META = 'audit:entry';

export const Audit = (action: string, describe: AuditMeta['describe'], load?: AuditMeta['load']) =>
  SetMetadata(AUDIT_META, { action, describe, load } satisfies AuditMeta);

/** "name, price, isActive" — the fields a request changed (for summaries). */
export const fieldsOf = (body: unknown) =>
  body && typeof body === 'object' && !Buffer.isBuffer(body) ? Object.keys(body as object).filter((k) => !/pin|password|secret|token|key$/i.test(k)).join(', ') : '';

/** A copy of the body without secrets, for `details`. */
export const safeBody = (body: unknown) => {
  if (!body || typeof body !== 'object' || Buffer.isBuffer(body)) return undefined;
  return Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([k]) => !/pin|password|secret|token|key$/i.test(k)));
};

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly log = new Logger('Audit');

  constructor(
    private readonly reflector: Reflector,
    @Inject(forwardRef(() => AuditService)) private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditMeta | undefined>(AUDIT_META, ctx.getHandler());
    if (!meta || ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest();
    const base = { body: req.body, params: req.params ?? {}, query: req.query ?? {} };
    const before$ = from(meta.load ? meta.load(this.prisma, base).catch(() => null) : Promise.resolve(null));
    return before$.pipe(
      switchMap((before) =>
        next.handle().pipe(
          tap((result) => {
            try {
              const e = meta.describe({ ...base, result, before });
              if (e) this.audit.add(req.principal ?? null, { ...e, action: e.action ?? meta.action, summary: e.summary });
            } catch (err) {
              this.log.error(`Audit entry for ${meta.action} not written: ${(err as Error).message}`);
            }
          }),
        ),
      ),
    );
  }
}
