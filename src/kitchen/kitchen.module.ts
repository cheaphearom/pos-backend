import { BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { KitchenStatus, Prisma } from '@prisma/client';
import { IsEnum } from 'class-validator';
import { CurrentPrincipal, Public } from '../common/decorators';
import { assertStoreAccess, Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';

export class KitchenStatusDto {
  @IsEnum(KitchenStatus)
  status: KitchenStatus;
}

/** Allowed moves on the barista / kitchen screen (also back one step, for mistakes). */
const NEXT: Record<KitchenStatus, KitchenStatus[]> = {
  NONE: [],
  NEW: ['PREPARING', 'READY', 'CANCELLED'],
  PREPARING: ['READY', 'NEW', 'CANCELLED'],
  READY: ['COMPLETED', 'PREPARING'],
  COMPLETED: ['READY'],
  CANCELLED: ['NEW'],
};

const orderSelect = {
  id: true, receiptNo: true, queueNo: true, orderType: true, tableNo: true, channel: true, note: true,
  kitchenStatus: true, createdAt: true, kitchenStartedAt: true, readyAt: true, completedAt: true,
  customer: { select: { name: true } },
  items: { orderBy: { lineNo: 'asc' }, select: { id: true, name: true, quantity: true, modifiers: true, note: true } },
} satisfies Prisma.SaleSelect;

@Injectable()
export class KitchenService {
  constructor(private readonly prisma: PrismaService) {}

  /** Open orders (new, preparing, ready) plus orders completed in the last 30 minutes (to recall). */
  async orders(p: Principal, storeId: string) {
    assertStoreAccess(p, storeId);
    const recent = new Date(Date.now() - 30 * 60_000);
    const rows = await this.prisma.sale.findMany({
      where: {
        storeId,
        OR: [{ kitchenStatus: { in: ['NEW', 'PREPARING', 'READY'] } }, { kitchenStatus: 'COMPLETED', completedAt: { gte: recent } }],
      },
      select: orderSelect,
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return { serverTime: new Date().toISOString(), orders: rows };
  }

  async setStatus(p: Principal, saleId: string, status: KitchenStatus) {
    const sale = await this.prisma.sale.findUnique({ where: { id: saleId }, select: { storeId: true, kitchenStatus: true } });
    if (!sale) throw new NotFoundException('Order not found');
    assertStoreAccess(p, sale.storeId);
    if (!NEXT[sale.kitchenStatus].includes(status)) throw new BadRequestException(`Cannot move an order from ${sale.kitchenStatus} to ${status}`);
    const now = new Date();
    return this.prisma.sale.update({
      where: { id: saleId },
      data: {
        kitchenStatus: status,
        ...(status === 'PREPARING' && { kitchenStartedAt: now }),
        ...(status === 'READY' && { readyAt: now }),
        ...(status === 'COMPLETED' && { completedAt: now }),
      },
      select: orderSelect,
    });
  }

  /** Public pickup board (TV in the café): queue numbers only, no personal data. */
  async board(code: string) {
    const store = await this.prisma.store.findUnique({ where: { code: code.toUpperCase() }, select: { id: true, name: true, hasKitchen: true } });
    if (!store || !store.hasKitchen) throw new NotFoundException('Store not found');
    const rows = await this.prisma.sale.findMany({
      where: { storeId: store.id, kitchenStatus: { in: ['NEW', 'PREPARING', 'READY'] }, createdAt: { gte: new Date(Date.now() - 12 * 3600_000) } },
      select: { queueNo: true, kitchenStatus: true, readyAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return {
      store: store.name,
      preparing: rows.filter((r) => r.kitchenStatus !== 'READY').map((r) => r.queueNo),
      ready: rows.filter((r) => r.kitchenStatus === 'READY').sort((a, b) => +b.readyAt! - +a.readyAt!).map((r) => r.queueNo),
    };
  }
}

@ApiTags('Café: barista / kitchen')
@ApiBearerAuth()
@Controller()
export class KitchenController {
  constructor(private readonly kitchen: KitchenService) {}

  /** Orders for the barista / kitchen screen. Poll every few seconds. */
  @Get('kitchen/orders')
  orders(@CurrentPrincipal() p: Principal, @Query('storeId', ParseUUIDPipe) storeId: string) {
    return this.kitchen.orders(p, storeId);
  }

  /** Move an order: NEW → PREPARING → READY → COMPLETED (or CANCELLED). */
  @Post('kitchen/orders/:id/status')
  setStatus(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: KitchenStatusDto) {
    return this.kitchen.setStatus(p, id, dto.status);
  }

  /** Pickup board for a TV: "Preparing" and "Ready" queue numbers. No login. */
  @Public()
  @Get('public/stores/:code/board')
  board(@Param('code') code: string) {
    return this.kitchen.board(code);
  }
}

@Module({ controllers: [KitchenController], providers: [KitchenService] })
export class KitchenModule {}
