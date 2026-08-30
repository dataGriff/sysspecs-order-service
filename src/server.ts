import http from 'node:http';
import { openDb } from './db';
import {
  CANCEL_REASONS,
  cancelOrder,
  getOrder,
  handlePaymentSettled,
  isUuid,
  placeOrder,
  toApiOrder,
  validatePlaceOrder,
} from './domain';
import { Publisher } from './publisher';
import { seedExamples } from './seed';

const PORT = Number(process.env.PORT ?? 3000);
const EVENTS_PORT = Number(process.env.EVENTS_PORT ?? PORT + 1);

const db = openDb();
if (process.env.ORDERS_SEED_EXAMPLES !== '0') seedExamples(db);
const publisher = new Publisher(db, EVENTS_PORT);

function json(res: http.ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const payload = JSON.stringify(body);
  res
    .writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    })
    .end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return { ok: true, body: raw === '' ? undefined : JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const segments = url.pathname.split('/').filter(Boolean);

  try {
    // POST /orders
    if (req.method === 'POST' && url.pathname === '/orders') {
      const parsed = await readJson(req);
      if (!parsed.ok) return json(res, 400, { detail: 'request body is not valid JSON' });
      const errors = validatePlaceOrder(parsed.body);
      if (errors.length > 0) return json(res, 400, { detail: errors.join('; ') });
      const idemHeader = req.headers['idempotency-key'];
      const idemKey = Array.isArray(idemHeader) ? idemHeader[0] : idemHeader;
      const result = placeOrder(db, parsed.body as never, idemKey);
      if (result.outcome === 'conflict') {
        return json(res, 409, { detail: 'idempotency key already used with a different body' });
      }
      return json(res, 201, toApiOrder(result.order));
    }

    // GET /orders/{order_id}
    if (req.method === 'GET' && segments.length === 2 && segments[0] === 'orders') {
      const order = isUuid(segments[1]) ? getOrder(db, segments[1]) : undefined;
      if (!order) return json(res, 404);
      return json(res, 200, toApiOrder(order));
    }

    // Internal operational endpoints - not part of the public contract.

    // Toggle outbound event publication (simulates the broker being down;
    // the outbox holds events until publication is available again).
    if (req.method === 'POST' && url.pathname === '/_control/publication') {
      const parsed = await readJson(req);
      const body = parsed.ok ? (parsed.body as { available?: unknown }) : undefined;
      if (typeof body?.available !== 'boolean') {
        return json(res, 400, { detail: 'body must be {"available": boolean}' });
      }
      publisher.available = body.available;
      return json(res, 200, { available: publisher.available });
    }

    // Cancel an order. Cancellation has no public HTTP operation in the
    // pinned contract - it is specified only as an event outcome - so the
    // trigger lives here as an operational action.
    if (
      req.method === 'POST' &&
      segments.length === 4 &&
      segments[0] === '_control' &&
      segments[1] === 'orders' &&
      segments[3] === 'cancel'
    ) {
      const parsed = await readJson(req);
      const body = parsed.ok ? (parsed.body as { reason?: unknown }) : undefined;
      if (typeof body?.reason !== 'string' || !(CANCEL_REASONS as readonly string[]).includes(body.reason)) {
        return json(res, 400, { detail: `reason must be one of ${CANCEL_REASONS.join(', ')}` });
      }
      if (!isUuid(segments[2])) return json(res, 404);
      const result = cancelOrder(db, segments[2], body.reason);
      if (result.outcome === 'not_found') return json(res, 404);
      return json(res, 200, toApiOrder(result.order));
    }

    // Inbound payments.settled.v2 envelopes. In a deployment a broker
    // subscription delivers into this same handler; the ingest endpoint is
    // the transport-neutral seam.
    if (req.method === 'POST' && url.pathname === '/_control/events/payments.settled.v2') {
      const parsed = await readJson(req);
      if (!parsed.ok) return json(res, 400, { detail: 'request body is not valid JSON' });
      const outcome = handlePaymentSettled(db, parsed.body);
      if (outcome === 'invalid') {
        return json(res, 400, { detail: 'not a payments.settled.v2 CloudEvents envelope' });
      }
      return json(res, 202, { outcome });
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { status: 'ok' });
    }

    // Declared paths answer 405 for methods the contract does not declare.
    if (url.pathname === '/orders') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    if (segments.length === 2 && segments[0] === 'orders') {
      res.writeHead(405, { Allow: 'GET' }).end();
      return;
    }

    return json(res, 404);
  } catch (err) {
    console.error('request failed:', err);
    return json(res, 500, { detail: 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`orders api listening on :${PORT}, events on ws://:${EVENTS_PORT}`);
});

process.on('SIGINT', () => {
  publisher.close();
  server.close();
  process.exit(0);
});
