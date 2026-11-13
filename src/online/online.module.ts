import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Injectable, Logger, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Customer, OnlineOrderStatus, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { randomBytes } from 'crypto';
import { CurrentPrincipal, Public } from '../common/decorators';
import { assertStoreAccess, Principal } from '../common/principal';
import { valueOfPoints } from '../customers/loyalty';
import { normalizePhone } from '../customers/phone';
import { MemberAuthService, MemberModule } from '../member/member.module';
import { KhqrService, PaymentsModule } from '../payments/payments.module';
import { PrismaService } from '../prisma/prisma.service';
import { SalesModule } from '../sales/sales.module';
import { SalesService } from '../sales/sales.service';
import { logEvent } from '../logging/logger';

export class OnlineItemDto {
  @IsUUID()
  productId: string;

  @Type(() => Number) @IsInt() @Min(1) @Max(50)
  quantity: number;

  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsUUID('all', { each: true })
  modifiers?: string[];

  @IsOptional() @IsString() @MaxLength(200)
  note?: string;
}

export class QuoteDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => OnlineItemDto)
  items: OnlineItemDto[];

  @IsOptional() @IsString() @MaxLength(40)
  couponCode?: string;

  /** Member app only: pay part of the order with points */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  redeemPoints?: number;
}

export class CreateOnlineOrderDto extends QuoteDto {
  /** Required unless logged in to the member app */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80)
  customerName?: string;

  @IsOptional() @Matches(/^[0-9+ ]{6,20}$/, { message: 'Phone number looks wrong' })
  phone?: string;

  @IsOptional() @IsString() @MaxLength(200)
  note?: string;

  /** From the table QR code */
  @IsOptional() @IsString() @MaxLength(20)
  tableNo?: string;

  /** WALLET: member app only, pays from the member's wallet card */
  @IsIn(['KHQR', 'COUNTER', 'WALLET'])
  payMethod: 'KHQR' | 'COUNTER' | 'WALLET';

  @IsOptional() @IsUUID()
  walletCardId?: string;
}

const PAY_MINUTES = 20; // an unpaid KHQR order expires after this

@Injectable()
export class OnlineOrdersService {
  private readonly log = new Logger(OnlineOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sales: SalesService,
    private readonly khqr: KhqrService,
  ) {}

  /** The system "user" that creates online sales. */
  private principal(storeId: string): Principal {
    return { kind: 'api_key', id: 'online-orders', name: 'Online order', scopes: ['*'], storeIds: [storeId] };
  }

  private async storeByCode(code: string) {
    const store = await this.prisma.store.findUnique({ where: { code: code.toUpperCase() } });
    if (!store || !store.isActive || !store.onlineOrdering) throw new NotFoundException('This store does not take online orders');
    return store;
  }

