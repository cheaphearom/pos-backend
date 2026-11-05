import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { createHash } from 'crypto';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC, ROLES, SCOPES } from './decorators';
import { Principal } from './principal';

/**
 * Global guard. Accepts either
 *  - `Authorization: Bearer <jwt>` (staff users), checked against @Roles, or
 *  - `X-API-Key: <key>` (integrations), checked against @Scopes.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const principal = apiKey ? await this.fromApiKey(apiKey) : await this.fromJwt(req.headers.authorization);

    if (principal.kind === 'user') {
      const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
      if (roles?.length && principal.role !== Role.SUPER_ADMIN && !roles.includes(principal.role!)) {
        throw new ForbiddenException('Your role cannot perform this action');
      }
    } else {
      const scopes = this.reflector.getAllAndOverride<string[] | undefined>(SCOPES, targets);
      if (!scopes?.length) throw new ForbiddenException('This endpoint is not available to API keys');
      if (!scopes.some((s) => principal.scopes.includes(s) || principal.scopes.includes('*'))) {
        throw new ForbiddenException(`API key needs one of the scopes: ${scopes.join(', ')}`);
      }
    }

    req.principal = principal;
    return true;
  }

  private async fromJwt(header?: string): Promise<Principal> {
    const [type, token] = (header ?? '').split(' ');
    if (type !== 'Bearer' || !token) throw new UnauthorizedException('Missing access token');
    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync(token, { secret: config.jwtAccessSecret });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    // Load fresh from DB so deactivated users and store re-assignments take effect immediately.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { stores: { select: { storeId: true } } },
    });
    if (!user || !user.isActive) throw new UnauthorizedException('User is inactive');
    return {
      kind: 'user',
      id: user.id,
      name: user.fullName,
      role: user.role,
      scopes: [],
      storeIds: user.role === Role.SUPER_ADMIN ? 'ALL' : user.stores.map((s) => s.storeId),
    };
  }

  private async fromApiKey(raw: string): Promise<Principal> {
    const keyHash = createHash('sha256').update(raw).digest('hex');
    const key = await this.prisma.apiKey.findUnique({ where: { keyHash } });
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date())) {
      throw new UnauthorizedException('Invalid API key');
    }
    // Do not block the request on this write.
    this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    return {
      kind: 'api_key',
      id: key.id,
      name: key.name,
      scopes: key.scopes,
      storeIds: key.storeId ? [key.storeId] : 'ALL',
    };
  }
}
