import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, Logger, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { OnlineOrderStatus, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { randomBytes } from 'crypto';
import { CurrentPrincipal, Public } from '../common/decorators';
import { assertStoreAccess, Principal } from '../common/principal';
import { KhqrService, PaymentsModule } from '../payments/payments.module';
import { PrismaService } from '../prisma/prisma.service';
import { SalesModule } from '../sales/sales.module';
import { SalesService } from '../sales/sales.service';

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
}

export class CreateOnlineOrderDto extends QuoteDto {
  @IsString() @MinLength(1) @MaxLength(80)
  customerName: string;

  @IsOptional() @Matches(/^[0-9+ ]{6,20}$/, { message: 'Phone number looks wrong' })
  phone?: string;

  @IsOptional() @IsString() @MaxLength(200)
  note?: string;

  /** From the table QR code */
  @IsOptional() @IsString() @MaxLength(20)
  tableNo?: string;

  @IsIn(['KHQR', 'COUNTER'])
  payMethod: 'KHQR' | 'COUNTER';
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
      where: { isActive: true, isIngredient: false, onlineAvailable: true },
      select: {
        id: true, name: true, description: true, imageUrl: true, sellPrice: true, unit: true, categoryId: true,
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
      this.prisma.category.findMany({ where: { id: { in: [...new Set(products.map((p) => p.categoryId).filter(Boolean) as string[])] } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
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

  async quote(code: string, dto: QuoteDto) {
    const store = await this.storeByCode(code);
    return this.sales.quote({ storeId: store.id, items: dto.items, couponCode: dto.couponCode || undefined }, { online: true });
  }

  async create(code: string, dto: CreateOnlineOrderDto) {
    const store = await this.storeByCode(code);
    if (dto.payMethod === 'KHQR' && !store.khqrAccountId) throw new BadRequestException('KHQR is not available in this store; choose pay at counter');
    const quote = await this.sales.quote({ storeId: store.id, items: dto.items, couponCode: dto.couponCode || undefined }, { online: true });
    const token = randomBytes(24).toString('base64url');
    let khqrMd5: string | undefined;
    if (dto.payMethod === 'KHQR') {
      const k = await this.khqr.create(this.principal(store.id), { storeId: store.id, amount: Number(quote.total) });
      khqrMd5 = k.md5;
    }
    const order = await this.prisma.onlineOrder.create({
      data: {
        token, storeId: store.id, status: dto.payMethod === 'KHQR' ? 'PENDING_PAYMENT' : 'PAY_AT_COUNTER',
        orderType: dto.tableNo ? 'DINE_IN' : 'PICKUP', tableNo: dto.tableNo || null,
        customerName: dto.customerName.trim(), phone: dto.phone?.replace(/\s/g, '') || null, note: dto.note || null,
        items: JSON.parse(JSON.stringify({ request: dto.items, lines: quote.lines, totals: { subtotal: quote.subtotal, discountTotal: quote.discountTotal, taxTotal: quote.taxTotal } })),
        couponCode: dto.couponCode || null, total: quote.total, khqrMd5,
      },
    });
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
    const member = order.phone ? await this.prisma.customer.findUnique({ where: { phone: order.phone } }) : null;
    try {
      const sale = await this.sales.create(this.principal(order.storeId), {
        storeId: order.storeId,
        clientRef: `online-${order.id}`,
        channel: 'ONLINE',
        orderType: order.orderType,
        tableNo: order.tableNo ?? undefined,
        customerId: member?.isActive ? member.id : undefined,
        couponCode: order.couponCode ?? undefined,
        items: req,
        payments: [{ method: 'KHQR', amount: Number(order.total), reference: order.khqrMd5! }],
        note: ['Online', order.customerName, order.phone, order.note].filter(Boolean).join(' · ').slice(0, 500),
      } as any);
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
      ...(publicView ? {} : { id: o.id, phone: o.phone, error: o.error, saleId: o.saleId }),
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
  quote(@Param('code') code: string, @Body() dto: QuoteDto) {
    return this.online.quote(code, dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('public/stores/:code/orders')
  create(@Param('code') code: string, @Body() dto: CreateOnlineOrderDto) {
    return this.online.create(code, dto);
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

@Module({ imports: [SalesModule, PaymentsModule], controllers: [OnlineOrdersController], providers: [OnlineOrdersService] })
export class OnlineModule {}
