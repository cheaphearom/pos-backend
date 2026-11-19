// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { JwtService } from '@nestjs/jwt';
import { docsGate, readCookie, signDocsToken } from './docs-access';

const run = async (gate: ReturnType<typeof docsGate>, path: string, cookie?: string) => {
  const res: any = { code: 200, headers: {}, status(c: number) { this.code = c; return this; }, setHeader(k: string, v: string) { this.headers[k] = v; return this; }, type() { return this; }, send() { return this; }, json() { return this; } };
  let passed = false;
  await gate({ path, headers: { cookie } } as any, res, () => { passed = true; });
  return passed ? 'next' : res.code;
};

describe('API docs gate', () => {
  const jwt = new JwtService();
  const users: Record<string, any> = { admin: { isActive: true, role: 'SUPER_ADMIN' }, mgr: { isActive: true, role: 'STORE_MANAGER' }, old: { isActive: false, role: 'SUPER_ADMIN' } };
  const prisma: any = { user: { findUnique: async ({ where }: any) => users[where.id] ?? null } };
  const gate = docsGate(jwt, prisma);

  it('reads one cookie among several', () => {
    expect(readCookie('a=1; pos_docs=x%20y; b=2', 'pos_docs')).toBe('x y');
    expect(readCookie(undefined, 'pos_docs')).toBeUndefined();
  });

  it('lets other paths through', async () => {
    expect(await run(gate, '/api/v1/products')).toBe('next');
    expect(await run(gate, '/docsomething')).toBe('next');
  });

  it('lets only an active super admin with a docs token see the docs', async () => {
    expect(await run(gate, '/docs')).toBe(403);
    expect(await run(gate, '/docs-json', 'pos_docs=nope')).toBe(403);
    expect(await run(gate, '/docs/', `pos_docs=${await signDocsToken(jwt, 'admin')}`)).toBe('next');
    expect(await run(gate, '/docs-json', `pos_docs=${await signDocsToken(jwt, 'mgr')}`)).toBe(403);
    expect(await run(gate, '/docs', `pos_docs=${await signDocsToken(jwt, 'old')}`)).toBe(403);
  });

  it('refuses a normal login token used as the docs cookie', async () => {
    const access = await jwt.signAsync({ sub: 'admin' }, { secret: process.env.JWT_ACCESS_SECRET ?? 'change-me-access-secret' });
    expect(await run(gate, '/docs', `pos_docs=${access}`)).toBe(403);
  });
});
