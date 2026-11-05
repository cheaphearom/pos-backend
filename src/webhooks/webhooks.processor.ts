import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WEBHOOK_QUEUE } from './webhook-events';

/** Sends webhook deliveries in the background, retrying with exponential backoff. */
@Processor(WEBHOOK_QUEUE, { concurrency: 10 })
export class WebhooksProcessor extends WorkerHost {
  private readonly log = new Logger(WebhooksProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<{ deliveryId: string }>) {
    const id = BigInt(job.data.deliveryId);
    const delivery = await this.prisma.webhookDelivery.findUnique({ where: { id }, include: { endpoint: true } });
    if (!delivery || !delivery.endpoint.isActive) return;

    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // Receivers verify: HMAC_SHA256(secret, `${timestamp}.${body}`) === signature
    const signature = createHmac('sha256', delivery.endpoint.secret).update(`${timestamp}.${body}`).digest('hex');
    const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

    let status: number | undefined;
    let error: string | undefined;
    try {
      const res = await fetch(delivery.endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'POS-System-Webhooks/1.0',
          'X-POS-Event': delivery.event,
          'X-POS-Delivery': delivery.id.toString(),
          'X-POS-Timestamp': timestamp,
          'X-POS-Signature': `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = (e as Error).message;
    }

    await this.prisma.webhookDelivery.update({
      where: { id },
      data: {
        attempts: { increment: 1 },
        responseCode: status ?? null,
        lastError: error ?? null,
        status: error ? (isLastAttempt ? 'FAILED' : 'PENDING') : 'SUCCESS',
        deliveredAt: error ? undefined : new Date(),
      },
    });
    if (error) {
      this.log.warn(`Webhook ${delivery.event} to ${delivery.endpoint.url} failed: ${error}`);
      throw new Error(error); // let BullMQ retry
    }
  }
}
