import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { CategoriesModule } from './categories/categories.module';
import { AuthGuard } from './common/auth.guard';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';
import { ClientThrottlerGuard } from './common/throttler.guard';
import { config } from './config';
import { CustomersModule } from './customers/customers.module';
import { HealthController } from './health.controller';
import { ApiKeysModule } from './integrations/api-keys.module';
import { InventoryModule } from './inventory/inventory.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProductsModule } from './products/products.module';
import { PaymentsModule } from './payments/payments.module';
import { PromotionsModule } from './promotions/promotions.module';
import { PurchasingModule } from './purchasing/purchasing.module';
import { WalletModule } from './wallet/wallet.module';
import { CouponsModule } from './coupons/coupons.module';
import { VouchersModule } from './vouchers/vouchers.module';
import { LookupModule } from './lookup.controller';
import { ModifiersModule } from './modifiers/modifiers.module';
import { KitchenModule } from './kitchen/kitchen.module';
import { ReportsModule } from './reports/reports.module';
import { SalesModule } from './sales/sales.module';
import { ShiftsModule } from './shifts/shifts.module';
import { StoresModule } from './stores/stores.module';
import { UsersModule } from './users/users.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({ global: true }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: config.rateLimitPerMinute }]),
    BullModule.forRoot({ connection: { url: config.redisUrl } }),
    WebhooksModule,
    AuthModule,
    UsersModule,
    StoresModule,
    CategoriesModule,
    ProductsModule,
    InventoryModule,
    CustomersModule,
    ShiftsModule,
    SalesModule,
    ReportsModule,
    ApiKeysModule,
    PurchasingModule,
    PromotionsModule,
    PaymentsModule,
    WalletModule,
    CouponsModule,
    VouchersModule,
    LookupModule,
    ModifiersModule,
    KitchenModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ClientThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
  ],
})
export class AppModule {}
