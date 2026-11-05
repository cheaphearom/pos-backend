import { Global, Module } from '@nestjs/common';
import { InventoryController, TransfersController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { StockService } from './stock.service';

@Global()
@Module({
  controllers: [InventoryController, TransfersController],
  providers: [InventoryService, StockService],
  exports: [InventoryService, StockService],
})
export class InventoryModule {}
