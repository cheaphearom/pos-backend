import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentPrincipal, Public } from '../common/decorators';
import { Principal } from '../common/principal';
import { ChangePasswordDto, LoginDto, RefreshDto } from './auth.dto';
import { AuthService } from './auth.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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
}
