// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { PriceScheduleService } from './price-schedule';

@Module({ controllers: [ProductsController], providers: [ProductsService, PriceScheduleService] })
export class ProductsModule {}
