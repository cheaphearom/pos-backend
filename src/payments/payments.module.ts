import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Logger, Module, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Prisma, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsNumber, IsUUID, Min } from 'class-validator';
import { khqrConfig } from '../config';
import { CurrentPrincipal, Scopes } from '../common/decorators';
import { assertStoreAccess, Principal, userIdOf } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';
import { generateKhqr, KhqrError } from './khqr';

export class CreateKhqrDto {
  @IsUUID()
  storeId: string;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01)
  amount: number;
}

const MD5 = /^[0-9a-f]{32}$/;

@Injectable()
export class KhqrService {
  private readonly log = new Logger(KhqrService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Create a dynamic KHQR for an exact amount in the store's currency. */
  async create(p: Principal, dto: CreateKhqrDto) {
    assertStoreAccess(p, dto.storeId);
    const store = await this.prisma.store.findUniqueOrThrow({ where: { id: dto.storeId } });
    if (!store.khqrAccountId) throw new BadRequestException('KHQR is not set up for this store. Add the Bakong account on the Stores page.');
    if (store.currency !== 'USD' && store.currency !== 'KHR') throw new BadRequestException('KHQR supports USD and KHR only');

    const now = Date.now();
    const expiresAt = now + khqrConfig.expiryMinutes * 60_000;
    const billNumber = `${store.code}-${now.toString(36).toUpperCase()}`.slice(0, 25);
    let qr: { qr: string; md5: string };
    try {
      qr = generateKhqr({
        accountId: store.khqrAccountId,
        merchantName: (store.khqrMerchantName || store.name).slice(0, 25),
        merchantCity: (store.khqrCity || 'Phnom Penh').slice(0, 15),
        merchantId: store.khqrMerchantId,
        acquiringBank: store.khqrBank,
        currency: store.currency,
        amount: store.currency === 'KHR' ? Math.round(dto.amount) : dto.amount,
        billNumber,
        storeLabel: store.code,
        terminalLabel: 'POS',
        createdAt: now,
        expiresAt,
      });
    } catch (e) {
      if (e instanceof KhqrError) throw new BadRequestException(e.message);
      throw e;
    }
    const row = await this.prisma.khqrPayment.create({
      data: {
        md5: qr.md5, qr: qr.qr, storeId: store.id, amount: dto.amount, currency: store.currency, billNumber,
        expiresAt: new Date(expiresAt), createdById: userIdOf(p),
      },
    });
    return { md5: row.md5, qr: row.qr, amount: row.amount, currency: row.currency, billNumber, expiresAt: row.expiresAt, status: row.status, mode: khqrConfig.mode };
  }

  /** Current status. In bakong mode this asks Bakong (at most every 2 seconds per QR). */
  async status(p: Principal, md5: string) {
    let row = await this.find(p, md5);
    if (row.status === 'PENDING') {
      if (khqrConfig.mode === 'bakong' && (!row.lastCheckedAt || Date.now() - row.lastCheckedAt.getTime() > 2000)) {
        row = await this.checkBakong(row);
      }
      if (row.status === 'PENDING' && row.expiresAt < new Date()) {
        row = await this.prisma.khqrPayment.update({ where: { id: row.id }, data: { status: 'EXPIRED' } });
      }
    }
    return this.view(row);
  }

  /**
   * Mark as paid by hand: in manual mode any cashier (after seeing the money arrive),
   * in bakong mode only managers (fallback if the Bakong API is down).
   */
  async confirm(p: Principal, md5: string) {
    const row = await this.find(p, md5);
    if (p.kind !== 'user') throw new ForbiddenException('Only staff can confirm a payment');
    if (khqrConfig.mode === 'bakong' && p.role === Role.CASHIER) throw new ForbiddenException('Payments are confirmed automatically. Ask a manager to confirm by hand.');
    if (row.status === 'PAID') return this.view(row);
    const updated = await this.prisma.khqrPayment.update({
      where: { id: row.id },
      data: { status: 'PAID', paidAt: new Date(), confirmedById: p.id },
    });
    return this.view(updated);
  }

  /**
   * Called inside the sale transaction: a KHQR payment whose reference is a QR md5 must be
   * PAID, for this store, big enough, and not used by another sale.
   */
  async claimForSale(tx: Prisma.TransactionClient, saleId: string, storeId: string, payments: { method: string; amount: number; reference?: string }[]) {
    for (const pay of payments) {
      if (pay.method !== 'KHQR' || !pay.reference || !MD5.test(pay.reference)) continue;
      const row = await tx.khqrPayment.findUnique({ where: { md5: pay.reference } });
      if (!row) continue; // a reference typed by hand (e.g. bank transaction id)
      if (row.storeId !== storeId) throw new BadRequestException('This KHQR belongs to another store');
      if (row.status !== 'PAID') throw new BadRequestException('This KHQR has not been paid yet');
      if (row.amount.lt(pay.amount)) throw new BadRequestException(`KHQR paid ${row.amount}, less than ${pay.amount}`);
      const claimed = await tx.khqrPayment.updateMany({ where: { id: row.id, OR: [{ saleId: null }, { saleId }] }, data: { saleId } });
      if (!claimed.count) throw new BadRequestException('This KHQR payment was already used for another sale');
    }
  }

  private async find(p: Principal, md5: string) {
    if (!MD5.test(md5)) throw new NotFoundException('KHQR not found');
    const row = await this.prisma.khqrPayment.findUnique({ where: { md5 } });
    if (!row) throw new NotFoundException('KHQR not found');
    assertStoreAccess(p, row.storeId);
    return row;
  }

  /** Bakong Open API: POST /v1/check_transaction_by_md5 → responseCode 0 when paid. */
  private async checkBakong(row: Prisma.KhqrPaymentGetPayload<object>) {
    try {
      const res = await fetch(`${khqrConfig.apiUrl}/v1/check_transaction_by_md5`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${khqrConfig.token}` },
        body: JSON.stringify({ md5: row.md5 }),
        signal: AbortSignal.timeout(8000),
      });
      const body: any = await res.json().catch(() => ({}));
      if (res.ok && body?.responseCode === 0 && body.data) {
        const d = body.data;
        const amountOk = Number(d.amount) + 1e-9 >= Number(row.amount);
        const currencyOk = !d.currency || String(d.currency).toUpperCase() === row.currency;
        if (amountOk && currencyOk) {
          return this.prisma.khqrPayment.update({
            where: { id: row.id },
            data: {
              status: 'PAID',
              paidAt: d.acknowledgedDateMs ? new Date(Number(d.acknowledgedDateMs)) : new Date(),
              transactionHash: d.hash ? String(d.hash).slice(0, 100) : null,
              fromAccount: d.fromAccountId ? String(d.fromAccountId).slice(0, 100) : null,
              lastCheckedAt: new Date(),
            },
          });
        }
        this.log.warn(`KHQR ${row.md5}: Bakong reports ${d.amount} ${d.currency}, expected ${row.amount} ${row.currency}`);
      } else if (!res.ok) {
        this.log.warn(`Bakong check failed: HTTP ${res.status} ${body?.responseMessage ?? ''}`);
      }
    } catch (e) {
      this.log.warn(`Bakong check failed: ${(e as Error).message}`);
    }
    return this.prisma.khqrPayment.update({ where: { id: row.id }, data: { lastCheckedAt: new Date() } });
  }

  private view(r: Prisma.KhqrPaymentGetPayload<object>) {
    return {
      md5: r.md5, status: r.status, amount: r.amount, currency: r.currency, expiresAt: r.expiresAt, paidAt: r.paidAt,
      transactionHash: r.transactionHash, fromAccount: r.fromAccount, confirmedByHand: !!r.confirmedById, mode: khqrConfig.mode,
    };
  }
}

@ApiTags('Payments: KHQR')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('payments/khqr')
export class KhqrController {
  constructor(private readonly khqr: KhqrService) {}

  /** Create a KHQR code for an amount. Show `qr` as a QR image; poll the status with `md5`. */
  @Scopes('sales:write')
  @Post()
  create(@CurrentPrincipal() p: Principal, @Body() dto: CreateKhqrDto) {
    return this.khqr.create(p, dto);
  }

  @Scopes('sales:write', 'sales:read')
  @Get(':md5')
  status(@CurrentPrincipal() p: Principal, @Param('md5') md5: string) {
    return this.khqr.status(p, md5);
  }

  /** Confirm the payment by hand (manual mode, or a manager as fallback). */
  @Post(':md5/confirm')
  confirm(@CurrentPrincipal() p: Principal, @Param('md5') md5: string) {
    return this.khqr.confirm(p, md5);
  }
}

@Module({ controllers: [KhqrController], providers: [KhqrService], exports: [KhqrService] })
export class PaymentsModule {}
