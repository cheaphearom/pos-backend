import {
  BadRequestException, Body, CanActivate, Controller, createParamDecorator, ExecutionContext, Get, HttpCode, Injectable, Logger, Module,
  Ip, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, ServiceUnavailableException, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Customer } from '@prisma/client';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { Public } from '../common/decorators';
import { PageQueryDto, pageArgs, toPage } from '../common/pagination';
import { config, memberConfig } from '../config';
import { newMemberCode } from '../customers/customers.service';
import { normalizePhone } from '../customers/phone';
import { PrismaService } from '../prisma/prisma.service';

/*
 * Member app: customers log in with their phone number and a one-time code,
 * then see their points, wallet cards and orders, and order ahead with their account.
 * Member tokens are signed with their own secret, so they never work on staff endpoints.
 */

const PHONE = /^\d{8,15}$/;
const MAX_TRIES = 5;
const RESEND_SECONDS = 45;
const CODES_PER_HOUR = 5;

export class OtpRequestDto {
  @IsString() @MaxLength(30)
  phone: string;
}

export class OtpVerifyDto extends OtpRequestDto {
  @Matches(/^\d{6}$/, { message: 'The code has 6 digits' })
  code: string;

  /** Only for new members */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(150)
  name?: string;
}

export class UpdateMeDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(150)
  name?: string;

  @IsOptional() @IsEmail()
  email?: string;
}

type MemberClaims = { sub: string; ver: number; typ: 'member' };

@Injectable()
export class MemberAuthService {
  private readonly log = new Logger('MemberAuth');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  private phoneOrFail(raw: string) {
    const phone = normalizePhone(raw);
    if (!phone || !PHONE.test(phone)) throw new BadRequestException('Please enter a valid phone number');
    return phone;
  }

  private hash(phone: string, code: string) {
    return createHmac('sha256', memberConfig.jwtSecret).update(`${phone}:${code}`).digest('hex');
  }

