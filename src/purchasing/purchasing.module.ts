// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { Module } from '@nestjs/common';
import { PurchaseOrdersController, SuppliersController } from './purchasing.controller';
import { PurchasingService } from './purchasing.service';

@Module({ controllers: [SuppliersController, PurchaseOrdersController], providers: [PurchasingService] })
export class PurchasingModule {}