  /** Public menu: products available online with this store's price and their options. */
  async menu(code: string) {
    const store = await this.storeByCode(code);
    const products = await this.prisma.product.findMany({
      where: { isActive: true, isIngredient: false, onlineAvailable: true, inventory: { some: { storeId: store.id, isListed: true } } },
      select: {
        id: true, name: true, nameKm: true, description: true, imageUrl: true, sellPrice: true, unit: true, categoryId: true,
        inventory: { where: { storeId: store.id }, select: { priceOverride: true, quantity: true } }, trackStock: true,
        modifierGroups: { orderBy: { sortOrder: 'asc' }, select: { groupId: true } },
      },
      orderBy: { name: 'asc' },
    });
    const groupIds = [...new Set(products.flatMap((p) => p.modifierGroups.map((g) => g.groupId)))];
    const [groups, categories] = await Promise.all([
      this.prisma.modifierGroup.findMany({
        where: { id: { in: groupIds }, isActive: true },
        include: { options: { where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, priceDelta: true, isDefault: true } } },
      }),
      this.prisma.category.findMany({ where: { id: { in: [...new Set(products.map((p) => p.categoryId).filter(Boolean) as string[])] } }, select: { id: true, name: true, nameKm: true }, orderBy: { name: 'asc' } }),
    ]);
    return {
      store: { code: store.code, name: store.name, address: store.address, currency: store.currency, khqr: !!store.khqrAccountId },
      categories,
      groups: groups.map(({ options, id, name, minSelect, maxSelect }) => ({ id, name, minSelect, maxSelect, options })),
      products: products.map(({ inventory, sellPrice, modifierGroups, trackStock, ...p }) => ({
        ...p,
        price: inventory[0]?.priceOverride ?? sellPrice,
        soldOut: trackStock && Number(inventory[0]?.quantity ?? 0) <= 0,
        modifierGroupIds: modifierGroups.map((g) => g.groupId),
      })),
    };
  }

  /** Prices from the server; a logged-in member may also use points. */
  async quote(code: string, dto: QuoteDto, member: Customer | null) {
    const store = await this.storeByCode(code);
    return this.priced(store.id, dto, member);
  }

  private async priced(storeId: string, dto: QuoteDto, member: Customer | null) {
    const q = await this.sales.quote({ storeId, items: dto.items, couponCode: dto.couponCode || undefined, customerId: member?.id }, { online: true });
    const redeem = dto.redeemPoints ?? 0;
    let pointsDiscount = new Prisma.Decimal(0);
    if (redeem) {
      if (!member) throw new BadRequestException('Log in to the member app to use points');
      if (redeem > member.points) throw new BadRequestException(`You have ${member.points} points`);
      pointsDiscount = valueOfPoints(redeem);
      if (pointsDiscount.gte(q.total)) throw new BadRequestException('Points can pay part of the order, not all of it');
    }
    return { ...q, pointsRedeemed: redeem, pointsDiscount, amountDue: new Prisma.Decimal(q.total).minus(pointsDiscount) };
  }

  async create(code: string, dto: CreateOnlineOrderDto, member: Customer | null) {
    const store = await this.storeByCode(code);
    const customerName = (dto.customerName?.trim() || member?.name || '').slice(0, 80);
    if (!customerName) throw new BadRequestException('Please enter your name');
    if (dto.payMethod === 'KHQR' && !store.khqrAccountId) throw new BadRequestException('KHQR is not available in this store; choose pay at counter');
    const quote = await this.priced(store.id, dto, member);

    let walletCardId: string | null = null;
    if (dto.payMethod === 'WALLET') {
      if (!member) throw new BadRequestException('Log in to the member app to pay with your wallet');
      const card = await this.prisma.walletCard.findFirst({ where: { id: dto.walletCardId, customerId: member.id } });
      if (!dto.walletCardId || !card) throw new BadRequestException('Choose one of your wallet cards');
      if (card.status !== 'ACTIVE') throw new BadRequestException(`Your wallet card is ${card.status}`);
      if (card.balance.lt(quote.amountDue)) throw new BadRequestException(`Your wallet balance is ${card.balance}. Top up at the counter or choose another payment.`);
      walletCardId = card.id;
    }

    const token = randomBytes(24).toString('base64url');
    let khqrMd5: string | undefined;
    if (dto.payMethod === 'KHQR') {
      const k = await this.khqr.create(this.principal(store.id), { storeId: store.id, amount: Number(quote.amountDue) });
      khqrMd5 = k.md5;
    }
    const order = await this.prisma.onlineOrder.create({
      data: {
        token, storeId: store.id, status: dto.payMethod === 'COUNTER' ? 'PAY_AT_COUNTER' : 'PENDING_PAYMENT',
        orderType: dto.tableNo ? 'DINE_IN' : 'PICKUP', tableNo: dto.tableNo || null,
        customerName, phone: normalizePhone(dto.phone) || member?.phone || null, note: dto.note || null,
        items: JSON.parse(JSON.stringify({
          request: dto.items, lines: quote.lines,
          totals: { subtotal: quote.subtotal, discountTotal: quote.discountTotal, taxTotal: quote.taxTotal, total: quote.total, pointsDiscount: quote.pointsDiscount },
        })),
        couponCode: dto.couponCode || null, total: quote.amountDue, khqrMd5,
        customerId: member?.id ?? null, walletCardId, redeemPoints: quote.pointsRedeemed,
      },
    });

    logEvent('info', 'online_order_created', 'Online order created', { storeId: store.id, storeName: store.name, payMethod: dto.payMethod, orderType: order.orderType, amount: order.total, member: !!member });

    if (walletCardId) {
      // Wallet: pay right now. If it fails nothing was taken, so the order is simply cancelled.
      const done = await this.finalize(order.id);
      if (done.status !== 'PAID') {
        await this.prisma.onlineOrder.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
        throw new BadRequestException(done.error ?? 'Payment failed');
      }
    }
    return { token: order.token };
  }

  /** Customer status page (polled). Also notices a KHQR payment and sends the order to the barista. */
  async status(token: string) {
    let order = await this.prisma.onlineOrder.findUnique({ where: { token } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'PENDING_PAYMENT' && order.khqrMd5) {
      const k = await this.khqr.status(this.principal(order.storeId), order.khqrMd5);
      if (k.status === 'PAID') order = await this.finalize(order.id);
      else if (k.status === 'EXPIRED' || Date.now() - order.createdAt.getTime() > PAY_MINUTES * 60_000) {
        order = await this.prisma.onlineOrder.update({ where: { id: order.id }, data: { status: 'EXPIRED' } });
      }
    }
    // Once paid: the queue number and how far the barista is.
    const sale = order.saleId
      ? await this.prisma.sale.findUnique({ where: { id: order.saleId }, select: { queueNo: true, kitchenStatus: true, receiptNo: true, readyAt: true } })
      : null;
    return { ...this.view(order, true), queueNo: sale?.queueNo ?? null, kitchenStatus: sale?.kitchenStatus ?? null, receiptNo: sale?.receiptNo ?? null };
  }

  /** Paid → create the real sale (idempotent through clientRef) so it reaches the barista screen. */
  async finalize(orderId: string) {
    const order = await this.prisma.onlineOrder.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status === 'PAID') return order;
    const req = (order.items as any).request;
    const member = order.customerId
      ? await this.prisma.customer.findUnique({ where: { id: order.customerId } })
      : order.phone ? await this.prisma.customer.findUnique({ where: { phone: order.phone } }) : null;
    const card = order.walletCardId ? await this.prisma.walletCard.findUniqueOrThrow({ where: { id: order.walletCardId } }) : null;
    try {
      const sale = await this.sales.create(this.principal(order.storeId), {
        storeId: order.storeId,
        clientRef: `online-${order.id}`,
        channel: 'ONLINE',
        orderType: order.orderType,
        tableNo: order.tableNo ?? undefined,
        customerId: member?.isActive ? member.id : undefined,
        couponCode: order.couponCode ?? undefined,
        redeemPoints: order.redeemPoints || undefined,
        items: req,
        payments: [card
          ? { method: 'WALLET', amount: Number(order.total), reference: card.cardNumber }
          : { method: 'KHQR', amount: Number(order.total), reference: order.khqrMd5! }],
        note: [order.customerId ? 'App' : 'Online', order.customerName, order.phone, order.note].filter(Boolean).join(' · ').slice(0, 500),
      } as any, { walletVerified: !!card });
      return this.prisma.onlineOrder.update({ where: { id: order.id }, data: { status: 'PAID', saleId: sale.id, paidAt: new Date(), error: null } });
    } catch (e) {
      this.log.error(`Online order ${order.id} paid but sale failed: ${(e as Error).message}`);
      return this.prisma.onlineOrder.update({ where: { id: order.id }, data: { status: 'FAILED', error: (e as Error).message.slice(0, 500) } });
    }
  }

  // ─── Staff (POS) ───

  /** Orders that need a person: waiting for KHQR, pay at counter, or failed. */
  async open(p: Principal, storeId: string) {
    assertStoreAccess(p, storeId);
    const since = new Date(Date.now() - 24 * 3600_000);
    const rows = await this.prisma.onlineOrder.findMany({
      where: { storeId, createdAt: { gte: since }, status: { in: ['PENDING_PAYMENT', 'PAY_AT_COUNTER', 'FAILED'] } },
      orderBy: { createdAt: 'asc' },
    });
    const fresh = rows.filter((o) => !(o.status === 'PENDING_PAYMENT' && Date.now() - o.createdAt.getTime() > PAY_MINUTES * 60_000));
    return fresh.map((o) => this.view(o, false));
  }

  async get(p: Principal, id: string) {
    const o = await this.prisma.onlineOrder.findUniqueOrThrow({ where: { id } });
    assertStoreAccess(p, o.storeId);
    return { ...this.view(o, false), request: (o.items as any).request };
  }

  /** Manual KHQR mode: the cashier saw the money arrive. */
  async confirmPaid(p: Principal, id: string) {
    const o = await this.prisma.onlineOrder.findUniqueOrThrow({ where: { id } });
    assertStoreAccess(p, o.storeId);
    if (o.status !== 'PENDING_PAYMENT' && o.status !== 'FAILED') throw new BadRequestException(`Order is ${o.status}`);
    if (!o.khqrMd5) throw new BadRequestException('This order is paid at the counter');
    await this.khqr.confirm(p, o.khqrMd5);
    return this.view(await this.finalize(o.id), false);
  }

  async cancel(p: Principal, id: string) {
    const o = await this.prisma.onlineOrder.findUniqueOrThrow({ where: { id } });
    assertStoreAccess(p, o.storeId);
    if (o.status === 'PAID') throw new BadRequestException('Paid orders are refunded from Sales');
    return this.view(await this.prisma.onlineOrder.update({ where: { id }, data: { status: 'CANCELLED' } }), false);
  }

  private view(o: Prisma.OnlineOrderGetPayload<object>, publicView: boolean) {
    const items = o.items as any;
    return {
      ...(publicView ? {} : { id: o.id, phone: o.phone, error: o.error, saleId: o.saleId, customerId: o.customerId }),
      payMethod: o.walletCardId ? 'WALLET' : o.khqrMd5 ? 'KHQR' : 'COUNTER',
      redeemPoints: o.redeemPoints, member: !!o.customerId,
      status: o.status as OnlineOrderStatus,
      orderType: o.orderType, tableNo: o.tableNo, customerName: o.customerName, note: o.note,
      lines: items.lines, totals: items.totals, total: o.total, couponCode: o.couponCode,
      createdAt: o.createdAt, paidAt: o.paidAt, khqrMd5: publicView ? undefined : o.khqrMd5,
      expiresAt: new Date(o.createdAt.getTime() + PAY_MINUTES * 60_000),
    };
  }
}

