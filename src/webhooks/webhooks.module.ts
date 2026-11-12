import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { WEBHOOK_QUEUE } from './webhook-events';
import { WebhooksController } from './webhooks.controller';
import { WebhooksProcessor } from './webhooks.processor';
import { WebhooksService } from './webhooks.service';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: WEBHOOK_QUEUE })],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhooksProcessor],
  // BullModule: the queue is also used by the monitoring module and /health
  exports: [WebhooksService, BullModule],
})
export class WebhooksModule {}
