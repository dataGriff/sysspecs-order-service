import { WebSocketServer, WebSocket } from 'ws';
import type { Db } from './db';
import { ORDER_CANCELLED_CHANNEL, ORDER_PLACED_CHANNEL } from './events';

interface OutboxRow {
  seq: number;
  event_id: string;
  channel: string;
  envelope: string;
}

function channelForPath(path: string): string | null {
  if (path.includes(ORDER_CANCELLED_CHANNEL) || path.includes('orderCancelled') || path.includes('publishOrderCancelled')) {
    return ORDER_CANCELLED_CHANNEL;
  }
  if (path.includes(ORDER_PLACED_CHANNEL) || path.includes('orderPlaced') || path.includes('publishOrderPlaced')) {
    return ORDER_PLACED_CHANNEL;
  }
  return null; // firehose: every channel
}

// Publishes committed outbox rows to WebSocket subscribers. A subscriber's
// path selects a channel (any path naming the channel address or operation);
// any other path receives every channel. New subscribers are first sent the
// already-published history for their channel - the stream is at-least-once
// and consumers dedupe on the envelope id, so replay is safe.
export class Publisher {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, string | null>();
  private timer: NodeJS.Timeout;
  available = true;

  constructor(
    private db: Db,
    port: number,
  ) {
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws, req) => {
      const path = req.url ?? '/';
      const channel = channelForPath(path);
      console.log(`events: subscriber connected path=${path} channel=${channel ?? 'all'}`);
      this.clients.set(ws, channel);
      ws.on('close', () => this.clients.delete(ws));
      const history = (
        channel
          ? this.db
              .prepare('SELECT * FROM outbox WHERE published = 1 AND channel = ? ORDER BY seq')
              .all(channel)
          : this.db.prepare('SELECT * FROM outbox WHERE published = 1 ORDER BY seq').all()
      ) as OutboxRow[];
      for (const row of history) ws.send(row.envelope);
    });
    this.timer = setInterval(() => this.relay(), 100);
  }

  // Drain the outbox: record each event in the append-only history and mark
  // it published in one transaction, then fan out to subscribers.
  private relay(): void {
    if (!this.available) return;
    const pending = this.db
      .prepare('SELECT * FROM outbox WHERE published = 0 ORDER BY seq')
      .all() as OutboxRow[];
    for (const row of pending) {
      const envelope = JSON.parse(row.envelope);
      this.db.transaction(() => {
        if (row.channel === ORDER_PLACED_CHANNEL) {
          this.db
            .prepare(
              `INSERT OR IGNORE INTO order_placed_events
                 (event_id, event_type, event_source, event_time, order_id, customer_id, placed_at, total_pence)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              envelope.id,
              envelope.type,
              envelope.source,
              envelope.time,
              envelope.data.order_id,
              envelope.data.customer_id,
              envelope.data.placed_at,
              envelope.data.total_pence,
            );
        } else if (row.channel === ORDER_CANCELLED_CHANNEL) {
          this.db
            .prepare(
              `INSERT OR IGNORE INTO order_cancelled_events
                 (event_id, event_type, event_source, event_time, order_id, cancelled_at, reason)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              envelope.id,
              envelope.type,
              envelope.source,
              envelope.time,
              envelope.data.order_id,
              envelope.data.cancelled_at,
              envelope.data.reason,
            );
        }
        this.db.prepare('UPDATE outbox SET published = 1 WHERE seq = ?').run(row.seq);
      })();
      for (const [ws, channel] of this.clients) {
        if (ws.readyState === WebSocket.OPEN && (channel === null || channel === row.channel)) {
          ws.send(row.envelope);
        }
      }
    }
  }

  close(): void {
    clearInterval(this.timer);
    this.wss.close();
    for (const ws of this.clients.keys()) ws.terminate();
  }
}