@ApiTags('Online ordering')
@Controller()
export class OnlineOrdersController {
  constructor(
    private readonly online: OnlineOrdersService,
    private readonly prisma: PrismaService,
    private readonly members: MemberAuthService,
  ) {}

  // ─── Public (customers' phones). No login; rate limited per IP. ───

  @Public()
  @Get('public/stores/:code/menu')
  menu(@Param('code') code: string) {
    return this.online.menu(code);
  }

  @Public()
  @HttpCode(200)
  @Post('public/stores/:code/quote')
  async quote(@Param('code') code: string, @Body() dto: QuoteDto, @Headers('authorization') auth?: string) {
    return this.online.quote(code, dto, await this.members.fromHeader(auth));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('public/stores/:code/orders')
  async create(@Param('code') code: string, @Body() dto: CreateOnlineOrderDto, @Headers('authorization') auth?: string) {
    // Logged in to the member app → the order is linked to the account (points, wallet, history).
    return this.online.create(code, dto, await this.members.fromHeader(auth));
  }

  /** Status page: order, payment, queue number and preparation progress. */
  @Public()
  @Get('public/orders/:token')
  status(@Param('token') token: string) {
    return this.online.status(token);
  }

  /** The KHQR to show on the customer's phone while waiting for payment. */
  @Public()
  @Get('public/orders/:token/khqr')
  async khqr(@Param('token') token: string) {
    const o = await this.prisma.onlineOrder.findUnique({ where: { token } });
    if (!o?.khqrMd5) throw new NotFoundException('No KHQR for this order');
    const k = await this.prisma.khqrPayment.findUniqueOrThrow({ where: { md5: o.khqrMd5 } });
    return { qr: k.qr, amount: k.amount, currency: k.currency, expiresAt: k.expiresAt, status: k.status };
  }

  // ─── Staff ───

  @ApiBearerAuth()
  @Get('online-orders')
  open(@CurrentPrincipal() p: Principal, @Query('storeId', ParseUUIDPipe) storeId: string) {
    return this.online.open(p, storeId);
  }

  @ApiBearerAuth()
  @Get('online-orders/:id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.online.get(p, id);
  }

  @ApiBearerAuth()
  @Post('online-orders/:id/confirm-payment')
  confirm(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.online.confirmPaid(p, id);
  }

  @ApiBearerAuth()
  @Post('online-orders/:id/cancel')
  cancel(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.online.cancel(p, id);
  }
}

@Module({ imports: [SalesModule, PaymentsModule, MemberModule], controllers: [OnlineOrdersController], providers: [OnlineOrdersService] })
export class OnlineModule {}