  async requestCode(raw: string, ip?: string) {
    const phone = this.phoneOrFail(raw);
    const hourAgo = new Date(Date.now() - 3600_000);
    const recent = await this.prisma.memberOtp.findMany({ where: { phone, createdAt: { gte: hourAgo } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    if (recent.length) {
      const wait = RESEND_SECONDS - Math.floor((Date.now() - recent[0].createdAt.getTime()) / 1000);
      if (wait > 0) throw new BadRequestException(`Please wait ${wait} seconds before asking for another code`);
    }
    if (recent.length >= CODES_PER_HOUR) throw new BadRequestException('Too many codes for this number. Try again in an hour.');

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.send(phone, code);
    // Older codes stop working once a new one is sent.
    await this.prisma.memberOtp.updateMany({ where: { phone, usedAt: null }, data: { usedAt: new Date() } });
    await this.prisma.memberOtp.create({
      data: { phone, codeHash: this.hash(phone, code), expiresAt: new Date(Date.now() + memberConfig.otpMinutes * 60_000), ip: ip?.slice(0, 64) },
    });
    return { sent: true, phone, expiresInMinutes: memberConfig.otpMinutes, ...(memberConfig.otpMode === 'dev' && { devCode: code }) };
  }

  private async send(phone: string, code: string) {
    const message = `${code} is your ${memberConfig.brand} login code. It expires in ${memberConfig.otpMinutes} minutes. Do not share it.`;
    if (memberConfig.otpMode === 'dev') {
      this.log.warn(`[dev] login code for ${phone}: ${code}`);
      return;
    }
    if (!memberConfig.otpWebhookUrl) throw new ServiceUnavailableException('Login by SMS is not set up yet (MEMBER_OTP_WEBHOOK_URL)');
    try {
      const res = await fetch(memberConfig.otpWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(memberConfig.otpWebhookSecret && { Authorization: `Bearer ${memberConfig.otpWebhookSecret}` }) },
        body: JSON.stringify({ phone, code, message, expiresInMinutes: memberConfig.otpMinutes }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      this.log.error(`Could not send login code to ${phone}: ${(e as Error).message}`);
      throw new ServiceUnavailableException('Could not send the code right now. Please try again.');
    }
  }

  async verify(dto: OtpVerifyDto) {
    const phone = this.phoneOrFail(dto.phone);
    const otp = await this.prisma.memberOtp.findFirst({ where: { phone, usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    if (!otp || otp.attempts >= MAX_TRIES) throw new BadRequestException('This code has expired. Ask for a new one.');
    const ok = timingSafeEqual(Buffer.from(otp.codeHash, 'hex'), Buffer.from(this.hash(phone, dto.code), 'hex'));
    if (!ok) {
      // Count the try atomically so parallel guesses cannot go over the limit.
      const n = await this.prisma.memberOtp.updateMany({ where: { id: otp.id, attempts: { lt: MAX_TRIES } }, data: { attempts: { increment: 1 } } });
      const left = MAX_TRIES - otp.attempts - 1;
      throw new BadRequestException(!n.count || left <= 0 ? 'Wrong code. Ask for a new one.' : `Wrong code (${left} ${left === 1 ? 'try' : 'tries'} left)`);
    }

    let customer = await this.prisma.customer.findUnique({ where: { phone } });
    if (customer && !customer.isActive) throw new BadRequestException('This membership is closed. Please contact the store.');
    // New member: ask for a name first; the code stays valid for that second call.
    if (!customer && !dto.name?.trim()) return { needName: true };

    const used = await this.prisma.memberOtp.updateMany({ where: { id: otp.id, usedAt: null }, data: { usedAt: new Date() } });
    if (!used.count) throw new BadRequestException('This code was already used. Ask for a new one.');

    const now = new Date();
    if (!customer) {
      try {
        customer = await this.prisma.customer.create({ data: { code: newMemberCode(), name: dto.name!.trim(), phone, appJoinedAt: now, appLastSeenAt: now } });
      } catch {
        customer = await this.prisma.customer.findUniqueOrThrow({ where: { phone } }); // created at the same moment by another call
      }
    } else {
      customer = await this.prisma.customer.update({ where: { id: customer.id }, data: { appJoinedAt: customer.appJoinedAt ?? now, appLastSeenAt: now } });
    }
    const claims: MemberClaims = { sub: customer.id, ver: customer.appTokenVersion, typ: 'member' };
    const token = await this.jwt.signAsync(claims, { secret: memberConfig.jwtSecret, expiresIn: `${memberConfig.tokenDays}d` });
    return { token, member: { id: customer.id, name: customer.name, code: customer.code, phone: customer.phone } };
  }

  /** The logged-in member, or null when there is no (valid) member token. */
  async fromHeader(header?: string): Promise<Customer | null> {
    const [type, token] = (header ?? '').split(' ');
    if (type !== 'Bearer' || !token) return null;
    let claims: MemberClaims;
    try {
      claims = await this.jwt.verifyAsync<MemberClaims>(token, { secret: memberConfig.jwtSecret });
    } catch {
      return null;
    }
    if (claims.typ !== 'member') return null;
    const c = await this.prisma.customer.findUnique({ where: { id: claims.sub } });
    if (!c || !c.isActive || c.appTokenVersion !== claims.ver) return null;
    if (!c.appLastSeenAt || Date.now() - c.appLastSeenAt.getTime() > 3600_000) {
      this.prisma.customer.update({ where: { id: c.id }, data: { appLastSeenAt: new Date() } }).catch(() => undefined);
    }
    return c;
  }
}

/** Requires a member token (the route must also be @Public so the staff guard lets it through). */
@Injectable()
export class MemberGuard implements CanActivate {
  constructor(private readonly auth: MemberAuthService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const member = await this.auth.fromHeader(req.headers.authorization);
    if (!member) throw new UnauthorizedException('Please log in again');
    req.member = member;
    return true;
  }
}

export const CurrentMember = createParamDecorator((_: unknown, ctx: ExecutionContext): Customer => ctx.switchToHttp().getRequest().member);

const cardView = { id: true, cardNumber: true, serialNumber: true, status: true, balance: true, pinHash: true, lastUsedAt: true, activatedAt: true } as const;

@Injectable()
export class MemberService {
  constructor(private readonly prisma: PrismaService) {}

  async me(c: Customer) {
    const cards = await this.prisma.walletCard.findMany({ where: { customerId: c.id, status: { in: ['ACTIVE', 'BLOCKED'] } }, select: cardView, orderBy: { activatedAt: 'asc' } });
    return {
      id: c.id, code: c.code, name: c.name, phone: c.phone, email: c.email,
      points: c.points, pointValue: config.loyaltyPointValue, earnRate: config.loyaltyEarnRate,
      pointsWorth: Math.floor(c.points * config.loyaltyPointValue * 100) / 100,
      totalSpent: c.totalSpent, visitCount: c.visitCount, memberSince: c.createdAt,
      cards: cards.map(({ pinHash, ...k }) => ({ ...k, hasPin: !!pinHash })),
    };
  }

  async update(c: Customer, dto: UpdateMeDto) {
    const u = await this.prisma.customer.update({ where: { id: c.id }, data: { name: dto.name?.trim(), email: dto.email } });
    return this.me(u);
  }

  async logoutEverywhere(c: Customer) {
    await this.prisma.customer.update({ where: { id: c.id }, data: { appTokenVersion: { increment: 1 } } });
    return { ok: true };
  }

  async points(c: Customer, q: PageQueryDto) {
    const where = { customerId: c.id };
    const [rows, total] = await Promise.all([
      this.prisma.loyaltyTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q), select: { id: true, type: true, points: true, balanceAfter: true, note: true, createdAt: true, saleId: true } }),
      this.prisma.loyaltyTransaction.count({ where }),
    ]);
    return toPage(rows.map((r) => ({ ...r, id: String(r.id) })), total, q);
  }

  async cardTransactions(c: Customer, cardId: string, q: PageQueryDto) {
    const card = await this.prisma.walletCard.findFirst({ where: { id: cardId, customerId: c.id }, select: { id: true } });
    if (!card) throw new NotFoundException('Card not found');
    const where = { cardId };
    const [rows, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q), select: { id: true, type: true, amount: true, balanceAfter: true, reference: true, createdAt: true } }),
      this.prisma.walletTransaction.count({ where }),
    ]);
    return toPage(rows.map((r) => ({ ...r, id: String(r.id) })), total, q);
  }

