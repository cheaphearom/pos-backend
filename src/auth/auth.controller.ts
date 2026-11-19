// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import type { Request, Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentPrincipal, Public, Roles } from '../common/decorators';
import { Principal } from '../common/principal';
import { ChangePasswordDto, LoginDto, RefreshDto } from './auth.dto';
import { AuthService } from './auth.service';
import { DOCS_COOKIE, docsCookieOptions, signDocsToken } from './docs-access';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
  ) {}

  /** Log in with email and password. Returns an access token and a refresh token. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) // slow down password guessing
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /** Exchange a refresh token for a new token pair. */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  /** The logged-in user and the stores they can work in. */
  @ApiBearerAuth()
  @Get('me')
  me(@CurrentPrincipal() p: Principal) {
    return this.auth.me(p.id);
  }

  @ApiBearerAuth()
  @Post('change-password')
  @HttpCode(204)
  changePassword(@CurrentPrincipal() p: Principal, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(p.id, dto.currentPassword, dto.newPassword);
  }

  /** Opens the API docs (/docs) in this browser for 1 hour: sets an HttpOnly cookie. Super admins only. */
  @ApiBearerAuth()
  @Roles(Role.SUPER_ADMIN)
  @Post('docs-session')
  @HttpCode(204)
  async docsSession(@CurrentPrincipal() p: Principal, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (p.kind !== 'user' || p.role !== Role.SUPER_ADMIN) throw new ForbiddenException('API docs are for super admins only');
    res.cookie(DOCS_COOKIE, await signDocsToken(this.jwt, p.id), docsCookieOptions(req));
  }
}
