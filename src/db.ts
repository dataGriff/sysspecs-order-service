import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type Db = InstanceType<typeof Database>;

export interface OrderRow {
  order_id: string;
  customer_id: string;
  status: 'placed' | 'paid' | 'cancelled';
  total_pence: number;
  placed_at: string;
}

export function openDb(file: string = process.env.ORDERS_DB ?? 'data/orders.db'): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id     TEXT PRIMARY KEY,
      customer_id  TEXT NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('placed', 'paid', 'cancelled')),
      total_pence  INTEGER NOT NULL CHECK (total_pence >= 0),
      placed_at    TEXT NOT NULL
    );

    -- Idempotency keys are scoped per customer: the same key from two
    -- customers names two independent requests.
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      idem_key     TEXT NOT NULL,
      customer_id  TEXT NOT NULL,
      body_hash    TEXT NOT NULL,
      order_id     TEXT NOT NULL REFERENCES orders (order_id),
      PRIMARY KEY (idem_key, customer_id)
    );

    -- Transactional outbox: an event row commits in the same transaction as
    -- the state change that caused it; the relay publishes committed rows.
    CREATE TABLE IF NOT EXISTS outbox (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id   TEXT NOT NULL UNIQUE,
      channel    TEXT NOT NULL,
      envelope   TEXT NOT NULL,
      published  INTEGER NOT NULL DEFAULT 0
    );

    -- Append-only event history per the orders-events-history data contract.
    CREATE TABLE IF NOT EXISTS order_placed_events (
      event_id     TEXT PRIMARY KEY,
      event_type   TEXT NOT NULL,
      event_source TEXT NOT NULL,
      event_time   TEXT NOT NULL,
      order_id     TEXT NOT NULL UNIQUE,
      customer_id  TEXT NOT NULL,
      placed_at    TEXT NOT NULL,
      total_pence  INTEGER NOT NULL CHECK (total_pence >= 0)
    );

    CREATE TABLE IF NOT EXISTS order_cancelled_events (
      event_id     TEXT PRIMARY KEY,
      event_type   TEXT NOT NULL,
      event_source TEXT NOT NULL,
      event_time   TEXT NOT NULL,
      order_id     TEXT NOT NULL,
      cancelled_at TEXT NOT NULL,
      reason       TEXT NOT NULL CHECK (reason IN ('customer_request', 'payment_failed', 'out_of_stock'))
    );

    -- Envelope ids of consumed events; delivery is at-least-once and
    -- handlers dedupe on the envelope id, not the natural key.
    CREATE TABLE IF NOT EXISTS consumed_events (
      event_id TEXT PRIMARY KEY
    );
  `);
  return db;
}
