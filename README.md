# sysspecs-order-service

Implementation of the [`orders` service](https://github.com/hungovercoders/sysspec/tree/main/specs/orders)
from the `hungovercoders/sysspec` spec repo. The behaviour is decided by the
pinned contract surface in [`contracts.lock`](contracts.lock); this repo
decides only the internals: Node/TypeScript, SQLite (aggregate state,
idempotency keys, transactional outbox, event history), and WebSocket as the
event transport.

## Run it

```sh
task install                 # npm ci
task contracts:fetch         # read-only .contracts/ at the pinned sha
task start                   # api on :3000, events on ws://:3001
```

- `POST /orders`, `GET /orders/{order_id}` per the pinned OpenAPI.
- CloudEvents on `orders.placed.v2` / `orders.cancelled.v2` stream over
  WebSocket on the events port: a path naming a channel address subscribes to
  that channel, any other path gets every channel. New subscribers receive
  the already-published history first (at-least-once; dedupe on envelope id).
- An order and its OrderPlaced event commit in one SQLite transaction
  (outbox); a relay publishes committed events and appends them to the
  history tables from the `orders-events-history` data contract.
- `payments.settled.v2` envelopes mark orders paid, deduped on envelope id.

Internal operational endpoints (not part of the public contract):
`POST /_control/publication` toggles outbound publication (broker outage),
`POST /_control/orders/{id}/cancel` triggers cancellation (the contract
specifies cancellation only as an event outcome), and
`POST /_control/events/payments.settled.v2` is the transport-neutral ingest
seam for the consumed channel. Unless `ORDERS_SEED_EXAMPLES=0`, the demo
fixtures from the pinned `mocks/*.examples.yaml` are seeded at startup so
the Microcks example replays hold.

## Verify (the definition of done)

With the service running and Docker available:

```sh
gw=$(docker network inspect mocks_default --format '{{(index .IPAM.Config 0).Gateway}}')
task contracts:verify \
  BASE_URL=http://localhost:3000 \
  REST_ENDPOINT=http://$gw:3000 \
  ASYNC_ENDPOINT=ws://$gw:3001/events
```

`BASE_URL` is how this machine reaches the service; `REST_ENDPOINT` /
`ASYNC_ENDPOINT` are how the Microcks containers reach it. The async
endpoint must carry a path (`/events`): the Microcks WebSocket consumer
rejects a bare `ws://host:port` with "no suitable MessageConsumptionTask".

Two departures from the current implement-service skill, both because the
`orders/v3.1.0` pin predates it: the pinned Taskfile names the contract-test
task `mocks:contract` (not `contract:test`), and the pinned kit has no
`sysspec null run`, so the same falsifiability gate lives in
[`scripts/null-run.js`](scripts/null-run.js) - the whole suite must fail
against a service that answers `200 {}` to everything.

## Known red gate

The schemathesis step currently fails with exactly one finding:
`POST /orders` returns `400` for invalid orders - which the pinned feature
file *requires* (scenario outline "Orders must have at least one valid
line") - but the pinned OpenAPI documents only `201` and `409`. That is a
conflict between two gated artifacts and is raised as a spec-repo change
(document the 400) rather than worked around here. The gate goes green when
a release tag carrying that fix lands in `contracts.lock`.