  async orders(c: Customer, q: PageQueryDto) {
    const where = { customerId: c.id };
    const [rows, total] = await Promise.all([
      this.prisma.sale.findMany({
        where, orderBy: { createdAt: 'desc' }, ...pageArgs(q),
        select: {
          id: true, receiptNo: true, status: true, channel: true, orderType: true, queueNo: true, total: true, amountDue: true,
          pointsEarned: true, pointsRedeemed: true, createdAt: true, store: { select: { code: true, name: true } },
          items: { select: { name: true, nameKm: true, quantity: true }, orderBy: { lineNo: 'asc' } },
        },
      }),
      this.prisma.sale.count({ where }),
    ]);
    return toPage(rows.map(({ items, ...s }) => ({ ...s, itemCount: items.reduce((n, i) => n + Number(i.quantity), 0), summary: items.slice(0, 3).map((i) => i.name).join(', ') + (items.length > 3 ? '…' : ''), summaryKm: items.slice(0, 3).map((i) => i.nameKm || i.name).join(', ') + (items.length > 3 ? '…' : '') })), total, q);
  }

  async order(c: Customer, id: string) {
    const s = await this.prisma.sale.findFirst({
      where: { id, customerId: c.id },
      select: {
        id: true, receiptNo: true, status: true, channel: true, orderType: true, tableNo: true, queueNo: true, kitchenStatus: true,
        subtotal: true, discountTotal: true, taxTotal: true, total: true, pointsDiscount: true, pointsRedeemed: true, amountDue: true, pointsEarned: true,
        couponName: true, createdAt: true, store: { select: { code: true, name: true, address: true, currency: true } },
        items: { orderBy: { lineNo: 'asc' }, select: { productId: true, name: true, nameKm: true, quantity: true, unitPrice: true, lineTotal: true, discount: true, modifiers: true, note: true, refundedQty: true } },
        payments: { select: { method: true, amount: true } },
      },
    });
    if (!s) throw new NotFoundException('Order not found');
    return s;
  }

