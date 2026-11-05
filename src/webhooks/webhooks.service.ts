import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WEBHOOK_QUEUE, WebhookEvent } from './webhook-events';

@Injectable()
export class WebhooksService {
  private readonly log = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Queue an event for every endpoint subscribed to it. Never throws:
   * a webhook problem must not break a sale. Call it after the DB transaction commits.
   */
  async emit(event: WebhookEvent, data: unknown): Promise<void> {
    try {
      const endpoints = await this.prisma.webhookEndpoint.findMany({
        where: { isActive: true, OR: [{ events: { has: event } }, { events: { has: '*' } }] },
        select: { id: true },
      });
      for (const ep of endpoints) {
        const payload = JSON.parse(JSON.stringify({ event, createdAt: new Date().toISOString(), data }));
        const delivery = await this.prisma.webhookDelivery.create({ data: { endpointId: ep.id, event, payload } });
        await this.enqueue(delivery.id);
      }
    } catch (e) {
      this.log.error(`Failed to queue webhook ${event}: ${(e as Error).message}`);
    }
  }

  enqueue(deliveryId: bigint) {
    return this.queue.add(
      'deliver',
      { deliveryId: deliveryId.toString() },
      { attempts: 6, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: 1000, removeOnFail: 5000 },
    );
  }

  generateSecret() {
    return 'whsec_' + randomBytes(24).toString('hex');
  }
}
