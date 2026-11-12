import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { PrismaExceptionFilter } from '../common/prisma-exception.filter';
import { normalizePath } from './access-log.middleware';
import { errorFields, writeLog } from './logger';

const prismaFilter = new PrismaExceptionFilter();
const MAPPED_PRISMA_CODES = new Set(['P2002', 'P2025', 'P2003']);

/**
 * Global exception filter. Responses are exactly what the API returned before
 * (Nest's default for HttpException and unknown errors, PrismaExceptionFilter for known
 * database errors); unexpected errors are also logged as event=unhandled_exception.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw e;
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    if (e instanceof HttpException) {
      if (res.headersSent) return;
      const body = e.getResponse();
      res.status(e.getStatus()).json(typeof body === 'object' ? body : { statusCode: e.getStatus(), message: body });
      return;
    }

    // Errors from Express middleware such as the JSON body parser (same reply as Nest's default filter).
    const httpError = e as { statusCode?: number; message?: string };
    if (httpError?.statusCode && httpError.message) {
      if (!res.headersSent) res.status(httpError.statusCode).json({ statusCode: httpError.statusCode, message: httpError.message });
      return;
    }

    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (!MAPPED_PRISMA_CODES.has(e.code)) this.logUnhandled(e, req);
      if (!res.headersSent) prismaFilter.catch(e, host);
      return;
    }

    this.logUnhandled(e, req);
    if (!res.headersSent) {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' });
    }
  }

  private logUnhandled(e: unknown, req: Request) {
    writeLog(
      'error',
      'Unhandled exception',
      { event: 'unhandled_exception', method: req.method, path: normalizePath(req.originalUrl || req.url), ...errorFields(e) },
      { logger: 'GlobalExceptionFilter' },
    );
  }
}
