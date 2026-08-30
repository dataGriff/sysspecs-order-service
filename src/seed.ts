import type { Db } from './db';
import { ORDER_CANCELLED_CHANNEL, ORDER_PLACED_CHANNEL } from './events';

// The pinned contract surface ships example fixtures (mocks/*.examples.yaml)
// that Microcks replays verbatim against a real implementation - including
// GET /orders/11111111-... expecting 200. Seeding those fixtures (with the
// example event ids, so restarts are idempotent) makes the service hold the
// same demo state the examples describe. Disable with ORDERS_SEED_EXAMPLES=0.
export function seedExamples(db: Db): void {
  const insertOrder = db.prepare(
    'INSERT OR IGNORE INTO orders (order_id, customer_id, status, total_pence, placed_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertOutbox = db.prepare(
    'INSERT OR IGNORE INTO outbox (event_id, channel, envelope) VALUES (?, ?, ?)',
  );
  const at = '2026-08-23T09:00:00Z';

  const placed = {
    order_id: '11111111-1111-1111-1111-111111111111',
    customer_id: '22222222-2222-2222-2222-222222222222',
    total_pence: 2500,
  };
  insertOrder.run(placed.order_id, placed.customer_id, 'placed', placed.total_pence, at);
  insertOutbox.run(
    'aaaaaaaa-1111-1111-1111-111111111111',
    ORDER_PLACED_CHANNEL,
    JSON.stringify({
      specversion: '1.0',
      id: 'aaaaaaaa-1111-1111-1111-111111111111',
      source: '/orders',
      type: 'com.hungovercoders.orders.placed.v2',
      subject: placed.order_id,
      time: at,
      datacontenttype: 'application/json',
      data: {
        order_id: placed.order_id,
        customer_id: placed.customer_id,
        placed_at: at,
        total_pence: placed.total_pence,
      },
    }),
  );

  const cancelled = {
    order_id: '33333333-3333-3333-3333-333333333333',
    customer_id: '44444444-4444-4444-4444-444444444444',
    total_pence: 1250,
  };
  insertOrder.run(cancelled.order_id, cancelled.customer_id, 'cancelled', cancelled.total_pence, at);
  insertOutbox.run(
    'aaaaaaaa-3333-3333-3333-333333333333',
    ORDER_PLACED_CHANNEL,
    JSON.stringify({
      specversion: '1.0',
      id: 'aaaaaaaa-3333-3333-3333-333333333333',
      source: '/orders',
      type: 'com.hungovercoders.orders.placed.v2',
      subject: cancelled.order_id,
      time: at,
      datacontenttype: 'application/json',
      data: {
        order_id: cancelled.order_id,
        customer_id: cancelled.customer_id,
        placed_at: at,
        total_pence: cancelled.total_pence,
      },
    }),
  );
  insertOutbox.run(
    'bbbbbbbb-2222-2222-2222-222222222222',
    ORDER_CANCELLED_CHANNEL,
    JSON.stringify({
      specversion: '1.0',
      id: 'bbbbbbbb-2222-2222-2222-222222222222',
      source: '/orders',
      type: 'com.hungovercoders.orders.cancelled.v2',
      subject: cancelled.order_id,
      time: at,
      datacontenttype: 'application/json',
      data: { order_id: cancelled.order_id, cancelled_at: at, reason: 'customer_request' },
    }),
  );
}
