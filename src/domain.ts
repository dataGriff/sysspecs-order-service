import { createHash, randomUUID } from 'node:crypto';
import type { Db, OrderRow } from './db';
import {
  ORDER_CANCELLED_CHANNEL,
  ORDER_PLACED_CHANNEL,
  PAYMENT_SETTLED_TYPE,
  orderCancelledEnvelope,
  orderPlacedEnvelope,
} from './events';

export const CANCEL_REASONS = ['customer_request', 'payment_failed', 'out_of_stock'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

interface OrderLine {
  sku: string;
  quantity: number;
  unit_price_pence: number;
}

export interface PlaceOrderRequest {
  customer_id: string;
  lines: OrderLine[];
}

// Mirrors the PlaceOrderRequest schema in the pinned OpenAPI: required
// fields, additionalProperties: false, integer minimums, minItems: 1.
export function validatePlaceOrder(body: unknown): string[] {
  const errors: string[] = [];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return ['request body must be a JSON object'];
  }
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (key !== 'customer_id' && key !== 'lines') errors.push(`unknown property '${key}'`);
  }
  if (!isUuid(b.customer_id)) errors.push('customer_id must be a uuid string');
  if (!Array.isArray(b.lines)) {
    errors.push('lines must be an array');
  } else {
    if (b.lines.length < 1) errors.push('lines must have at least one item');
    b.lines.forEach((line, i) => {
      if (typeof line !== 'object' || line === null || Array.isArray(line)) {
        errors.push(`lines[${i}] must be an object`);
        return;
      }
      const l = line as Record<string, unknown>;
      for (const key of Object.keys(l)) {
        if (key !== 'sku' && key !== 'quantity' && key !== 'unit_price_pence') {
          errors.push(`lines[${i}] has unknown property '${key}'`);
        }
      }
      if (typeof l.sku !== 'string') errors.push(`lines[${i}].sku must be a string`);
      if (!Number.isInteger(l.quantity) || (l.quantity as number) < 1) {
        errors.push(`lines[${i}].quantity must be an integer >= 1`);
      }
      if (!Number.isInteger(l.unit_price_pence) || (l.unit_price_pence as number) < 0) {
        errors.push(`lines[${i}].unit_price_pence must be an integer >= 0`);
      }
    });
  }
  return errors;
}

export function toApiOrder(order: OrderRow) {
  return {
    order_id: order.order_id,
    customer_id: order.customer_id,
    status: order.status,
    total_pence: order.total_pence,
  };
}

export function getOrder(db: Db, orderId: string): OrderRow | undefined {
  return db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId) as OrderRow | undefined;
}

export type PlaceOrderResult =
  | { outcome: 'placed' | 'replayed'; order: OrderRow }
  | { outcome: 'conflict' };

export function placeOrder(
  db: Db,
  request: PlaceOrderRequest,
  idempotencyKey: string | undefined,
): PlaceOrderResult {
  const bodyHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  return db.transaction((): PlaceOrderResult => {
    if (idempotencyKey) {
      const existing = db
        .prepare('SELECT * FROM idempotency_keys WHERE idem_key = ? AND customer_id = ?')
        .get(idempotencyKey, request.customer_id) as
        | { body_hash: string; order_id: string }
        | undefined;
      if (existing) {
        if (existing.body_hash !== bodyHash) return { outcome: 'conflict' };
        return { outcome: 'replayed', order: getOrder(db, existing.order_id)! };
      }
    }
    const order: OrderRow = {
      order_id: randomUUID(),
      customer_id: request.customer_id,
      status: 'placed',
      total_pence: request.lines.reduce((sum, l) => sum + l.quantity * l.unit_price_pence, 0),
      placed_at: new Date().toISOString(),
    };
    db.prepare(
      'INSERT INTO orders (order_id, customer_id, status, total_pence, placed_at) VALUES (?, ?, ?, ?, ?)',
    ).run(order.order_id, order.customer_id, order.status, order.total_pence, order.placed_at);
    const event = orderPlacedEnvelope(order);
    db.prepare('INSERT INTO outbox (event_id, channel, envelope) VALUES (?, ?, ?)').run(
      event.id,
      ORDER_PLACED_CHANNEL,
      JSON.stringify(event),
    );
    if (idempotencyKey) {
      db.prepare(
        'INSERT INTO idempotency_keys (idem_key, customer_id, body_hash, order_id) VALUES (?, ?, ?, ?)',
      ).run(idempotencyKey, request.customer_id, bodyHash, order.order_id);
    }
    return { outcome: 'placed', order };
  })();
}

export type CancelResult = { outcome: 'cancelled'; order: OrderRow } | { outcome: 'not_found' };

export function cancelOrder(db: Db, orderId: string, reason: string): CancelResult {
  return db.transaction((): CancelResult => {
    const order = getOrder(db, orderId);
    if (!order) return { outcome: 'not_found' };
    const cancelledAt = new Date().toISOString();
    db.prepare('UPDATE orders SET status = ? WHERE order_id = ?').run('cancelled', orderId);
    const event = orderCancelledEnvelope(order, reason, cancelledAt);
    db.prepare('INSERT INTO outbox (event_id, channel, envelope) VALUES (?, ?, ?)').run(
      event.id,
      ORDER_CANCELLED_CHANNEL,
      JSON.stringify(event),
    );
    return { outcome: 'cancelled', order: { ...order, status: 'cancelled' } };
  })();
}

export type SettleResult = 'applied' | 'duplicate' | 'unknown_order' | 'invalid';

// Handles a payments.settled.v2 CloudEvents envelope; at-least-once
// delivery, so the envelope id is the dedupe key.
export function handlePaymentSettled(db: Db, envelope: unknown): SettleResult {
  if (typeof envelope !== 'object' || envelope === null) return 'invalid';
  const e = envelope as Record<string, unknown>;
  const data = e.data as Record<string, unknown> | undefined;
  if (e.type !== PAYMENT_SETTLED_TYPE || !isUuid(e.id) || !data || !isUuid(data.order_id)) {
    return 'invalid';
  }
  return db.transaction((): SettleResult => {
    const seen = db.prepare('SELECT 1 FROM consumed_events WHERE event_id = ?').get(e.id);
    if (seen) return 'duplicate';
    db.prepare('INSERT INTO consumed_events (event_id) VALUES (?)').run(e.id);
    const order = getOrder(db, data.order_id as string);
    if (!order) return 'unknown_order';
    if (order.status === 'placed') {
      db.prepare('UPDATE orders SET status = ? WHERE order_id = ?').run('paid', order.order_id);
    }
    return 'applied';
  })();
}
