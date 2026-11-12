import { AuditService } from '../audit/audit.module';
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { config, REPORT_TIMEZONE } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { logEvent } from '../logging/logger';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Same message for unknown email and wrong password, so attackers cannot discover accounts.
    if (!user || !user.isActive || !(await bcrypt.compare(password, user.passwordHash))) {
      logEvent('warn', 'login_failed', 'Login failed', { reason: !user ? 'unknown_user' : !user.isActive ? 'inactive_user' : 'wrong_password' });
      this.audit.add(null, { action: 'LOGIN_FAILED', entityType: 'user', entityId: user?.id ?? null, summary: `Failed login for ${email.toLowerCase().slice(0, 150)}${user && !user.isActive ? ' (inactive user)' : ''}` });
      throw new UnauthorizedException('Invalid email or password');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    this.audit.add({ kind: 'user', id: user.id, name: user.fullName, role: user.role, scopes: [], storeIds: [] }, { action: 'LOGIN', entityType: 'user', entityId: user.id, summary: `${user.fullName} logged in` });
    return this.issueTokens(user.id);
  }

  /** Rotates the refresh token: the old one is revoked and a new pair is issued. */
  async refresh(refreshToken: string) {
    const token = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      include: { user: true },
    });
    if (!token || token.expiresAt < new Date() || !token.user.isActive) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (token.revokedAt) {
      // A revoked token is being reused: it was probably stolen. Log the user out everywhere.
      await this.revokeAll(token.userId);
      throw new UnauthorizedException('Refresh token reuse detected; please log in again');
    }
    await this.prisma.refreshToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(token.userId);
  }

  async logout(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true, email: true, fullName: true, phone: true, role: true, lastLoginAt: true,
        stores: { select: { store: { select: { id: true, code: true, name: true } } } },
      },
    });
    return { ...user, stores: user.stores.map((s) => s.store), timezone: REPORT_TIMEZONE };
  }

  async changePassword(userId: string, current: string, next: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(current, user.passwordHash))) {
      throw new BadRequestException('Current password is wrong');
    }
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(next, 10) } });
    await this.revokeAll(userId);
  }

  private revokeAll(userId: string) {
    return this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  private async issueTokens(userId: string) {
    const accessToken = await this.jwt.signAsync(
      { sub: userId },
      { secret: config.jwtAccessSecret, expiresIn: config.jwtAccessTtl as any },
    );
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + config.jwtRefreshTtlDays * 86_400_000),
      },
    });
    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: config.jwtAccessTtl };
  }
}
