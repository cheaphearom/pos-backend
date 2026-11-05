import { Module } from '@nestjs/common';
import { PromotionsModule } from '../promotions/promotions.module';
import { PaymentsModule } from '../payments/payments.module';
import { WalletModule } from '../wallet/wallet.module';
import { CouponsModule } from '../coupons/coupons.module';
import { VouchersModule } from '../vouchers/vouchers.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({ imports: [PromotionsModule, PaymentsModule, WalletModule, CouponsModule, VouchersModule], controllers: [SalesController], providers: [SalesService] })
export class SalesModule {}
