import { Module } from '@nestjs/common';
import { PromotionsModule } from '../promotions/promotions.module';
import { PaymentsModule } from '../payments/payments.module';
import { WalletModule } from '../wallet/wallet.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({ imports: [PromotionsModule, PaymentsModule, WalletModule], controllers: [SalesController], providers: [SalesService] })
export class SalesModule {}
