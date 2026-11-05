import { Controller, Get, Module, NotFoundException, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CouponsModule, CouponsService } from './coupons/coupons.module';
import { PrismaService } from './prisma/prisma.service';
import { VouchersModule, VouchersService } from './vouchers/vouchers.module';
import { WalletModule } from './wallet/wallet.module';
import { WalletService } from './wallet/wallet.service';

/** POS scanner: "what is this code?" (wallet card, member QR from the app, gift voucher or coupon). Products are found on the device. */
@ApiTags('POS')
@ApiBearerAuth()
@Controller('codes')
export class LookupController {
  constructor(
    private readonly wallet: WalletService,
    private readonly vouchers: VouchersService,
    private readonly coupons: CouponsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('lookup')
  async lookup(@Query('code') raw: string, @Query('storeId', ParseUUIDPipe) storeId: string, @Query('customerId') customerId?: string) {
    const code = (raw ?? '').trim();
    if (/^\d{12,19}$/.test(code)) {
      const card = await this.wallet.lookup(code).catch(() => null);
      if (card) return { kind: 'wallet', card };
    }
    // Member QR in the member app = the member number
    const member = await this.prisma.customer.findFirst({ where: { code, isActive: true }, select: { id: true, name: true, code: true, phone: true, points: true } });
    if (member) return { kind: 'member', customer: member };
    const voucher = await this.vouchers.lookup(code).catch(() => null);
    if (voucher) return { kind: 'voucher', voucher };
    try {
      const r = await this.coupons.check(code, { storeId, customerId: customerId || null });
      const c = r.campaign;
      return { kind: 'coupon', coupon: { code: r.code.code, name: c.name, type: c.type, value: c.value, minSpend: c.minSpend, maxDiscount: c.maxDiscount } };
    } catch (e) {
      if (!(e instanceof NotFoundException)) throw e; // a real coupon that cannot be used now: show why
    }
    throw new NotFoundException(`Nothing found for "${code}"`);
  }
}

@Module({ imports: [WalletModule, VouchersModule, CouponsModule], controllers: [LookupController] })
export class LookupModule {}
