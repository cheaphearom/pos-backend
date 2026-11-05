/** Events other systems can subscribe to. */
export const WEBHOOK_EVENTS = [
  'sale.created',
  'sale.refunded',
  'stock.low',
  'stock.adjusted',
  'transfer.created',
  'transfer.received',
  'customer.created',
  'purchase_order.received',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_QUEUE = 'webhooks';
