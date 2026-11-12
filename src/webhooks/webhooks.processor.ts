import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { createHmac, randomUUID } from 'crypto';
import { errorFields, logContext, logEvent } from '../logging/logger';

class DeliveryError extends Error {}
import { PrismaService } from '../prisma/prisma.service';
import { WEBHOOK_QUEUE } from './webhook-events';

/** Sends webhook deliveries in the background, retrying with exponential backoff. */
@Processor(WEBHOOK_QUEUE, { concurrency: 10 })
export class WebhooksProcessor extends WorkerHost {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /** Each attempt is logged by the worker (service=pos-worker) like a Kafka consumer in the e-commerce system. */
  process(job: Job<{ deliveryId: string }>) {
    return logContext.run({ traceId: randomUUID().replace(/-/g, '') }, async () => {
      const start = Date.now();
      try {
        return await this.deliver(job);
      } catch (e) {
        // Delivery failures are already logged; this is for unexpected errors (database, Redis).
        if (!(e instanceof DeliveryError)) {
          logEvent('warn', 'message_failed', 'Message failed', {
            queue: WEBHOOK_QUEUE, attempt: job.attemptsMade + 1, durationMs: Date.now() - start, ...errorFields(e),
          }, { service: 'pos-worker', logger: 'WebhooksProcessor' });
        }
        throw e;
      }
    });
  }

  private async deliver(job: Job<{ deliveryId: string }>) {
    const start = Date.now();
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
    const fields = {
      queue: WEBHOOK_QUEUE, eventType: delivery.event, endpointHost: hostOf(delivery.endpoint.url),
      attempt: job.attemptsMade + 1, status, durationMs: Date.now() - start,
    };
    const worker = { service: 'pos-worker' as const, logger: 'WebhooksProcessor' };
    if (error) {
      logEvent('warn', 'message_failed', 'Message failed', { ...fields, errorMessage: error }, worker);
      logEvent('warn', 'webhook_failed', 'Webhook delivery failed', { ...fields, errorMessage: error }, worker);
      if (isLastAttempt) logEvent('warn', 'webhook_retries_exhausted', 'Webhook retries exhausted', { ...fields, errorMessage: error }, worker);
      throw new DeliveryError(error); // let BullMQ retry
    }
    logEvent('info', 'message_processed', 'Message processed', fields, worker);
    logEvent('info', 'webhook_delivered', 'Webhook delivered', fields, worker);
  }
}

/** Only the host of an endpoint URL is logged (the path or query could hold a secret). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}
