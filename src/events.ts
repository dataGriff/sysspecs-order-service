import { randomUUID } from 'node:crypto';
import type { OrderRow } from './db';

export const ORDER_PLACED_CHANNEL = 'orders.placed.v2';
export const ORDER_CANCELLED_CHANNEL = 'orders.cancelled.v2';
export const PAYMENT_SETTLED_TYPE = 'com.hungovercoders.payments.settled.v2';

export interface CloudEvent<T> {
  specversion: '1.0';
  id: string;
  source: string;
  type: string;
  subject: string;
  time: string;
  datacontenttype: 'application/json';
  data: T;
}

function envelope<T>(type: string, subject: string, data: T): CloudEvent<T> {
  return {
    specversion: '1.0',
    id: randomUUID(),
    source: '/orders',
    type,
    subject,
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data,
  };
}

export function orderPlacedEnvelope(order: OrderRow) {
  return envelope('com.hungovercoders.orders.placed.v2', order.order_id, {
    order_id: order.order_id,
    customer_id: order.customer_id,
    placed_at: order.placed_at,
    total_pence: order.total_pence,
  });
}

export function orderCancelledEnvelope(order: OrderRow, reason: string, cancelledAt: string) {
  return envelope('com.hungovercoders.orders.cancelled.v2', order.order_id, {
    order_id: order.order_id,
    cancelled_at: cancelledAt,
    reason,
  });
}