  /** Online orders from the last two days, with the status page link token and progress. */
  async onlineOrders(c: Customer) {
    const rows = await this.prisma.onlineOrder.findMany({
      where: { customerId: c.id, createdAt: { gte: new Date(Date.now() - 2 * 86_400_000) } },
      orderBy: { createdAt: 'desc' }, take: 10,
      select: { token: true, status: true, total: true, orderType: true, tableNo: true, createdAt: true, saleId: true, storeId: true },
    });
    const [sales, stores] = await Promise.all([
      this.prisma.sale.findMany({ where: { id: { in: rows.map((r) => r.saleId).filter(Boolean) as string[] } }, select: { id: true, queueNo: true, kitchenStatus: true } }),
      this.prisma.store.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.storeId))] } }, select: { id: true, code: true, name: true } }),
    ]);
    return rows.map(({ saleId, storeId, ...o }) => {
      const sale = sales.find((x) => x.id === saleId);
      return { ...o, store: stores.find((x) => x.id === storeId), queueNo: sale?.queueNo ?? null, kitchenStatus: sale?.kitchenStatus ?? null };
    });
  }

  /** Stores that take online orders (for the "order ahead" store picker). */
  onlineStores() {
    return this.prisma.store.findMany({
      where: { isActive: true, onlineOrdering: true },
      select: { code: true, name: true, address: true, phone: true },
      orderBy: { name: 'asc' },
    });
  }
}

@ApiTags('Member app')
@Controller()
export class MemberController {
  constructor(
    private readonly auth: MemberAuthService,
    private readonly members: MemberService,
  ) {}

  // Per address: generous, because customers in a café share one Wi-Fi address.
  // Each phone number is also limited (one code per 45 s, 5 per hour) in the service.
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('public/member/otp')
  otp(@Body() dto: OtpRequestDto, @Ip() ip: string) {
    return this.auth.requestCode(dto.phone, ip);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('public/member/verify')
  verify(@Body() dto: OtpVerifyDto) {
    return this.auth.verify(dto);
  }

  @Public()
  @Get('public/stores')
  stores() {
    return this.members.onlineStores();
  }

  @Public() @UseGuards(MemberGuard) @ApiBearerAuth()
  @Get('member/me')
  me(@CurrentMember() c: Customer) {
    return this.members.me(c);
  }

  @Public() @UseGuards(MemberGuard) @ApiBearerAuth()
  @Patch('member/me')
  update(@CurrentMember() c: Customer, @Body() dto: UpdateMeDto) {
    return this.members.update(c, dto);
  }

  /** Log out on every phone (e.g. a lost phone). */
  @Public() @UseGuards(MemberGuard) @ApiBearerAuth()
  @HttpCode(200)
  @Post('member/logout-all')
  logoutAll(@CurrentMember() c: Customer) {
    return this.members.logoutEverywhere(c);
  }

  @Public() @UseGuards(MemberGuard) @ApiBearerAuth()
  @Get('member/points')
  points(@CurrentMember() c: Customer, @Query() q: PageQueryDto) {
    return this.members.points(c, q);
  }

  @Public() @UseGuards(MemberGuard) @ApiBearerAuth()
  @Get('member/cards/:id/transactions')
  cardTx(@CurrentMember() c: Customer, @Param('id', ParseUUIDPipe) id: string, @Query() q: PageQueryDto) {
    return this.members.cardTransactions(c, id, q);
  }

  @Public() @UseGuards(MemberGuard) @ApiBearerAuth()
  @Get('member/orders')
  orders(@CurrentMember() c: Customer, @Query() q: PageQueryDto) {
    return this.members.orders(c, q);
  }

  @Public() @UseGuards(MemberGuard) @ApiBearerAuth()
  @Get('member/orders/:id')
  order(@CurrentMember() c: Customer, @Param('id', ParseUUIDPipe) id: string) {
    return this.members.order(c, id);
  }

  @Public() @UseGuards(MemberGuard) @ApiBearerAuth()
  @Get('member/online-orders')
  online(@CurrentMember() c: Customer) {
    return this.members.onlineOrders(c);
  }
}

@Module({
  controllers: [MemberController],
  providers: [MemberAuthService, MemberService, MemberGuard],
  exports: [MemberAuthService, MemberGuard],
})
export class MemberModule {}
