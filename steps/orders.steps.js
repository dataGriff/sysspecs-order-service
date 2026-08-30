'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const { Given, When, Then, Before, After, setDefaultTimeout } = require('@cucumber/cucumber');
const WebSocket = require('ws');

setDefaultTimeout(15000);

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const EVENTS_URL =
  process.env.EVENTS_URL ||
  (() => {
    // Convention: the service publishes events one port above its API.
    const url = new URL(BASE_URL);
    return `ws://${url.hostname}:${Number(url.port || 80) + 1}`;
  })();

const EVENT_TYPES = {
  OrderPlaced: 'com.hungovercoders.orders.placed.v2',
  OrderCancelled: 'com.hungovercoders.orders.cancelled.v2',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function request(world, method, path, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  world.lastResponse = { status: res.status, body: parsed };
  return world.lastResponse;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvent(world, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = world.events.find(predicate);
    if (match) return match;
    if (Date.now() > deadline) return undefined;
    await sleep(50);
  }
}

function eventsForOrder(world, type, orderId) {
  return world.events.filter((e) => e.type === type && e.data && e.data.order_id === orderId);
}

function defaultBody(world) {
  return {
    customer_id: world.customer('c-1001'),
    lines: [{ sku: 'SKU-RED', quantity: 1, unit_price_pence: 1250 }],
  };
}

async function placeDefaultOrder(world) {
  const res = await request(world, 'POST', '/orders', defaultBody(world));
  assert.strictEqual(res.status, 201, `order placement failed: ${JSON.stringify(res.body)}`);
  world.orderId = res.body.order_id;
}

Before(function () {
  this.events = [];
  this.customers = new Map();
  this.idempotentBodies = new Map();
  this.customer = (label) => {
    if (!this.customers.has(label)) this.customers.set(label, crypto.randomUUID());
    return this.customers.get(label);
  };
  // Subscribe to the service's event stream. Against a service that
  // publishes nothing (or has no stream at all) the buffer just stays
  // empty and every event assertion fails on its timeout.
  return new Promise((resolve) => {
    const ws = new WebSocket(EVENTS_URL);
    const settle = () => resolve(undefined);
    const timer = setTimeout(settle, 1500);
    ws.on('open', () => {
      clearTimeout(timer);
      this.ws = ws;
      settle();
    });
    ws.on('message', (raw) => {
      try {
        this.events.push(JSON.parse(raw.toString()));
      } catch {
        /* not JSON - ignore */
      }
    });
    ws.on('error', () => {
      clearTimeout(timer);
      settle();
    });
  });
});

After(function () {
  if (this.ws) this.ws.close();
});

Given('the customer {string} exists', function (label) {
  this.customer(label);
});

When(
  'the customer places an order for {int} unit(s) of {string} at {int} pence',
  async function (quantity, sku, unitPrice) {
    const res = await request(this, 'POST', '/orders', {
      customer_id: this.customer('c-1001'),
      lines: [{ sku, quantity, unit_price_pence: unitPrice }],
    });
    if (res.status === 201 && res.body && res.body.order_id) this.orderId = res.body.order_id;
  },
);

Then('the response status is {int}', function (expected) {
  assert.strictEqual(
    this.lastResponse.status,
    expected,
    `expected ${expected}, got ${this.lastResponse.status}: ${JSON.stringify(this.lastResponse.body)}`,
  );
});

Then('the order status is {string}', async function (expected) {
  const deadline = Date.now() + 4000;
  let actual;
  for (;;) {
    const res = await fetch(`${BASE_URL}/orders/${this.orderId}`);
    const body = await res.json().catch(() => ({}));
    actual = body.status;
    if (actual === expected || Date.now() > deadline) break;
    await sleep(100);
  }
  assert.strictEqual(actual, expected);
});

Then('the order total is {int} pence', async function (expected) {
  const res = await request(this, 'GET', `/orders/${this.orderId}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.total_pence, expected);
});

Then('an {string} event is guaranteed to be published for the order', async function (name) {
  const event = await waitForEvent(
    this,
    (e) => e.type === EVENT_TYPES[name] && e.data && e.data.order_id === this.orderId,
  );
  assert.ok(event, `no ${name} event observed for order ${this.orderId}`);
});

Given('event publication is unavailable', async function () {
  const res = await request(this, 'POST', '/_control/publication', { available: false });
  assert.strictEqual(res.status, 200);
});

Then('the {string} event is published once publication recovers', async function (name) {
  // While publication is down the event must not appear...
  await sleep(700);
  assert.strictEqual(
    eventsForOrder(this, EVENT_TYPES[name], this.orderId).length,
    0,
    `${name} event leaked while publication was unavailable`,
  );
  // ...and must appear once it recovers.
  const res = await request(this, 'POST', '/_control/publication', { available: true });
  assert.strictEqual(res.status, 200);
  const event = await waitForEvent(
    this,
    (e) => e.type === EVENT_TYPES[name] && e.data && e.data.order_id === this.orderId,
  );
  assert.ok(event, `no ${name} event observed after publication recovered`);
});

Then('no order ever exists without its {string} event', async function (name) {
  const res = await request(this, 'GET', `/orders/${this.orderId}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(eventsForOrder(this, EVENT_TYPES[name], this.orderId).length, 1);
});

Given('the customer placed an order with idempotency key {string}', async function (key) {
  this.idempotentBodies.set(key, defaultBody(this));
  const res = await request(this, 'POST', '/orders', this.idempotentBodies.get(key), {
    'Idempotency-Key': key,
  });
  assert.strictEqual(res.status, 201, `order placement failed: ${JSON.stringify(res.body)}`);
  this.orderId = res.body.order_id;
});

When('the same request is retried with idempotency key {string}', async function (key) {
  await request(this, 'POST', '/orders', this.idempotentBodies.get(key), {
    'Idempotency-Key': key,
  });
});

When('a different order body is sent with idempotency key {string}', async function (key) {
  const original = this.idempotentBodies.get(key);
  const different = {
    ...original,
    lines: [{ ...original.lines[0], quantity: original.lines[0].quantity + 1 }],
  };
  await request(this, 'POST', '/orders', different, { 'Idempotency-Key': key });
});

Then('the same order_id is returned', function () {
  assert.strictEqual(this.lastResponse.body.order_id, this.orderId);
});

Then('no second {string} event is published', async function (name) {
  const first = await waitForEvent(
    this,
    (e) => e.type === EVENT_TYPES[name] && e.data && e.data.order_id === this.orderId,
  );
  assert.ok(first, `the original ${name} event was never observed`);
  await sleep(1200);
  assert.strictEqual(eventsForOrder(this, EVENT_TYPES[name], this.orderId).length, 1);
});

Then('an {string} event is published on {string}', async function (name, channel) {
  assert.ok(EVENT_TYPES[name], `unknown event name ${name}`);
  assert.ok(
    channel === 'orders.placed.v2' || channel === 'orders.cancelled.v2',
    `unknown channel ${channel}`,
  );
  this.envelope = await waitForEvent(
    this,
    (e) => e.type === EVENT_TYPES[name] && e.data && e.data.order_id === this.orderId,
  );
  assert.ok(this.envelope, `no ${name} event observed on ${channel} for order ${this.orderId}`);
});

Then('the envelope carries specversion {string}, a unique id and a time', function (specversion) {
  assert.strictEqual(this.envelope.specversion, specversion);
  assert.match(this.envelope.id, UUID_RE);
  assert.strictEqual(this.events.filter((e) => e.id === this.envelope.id).length, 1);
  assert.ok(!Number.isNaN(Date.parse(this.envelope.time)), 'envelope time is not a timestamp');
});

Then(
  /^the envelope source is \/orders and its type is com\.hungovercoders\.orders\.placed\.v2$/,
  function () {
    assert.strictEqual(this.envelope.source, '/orders');
    assert.strictEqual(this.envelope.type, 'com.hungovercoders.orders.placed.v2');
  },
);

Then('the envelope subject is the order_id, with datacontenttype {string}', function (dct) {
  assert.strictEqual(this.envelope.subject, this.orderId);
  assert.strictEqual(this.envelope.datacontenttype, dct);
});

Then('the data carries the order_id, customer_id, placed_at and total_pence', function () {
  assert.deepStrictEqual(Object.keys(this.envelope.data).sort(), [
    'customer_id',
    'order_id',
    'placed_at',
    'total_pence',
  ]);
  assert.strictEqual(this.envelope.data.order_id, this.orderId);
  assert.strictEqual(this.envelope.data.customer_id, this.customer('c-1001'));
  assert.ok(!Number.isNaN(Date.parse(this.envelope.data.placed_at)));
  assert.ok(Number.isInteger(this.envelope.data.total_pence));
});

Then('handlers dedupe on the envelope id, not the natural key', function () {
  // The dedupe identity is the envelope id - present, a uuid, and distinct
  // from the aggregate's natural key.
  assert.match(this.envelope.id, UUID_RE);
  assert.notStrictEqual(this.envelope.id, this.envelope.data.order_id);
});

Given('the customer placed an order', async function () {
  await placeDefaultOrder(this);
});

Given('the customer placed an order via placeOrder', async function () {
  await placeDefaultOrder(this);
});

When('the order is cancelled because {string}', async function (reason) {
  const res = await request(this, 'POST', `/_control/orders/${this.orderId}/cancel`, { reason });
  assert.strictEqual(res.status, 200, `cancel failed: ${JSON.stringify(res.body)}`);
});

Then('its data carries the order_id, cancelled_at and reason', function () {
  assert.deepStrictEqual(Object.keys(this.envelope.data).sort(), [
    'cancelled_at',
    'order_id',
    'reason',
  ]);
  assert.strictEqual(this.envelope.data.order_id, this.orderId);
  assert.ok(!Number.isNaN(Date.parse(this.envelope.data.cancelled_at)));
});

When('a {string} event arrives on {string} for that order_id', async function (name, channel) {
  assert.strictEqual(name, 'PaymentSettled');
  assert.strictEqual(channel, 'payments.settled.v2');
  this.settledEnvelope = {
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: '/payments',
    type: 'com.hungovercoders.payments.settled.v2',
    subject: this.orderId,
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      payment_id: crypto.randomUUID(),
      order_id: this.orderId,
      settled_at: new Date().toISOString(),
      amount_pence: 1250,
    },
  };
  const res = await request(
    this,
    'POST',
    '/_control/events/payments.settled.v2',
    this.settledEnvelope,
  );
  assert.strictEqual(res.status, 202, `ingest failed: ${JSON.stringify(res.body)}`);
});

Then('replaying the same envelope id does not change the order again', async function () {
  const res = await request(
    this,
    'POST',
    '/_control/events/payments.settled.v2',
    this.settledEnvelope,
  );
  assert.strictEqual(res.status, 202);
  assert.strictEqual(res.body.outcome, 'duplicate');
  const order = await request(this, 'GET', `/orders/${this.orderId}`);
  assert.strictEqual(order.status, 200);
  assert.strictEqual(order.body.status, 'paid');
});

When('the order is fetched by order_id via getOrder', async function () {
  await request(this, 'GET', `/orders/${this.orderId}`);
});

Then('the order carries the order_id, customer_id, status and total_pence', function () {
  assert.deepStrictEqual(Object.keys(this.lastResponse.body).sort(), [
    'customer_id',
    'order_id',
    'status',
    'total_pence',
  ]);
});

When('an unknown order_id is fetched via getOrder', async function () {
  await request(this, 'GET', `/orders/${crypto.randomUUID()}`);
});

When('the customer places an order with {}', async function (variant) {
  const line = { sku: 'SKU-RED', quantity: 1, unit_price_pence: 1250 };
  const bodies = {
    'no lines': [],
    'a line quantity of 0': [{ ...line, quantity: 0 }],
    'a negative unit_price_pence': [{ ...line, unit_price_pence: -1 }],
    'a line missing its sku': [{ quantity: 1, unit_price_pence: 1250 }],
  };
  assert.ok(variant in bodies, `unknown line variant: ${variant}`);
  await request(this, 'POST', '/orders', {
    customer_id: this.customer('c-1001'),
    lines: bodies[variant],
  });
});
