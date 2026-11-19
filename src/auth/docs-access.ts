// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
/**
 * The API docs (/docs, /docs-json, /docs-yaml) are for super admins only.
 *
 * A browser opening /docs sends no Bearer token, so the POS first calls POST /api/v1/auth/docs-session
 * (super admin only). That sets a short-lived HttpOnly cookie, and the gate below checks it on every docs request:
 * a valid docs token, for a user who is still active and still a super admin. Anyone else gets a 403 page.
 */
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';

export const DOCS_COOKIE = 'pos_docs';
export const DOCS_TTL_SECONDS = 60 * 60; // 1 hour
const DOCS_AUDIENCE = 'api-docs';
const DOCS_PATH = /^\/docs(-json|-yaml)?(\/|$)/;

export function signDocsToken(jwt: JwtService, userId: string) {
  return jwt.signAsync({ sub: userId }, { secret: config.jwtAccessSecret, audience: DOCS_AUDIENCE, expiresIn: DOCS_TTL_SECONDS });
}

/** Cookie options: HttpOnly, same site only, Secure when the request came over HTTPS. */
export function docsCookieOptions(req: Request) {
  return { httpOnly: true, sameSite: 'strict' as const, secure: req.secure, path: '/', maxAge: DOCS_TTL_SECONDS * 1000 };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

const DENIED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API docs</title><style>body{font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 16px;color:#222}
h1{font-size:22px}a{color:#6b3e1f}</style></head><body><h1>API docs are for super admins only</h1>
<p>Sign in to the POS as a super admin, then open <b>Integrations → Open API docs</b>.</p>
<p>The docs stay open for 1 hour after that.</p><p><a href="/">Go to the POS</a></p></body></html>`;

/** Express middleware: lets super admins through to the docs, refuses everyone else. Other paths pass untouched. */
export function docsGate(jwt: JwtService, prisma: PrismaService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!DOCS_PATH.test(req.path)) return next();
    const token = readCookie(req.headers.cookie, DOCS_COOKIE);
    let ok = false;
    if (token) {
      try {
        const payload = await jwt.verifyAsync<{ sub: string }>(token, { secret: config.jwtAccessSecret, audience: DOCS_AUDIENCE });
        const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isActive: true, role: true } });
        ok = !!user && user.isActive && user.role === Role.SUPER_ADMIN;
      } catch {
        ok = false;
      }
    }
    if (ok) {
      res.setHeader('Cache-Control', 'no-store');
      return next();
    }
    res.status(403).setHeader('Cache-Control', 'no-store');
    if (req.path === '/docs' || req.path === '/docs/') res.type('html').send(DENIED_PAGE);
    else res.json({ statusCode: 403, message: 'API docs are for super admins only' });
  };
}
