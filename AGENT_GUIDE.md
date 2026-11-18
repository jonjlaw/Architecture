# Mapping a codebase into Faultline

Faultline is a single-page simulator (`index.html`) that draws a system as components and connections, runs traffic through it, injects failures, and audits every request for lost, duplicated, partial or out-of-order effects. It loads a system from one JSON file through its **Import** button.

Your job: read one or more codebases and write that JSON file so it is a faithful map of how requests and messages actually flow, plus a report of what you could not represent.

**If an element of the application's architecture is missing from Faultline, call it out and say what would be needed to fill the gap.** This feedback is how Faultline gets more complete, so a precise gap is as valuable as a mapped node. See [Gaps](#gaps).

## What you deliver

1. **`<system>.faultline.json`**: the map, in the [file format](#file-format) below.
2. **`<system>.faultline-report.md`** with three sections:
   - **Evidence**: one row per node and per edge: its id, its name, and the `repo/path:line` that proves it exists and behaves as mapped.
   - **Assumed values**: every number or setting you set without finding it in code or config, and why you chose it. Mark each one in the JSON too (see [Provenance](#provenance)), so the simulator can say which of its numbers are illustrative.
   - **Gaps**: required even when empty. See [Gaps](#gaps).

Map what the code does, and name things what the code names them (service, topic, table, queue and endpoint names). A setting belongs in the JSON when the code or config states it; otherwise leave it out so the default applies, or set it, list it under Assumed values and name it in the owner's `assumed` list.

**Arrival rates are almost never in a codebase.** Unless you were given measurements, a source's `rateMin`, `rateMax`, `release` and `everyS` are assumptions: put them in that source's `assumed` list. Never describe the simulator's throughput, latency or anomaly counts as production figures.

## Procedure

Work through these in order. Each step ends when its criterion holds.

1. **List the deployables.** Every separately deployed unit in every repo: services, workers, schedulers, functions. *Done when every Dockerfile, deployment manifest, serverless config and process entry point is assigned to a deployable or listed as out of scope.*
2. **List every entry point of every deployable.** HTTP/gRPC routes, message subscriptions, scheduled jobs, table polling loops. *Done when every route registration, consumer/listener registration and scheduler registration in the code is on the list.*
3. **Trace each entry point to its side effects, in execution order.** Database writes and reads, cache calls, publishes, calls to other services and third parties. Record for each: transaction boundaries, timeout, retries, what happens on failure, whether the code waits for the result, and for messages the type, key and version. *Done when every outbound client call reachable from the handler appears in the trace or in Gaps.*
4. **Resolve shared infrastructure across repos.** The same topic, queue, database or table named in two codebases is one node. Match by the configured name, and record both sightings as evidence. A counterpart outside the codebases you were given (a caller or consumer you cannot find) becomes an `ext` node or a source, and a line in the report. *Done when every topic, queue, database and table name from step 3 maps to exactly one node.*
5. **Write nodes, edges and actions** using the [mapping rules](#mapping-rules) and [file format](#file-format). *Done when every entry point from step 2 is a node and every side effect from step 3 is an action, or a gap.*
6. **Write the deployment** (application boxes) from deployment manifests: shards, builds running side by side, regions, instance counts. *Done when every deployable from step 1 is an application box.*
7. **Write scenarios.** *Done when there is one per dependency that can fail (down), one per broker connection (duplicate delivery), one per deployment cut-over the codebase's pipeline performs, and one `replay` per error queue, dead-letter queue or parked-row table that the codebase has a replay tool or runbook for.*
8. **Validate** with `node validate.js <file>` (it needs `index.html` beside it). Without Node, re-check [Rules that break a file](#rules-that-break-a-file) by hand. *Done when it reports no errors and the report explains every remaining warning.*
9. **Read the audit** that `validate.js` prints for a healthy 30-second run: per source, how many requests ended ok, failed or **unfinished**, and how many were lost, duplicate, partial, ghost, corrupt, out of order, stale or parked. An anomaly with no faults applied is either a real weakness in the system or a mistake in the map. Unfinished requests are listed by the last thing that happened to them; they are not successes. Also read **Conditional paths** (how often each `if` / `times` action ran and was skipped: an action that never ran usually means the condition does not match what the sources send) and **Delayed, parked and held work**. *Done when each anomaly, unfinished request and never-run action is fixed in the map or explained in the report from the code.*
10. **Write the report.** *Done when every node and edge has an evidence row and every item in [Known gaps](#known-gaps) has been checked against the code.*

## Mapping rules

**One handler is one node.** A service-kind node has a single ordered action list that runs for every request it receives, whichever connection the request arrived on. A deployable with several entry points that do different work becomes several nodes, named `<deployable>: <entry point>` (`order-service: POST /orders`, `order-service: onPaymentSettled`), all placed inside the same application box. The exception is a single consumer that switches on the event type: keep it as one node and give each action an `if` on `$type`.

**One caller behaviour is one source.** A client that calls two endpoints is two `client` nodes. Sources that act on the same entities share a `keyspace` (for example `"order"`), which is what lets the audit detect a reader seeing stale data from a writer.

**A connection out of a service-kind node is a target that node calls**, and needs at least one action. Several actions may use the same connection: two statements against one table, a read before a write, two calls to one API. Give each a `name`. Order the actions as the code executes them.

### Entry points

| In the code | In the map |
|---|---|
| HTTP/gRPC handler | `service` node; caller's edge points at it |
| Queue or topic consumer | `worker` node; edge from the topic/queue to it, settings in `cfg.sub` |
| Lambda / cloud function | `fn` node |
| Cron job, nightly batch, scheduled task | `cron` source feeding the handler that does the work |
| Loop that selects pending rows from a table | `poller` node; edge from that table (kind `queue`) to it, settings in `cfg.poll` |
| Responds 202 then works in the background | node `respond: "ack"` |
| Load balancer, gateway, rate limiter, CDN | proxy-kind node; its outgoing edges are its targets |
| Third-party API | `ext`, `payment` or `email` |

### Database and cache work

| In the code | In the map |
|---|---|
| Write inside a DB transaction | action with `tx: true` on a store that supports transactions |
| Two tables written in one transaction | two edges to the same database, one per table, both actions `tx: true` |
| Unique-key / processed-message check | a `dedupe` table, written with `tx: true` if it shares the work's transaction |
| `UPDATE … WHERE version < :v`, conditional put, compare-and-set | `guard: true` on the write action |
| Transactional outbox, whether a separate relay process or a library inside the service | `queue` table written with `tx: true` alongside the data + a `poller` (the relay) + the poller's publish action. Give the relay edge `poll.onExhaust: "block"` when it retries for ever |
| Inbox: store the message, acknowledge, process later | a `worker` that writes a `dedupe` table and a `queue` table with `tx: true` + a `poller` that does the work, with `poll.mark: "tx"` when the row is marked in the work's transaction |
| Read-through cache | service → `cache` edge (action `op: "read"`), plus `cache` → database edge |
| Several statements against one table | several actions on the same edge, each with a `name` |
| `SELECT` "already processed?" then `INSERT` (no unique key) | a read action with `check: true`, then the write, both on the edge to that table |
| Transaction committed before the handler's later steps | `txEnd: true` on the last action inside it; actions below run after the commit |
| Stored procedure or trigger that writes several tables | a `proc` table with `also: [table ids]`; the service writes the `proc` table |
| Row with `run_after` / `visible_at` / a scheduled time-out | write action with `delayMs` on a `queue` table |
| Polling query without `FOR UPDATE SKIP LOCKED` or a status flip | `cfg.poll.claim: "none"` |
| Row marked done in the same transaction as the handler's writes | `cfg.poll.mark: "tx"`, handler writes that database with `tx: true` |
| Debezium / log-tailing relay reading a table | `poller` with `cfg.poll.mode: "cdc"`; allowed from `data` tables as well as `queue` tables |
| Relay that publishes each outbox row to the topic named in the row | writer sets a field (`set: "topic=orders.created"`); the relay has one publish action per topic with `if: "topic=orders.created"` |
| Read from a replica | `replica` node with `replicaLag` |
| Database, broker or API that lives in one region | `region` on that node, using the application's region names |
| Geo / latency routing in front of a service, region affinity | application `routing`: `local` or `localFirst`; `region` on the sources |
| HPA, ASG or serverless concurrency scaling | application `autoscale` with `scaleMin`, `scaleMax`, `scaleTargetPct`, `scaleCooldownS` |

### Calls and failure handling

| In the code | In the map |
|---|---|
| Retry wrapper, timeout, circuit breaker on a call | the action's `retries`, `backoff`, `timeout`, `breaker` |
| try/catch that logs and carries on | action `onError: "continue"` |
| Fallback call when the first fails | first action `onError: "continue"`, next action `when: "fallback"` |
| Saga / compensating calls | later action `onError: "compensate"` |
| Fire-and-forget (not awaited, no error handling) | action `await: false` |
| Idempotency key honoured by the callee | callee `idempotent: true` |
| Handler remembers processed ids in memory/cache | service `idempotent: true` |
| `catch` block that writes an error queue / error table | action `when: "error"` to that queue or table, placed anywhere in the list |
| Error queue drained only by an operator or a replay tool | `queue` node with `hold: true`; add an edge from it to the handler that a replay feeds, and a scenario with a `replay` trigger |
| Call that can be rejected with 401 / 403 (certificate, secret, role) | nothing in the map; add a scenario with the edge fault `deny` |

### Messaging

| In the code | In the map |
|---|---|
| SNS → SQS → consumer | `pubsub` → `queue` → `worker` |
| Consumers sharing a Kafka group id | same `cfg.sub.group` on their edges from the topic |
| Producer record key (`ProducerRecord(topic, key, …)`) | `cfg.pkey` on the edge into the topic: `entity`, `none` (null key) or `field:<name>` (tenant, customer, any other id carried by the message) |
| Event/message classes or a `type` discriminator | `types` on the source that originates them |
| Consumer ignores event types it does not handle | `cfg.if` on its edge from the topic, queue or table: `"$type=OrderCreated|OrderCancelled"` |
| `switch` on event type inside one handler | `if` on each action: `"$type=OrderCreated"` |
| Handler receives one event and publishes a different one | `as` on the publishing action |
| Payload fields or headers the code branches or routes on | `fields` on the source that originates them, e.g. `"status=PAID:70|PENDING:30, items=1-4"` |
| `if (msg.status == …)`, header check, feature of the message | the same `if`, on the action, or on the subscription edge (`cfg.if`) when the consumer discards the message. Type and field tests combine: `"$type=OrderPaid & status=PAID"` |
| Loop over line items: one write / publish / call per item | `times` on the action: a number, a range, or a numeric field name |
| Handler changes a field or stamps an id on what it sends | `set` on the action, e.g. `"status=SHIPPED, sourceId=$id"` |
| Producer key that is not the entity id | `cfg.pkey: "field:<name>"` on the edge into the topic |
| `DelaySeconds`, scheduled message, delay exchange | `delayMs` on the publish action into a `queue` |
| Schema version, Avro/Protobuf version, `v2` DTO a consumer can parse | `contract` on the consuming node |
| A build that changes a message format | `emitVer` on that server group |

## Gaps

Write a gap whenever something in the code has no component, setting, connection rule or fault that represents it, and whenever you had to approximate. For each gap give:

| Field | Content |
|---|---|
| What the code does | The behaviour, with `repo/path:line` |
| Why it does not fit | The missing component type, setting, connection or fault |
| Stand-in used | What you put in the map instead, by node/edge id, or "omitted" |
| What the stand-in gets wrong | Which failures or timings the simulation will now misreport |
| What Faultline would need | The concrete addition: a new component type, a new field (name, values, meaning), a new connection rule, a new fault or trigger |

### Known gaps

Report each of these you meet. The list is a starting point; anything else that does not fit is a gap too.

- **Branching on something the message does not carry.** An action can be limited by a condition on the message's type and fields (`if`), or run only if the previous action failed, or only when the handler failed. Branching on a lookup result, a database value, a feature flag or the response of an earlier call is a gap. Conditions are joined with AND only.
- **Fan-out with different keys.** `times` repeats an action per item, but every item keeps the request's entity key. A loop whose items belong to different entities (and so different partitions or shards) is a gap, as is a batch consumer that handles many messages in one transaction.
- **Message schemas.** Fields are flat name=value strings with no schema. Nested payloads, compatibility rules beyond "newest version understood", and response bodies are gaps.
- **Keys.** Topic partitioning can use any field (`field:<name>`). Sharding, caching, FIFO grouping and the ordering audit always use the entity key; per-type keys and custom partitioners are gaps.
- **Timers that are not a row or a message.** A write to a work table or a queue can carry a delay. TTL-triggered events, cancelling a scheduled row, in-memory timers and retry schedules other than a subscription's backoff are gaps.
- **Locks and coordination.** Distributed locks, leader election and leases. A row claim on a polled table (`claim`) and a version check on a single database write (`guard`) exist; nothing else does.
- **Transactions that span a broker.** A work-table row can be marked in the handler's database transaction (`mark: "tx"`). A broker acknowledgement inside a database or distributed transaction (DTC, Kafka transactions) is a gap: acknowledgement is always before or after the handler.
- **Reads that decide.** A `check` read stops the handler when this message was already written. A read whose result selects between branches, or supplies a value, is a gap.
- **Workflow engines and orchestrators** (Temporal, Step Functions, Camunda). Only a fixed action list with compensation exists.
- **Stream processing.** Joins, windows, aggregations, compaction and stateful topic-to-topic topologies.
- **Database-to-database flows.** Replication topology and ETL between stores. Procedures and triggers are limited to "writing this table also writes those" inside one database (`also`); procedure logic, and procedures that call other databases, are gaps. Only a read replica's lag exists.
- **Long-lived connections.** WebSockets, server-sent events, gRPC streaming, long polling.
- **Region-aware behaviour.** A request has an origin region, an application routes by it, and a component can be pinned to a region. Failover order between more than two regions, weighted or latency-based global routing, spill-over when the local region is merely saturated, data residency rules, and per-pair inter-region latency are gaps. Proxies, caches inside applications and services with an inbox ignore regions.
- **Security and tenancy.** Only a refused call exists (edge fault `deny`). Token expiry and refresh, per-tenant authorisation, tenant isolation and secret rotation are gaps.
- **Resource limits other than instances.** An application can autoscale its instance count on load. Scaling on queue depth or a custom metric, scaling a database or broker, connection pools that resize, and any memory, CPU or disk model are gaps.

## File format

Everything not listed as required may be omitted; the loader fills defaults. Unknown fields are ignored without warning, so a misspelled setting silently becomes the default. `validate.js` reports them.

```json
{
  "name": "Order placement (example map)",
  "desc": "Checkout places an order. order-service saves the order and an outbox row in one transaction; a relay publishes it; billing charges the card.\n\nMapped from: orders-repo@4f2a1c, billing-repo@9b77e0.",
  "nodes": [
    {"id": "n1", "type": "client", "name": "checkout-web: POST /orders", "x": 20, "y": 120, "cfg": {"rateMin": 20, "rateMax": 40, "keys": 500, "keyspace": "order", "timeout": 3000}},
    {"id": "n2", "type": "gateway", "name": "api-gateway", "x": 260, "y": 120},
    {"id": "n3", "type": "service", "name": "order-service: createOrder", "x": 520, "y": 120, "cfg": {"concurrency": 16, "procMs": 10, "actions": [
      {"id": "a19", "edge": "e13", "tx": true},
      {"id": "a20", "edge": "e14", "tx": true}
    ]}},
    {"id": "n4", "type": "sql", "name": "orders-db", "x": 800, "y": 100, "cfg": {"tables": [
      {"id": "t5", "name": "orders", "kind": "data"},
      {"id": "t6", "name": "outbox", "kind": "queue"}
    ]}},
    {"id": "n7", "type": "poller", "name": "outbox-relay", "x": 1080, "y": 120, "cfg": {"actions": [
      {"id": "a21", "edge": "e16", "timeout": 500}
    ]}},
    {"id": "n8", "type": "kafka", "name": "orders.created", "x": 1340, "y": 120, "cfg": {"partitions": 6}},
    {"id": "n9", "type": "worker", "name": "billing: onOrderCreated", "x": 1600, "y": 120, "cfg": {"actions": [
      {"id": "a22", "edge": "e18", "timeout": 2000, "retries": 2, "backoff": 200}
    ]}},
    {"id": "n10", "type": "payment", "name": "card-provider", "x": 1860, "y": 120}
  ],
  "edges": [
    {"id": "e11", "from": "n1", "to": "n2"},
    {"id": "e12", "from": "n2", "to": "n3"},
    {"id": "e13", "from": "n3", "to": "n4", "cfg": {"table": "t5"}},
    {"id": "e14", "from": "n3", "to": "n4", "cfg": {"table": "t6"}},
    {"id": "e15", "from": "n4", "to": "n7", "cfg": {"table": "t6", "poll": {"everyMs": 500, "batch": 100, "send": "keyed"}}},
    {"id": "e16", "from": "n7", "to": "n8"},
    {"id": "e17", "from": "n8", "to": "n9", "cfg": {"sub": {"group": "billing", "maxAttempts": 5, "onExhaust": "dlq"}}},
    {"id": "e18", "from": "n9", "to": "n10"}
  ],
  "groups": [
    {"id": "g23", "name": "order-service", "x": 490, "y": 50, "w": 240, "h": 190, "clusters": [
      {"id": "c24", "name": "cluster-1", "sgs": [
        {"id": "v25", "name": "v41", "cfg": {"weight": 90}, "regions": [
          {"id": "r26", "name": "us-east-1", "instances": 3},
          {"id": "r27", "name": "us-west-2", "instances": 3}
        ]},
        {"id": "v28", "name": "v42", "cfg": {"weight": 10}, "regions": [
          {"id": "r29", "name": "us-east-1", "instances": 1}
        ]}
      ]}
    ]}
  ],
  "scenarios": [
    {"id": "s30", "name": "Card provider down (15 s)", "desc": "billing retries, then messages go to the DLQ.", "faults": {"n10": {"down": true}}, "heal": 15, "triggers": []},
    {"id": "s31", "name": "Relay loses 20% of publish acks", "desc": "The topic has the event but the row stays: duplicates downstream.", "faults": {"e16": {"respDrop": 20}}, "heal": 0, "triggers": []},
    {"id": "s32", "name": "Canary v41 → v42", "desc": "", "faults": {}, "heal": 0, "triggers": [{"group": "v28", "what": "cutover", "from": "v25", "mode": "canary"}]}
  ]
}
```

### Rules that break a file

- **Ids** are a prefix letter plus an integer, and every id is unique: `n` node, `e` edge, `a` action, `t` table, `g` application, `c` cluster, `v` server group, `r` region, `s` scenario, `l` comparison group. Use one counter for the whole file.
- **Every edge leaving a service-kind node needs at least one action** in that node's `cfg.actions`, with `edge` set to the edge id. An edge without an action is never called. Nodes of other kinds have no actions.
- **A node whose `type` is not in the table below is dropped**, together with its edges.
- **Connection rules:**
  - Nothing connects *to* a source.
  - Third-party nodes never initiate a connection.
  - A database initiates a connection only from a `queue` or `data` table, and only to a service-kind node; the edge carries `cfg.table`. From a `data` table the edge is change-data-capture.
  - A cache connects only to one database (its backing store).
  - Two edges between the same pair of nodes are allowed only when their `cfg.table` differs.
- **`cfg.table`** must be the id of a table on the database at that end of the edge. A database with no tables takes plain edges with no `cfg.table`.
- **Server-group weights within one cluster total 100.**
- **Application membership is by position**: a node belongs to the smallest application box containing its centre, which is `(x + 88, y + 38)`. Only service-kind, proxy-kind, cache and source nodes can be members. Databases, brokers and third parties are always shared and stay outside every box.

### Node types

`kind` decides which settings, faults and connection rules apply.

| kind | types |
|---|---|
| producer (source) | `client` (calls and waits), `source` (emits events), `cron` (scheduler) |
| service | `service`, `worker` (consumer), `poller` (reads a table), `fn` (serverless) |
| proxy | `lb`, `gateway`, `limiter`, `cdn` |
| log | `kafka`, `stream` (Kinesis-style) |
| queue | `queue` (SQS/Rabbit), `fifo` |
| pubsub | `pubsub` (SNS-style push, no retention) |
| store | `sql`, `nosql`, `replica`, `blob`, `search` |
| cache | `cache` |
| external | `ext`, `payment`, `email` |
| note | `note` (canvas label; `name` is the text) |

### Node settings (`cfg`), with defaults

Times are milliseconds unless the name ends in `S` (seconds). Rates are per second. Percentages are 0–100. `a`|`b` lists the allowed values, default first.

**producer**

- Traffic: `rateMin` 5, `rateMax` 10, `pattern` `steady`|`wave`|`bursty`|`ramp`, `period` 20 (s), `spacing` `poisson`|`even`.
- Requests: `op` `write`|`read`, `keys` 20 (distinct entity ids), `keyspace` `""`, `types` `""` (see [Message types and contracts](#message-types-and-contracts)), `fields` `""` (see [Message fields and conditions](#message-fields-and-conditions)), `badPct` 0, `dupPct` 0 (client double-submits).
- Waiting: `timeout` 2000, `retries` 0, `backoff` 200.
- `region` `""`: the region these requests come from (see [Regions and sites](#regions-and-sites)).
- `cron` adds: `mode` `schedule`|`rate`, `everyS` 15, `release` `"200"` (messages per run: a number, a repeating list `"0,0,0,2000"`, or a range `"100-300"`), `spreadMs` 0, `perInstance` false (true = every app instance fires its own copy, as with no leader lock).

A source sends each request to every node it is connected to.

**service**

- Capacity: `concurrency` 8, `procMs` 20, `queueCap` 100 (rejects when full), `rateLimit` 0 (off), `restartMs` 3000.
- Behaviour: `respond` `after`|`ack`, `idempotent` false, `badData` `reject`|`crash`|`ignore` (also applies to a contract version the node does not understand), `contract` `""`, `actions` [].
- Type defaults differ: `worker` concurrency 4; `poller` concurrency 4, procMs 5; `fn` concurrency 100, procMs 40, queueCap 10.

**store:** `latency` 5, `maxConc` 20 (connection pool), `queueCap` 200, `idempotent` false (upsert / unique key), `supportsTx` true, `replicaLag` 0, `tables` []. `nosql`, `blob` and `search` default to `supportsTx` false and `idempotent` true.

Tables (`cfg.tables`) are `{id, name, kind, also}`:

- `data`: an ordinary table. A CDC relay may read it.
- `proc`: a stored procedure (or a table with a trigger). `also` lists ids of other tables of the same database that a write to it also writes, in the same statement. Any table kind may carry `also`.
- `queue`: a work table (inbox, outbox, job table). Rows written to it wait until a polling loop connected to it reads them.
- `dedupe`: a unique-key table. A repeated message's insert is rejected and the handler skips the rest of its actions.

**external:** `latency` 150, `maxConc` 100, `queueCap` 100, `rateLimit` 0, `idempotent` false.

**cache:** `latency` 1, `ttlMs` 10000, `capacity` 1000, `onWrite` `update`|`invalidate`, `writeThrough` false, `timeout` 1000.

**log:** `latency` 3, `partitions` 4, `retention` 5000 (messages per partition), `rateLimit` 0, `idempotent` false (idempotent producer).

**queue:** `latency` 4, `capacity` 10000, `fifo` false, `rateLimit` 0, `idempotent` false, `hold` false (true = an error queue drained only by hand: messages rest until a `replay` trigger; requests resting there count as settled and parked). A queue with no outgoing edge also just keeps its messages.

**pubsub:** `latency` 3, `retries` 1, `timeout` 2000.

**proxy:** `latency` 1, `strategy` `rr`|`random`|`least`|`sticky`, `rateLimit` 0, `hitRatio` 0 (edge cache, % of reads), `healthEject` false, `ejectAfter` 3, `ejectMs` 5000, `retryNext` false, `timeout` 5000.

### Edges

`{id, from, to, cfg}`. What an edge means depends on where it starts:

| From | Meaning | Extra `cfg` |
|---|---|---|
| source | sends requests to the target | `pkey` when the target is a topic |
| service-kind | a call made by an action | `table` when the target database has tables; `pkey` when the target is a topic |
| proxy | a target it balances across | |
| topic or queue | a subscription | `sub`, `if` |
| pubsub | push delivery to a subscriber | `if` |
| database `queue` or `data` table | a polling loop or CDC relay reading that table | `table`, `poll`, `if` |
| cache | read-through to its backing database | |

| `cfg` field | Applies to | Values |
|---|---|---|
| `latency` | every edge | Network latency each way, default 2 |
| `table` | edges to or from a database with tables | A table id on that database |
| `pkey` | edges into a topic or stream | `entity` (default; one entity's messages share a partition and stay in order) \| `none` (round-robin; one entity's messages can overtake each other) \| `field:<name>` (keyed by that message field. Order per entity is kept only if the field is fixed for an entity, declared as `name=#N` in the source's `fields`) |
| `if` | edges into a service-kind node from a topic, queue, pub/sub or table | Consumer-side condition on the message type and fields. A message that does not match is still delivered and acknowledged, but runs no actions. Empty = everything |
| `sub` | edges from a topic or queue | See below |
| `poll` | edges from a `queue` table | See below |

**`cfg.sub`:** `ack` `after` (at-least-once) | `before` (at-most-once), `maxAttempts` 3, `backoff` 500, `onExhaust` `dlq`|`skip`|`block`, `timeout` 5000 (redelivered if not finished), `prefetch` 10, `group` `""`. On a topic, subscriptions with the same `group` form one consumer group and split the partitions; an empty `group` is a group of its own.

**`cfg.poll`:** `mode` `poll` | `cdc` (tails the database log; always `cdc` from a `data` table), `lagMs` 5 (CDC delay after commit), `everyMs` 200, `batch` 20, `send` `keyed` (parallel, one at a time per key) | `seq` (strict order) | `parallel` (unordered), `mark` `each` | `batch` | `tx` (marked by the handler's own transaction on this database: never handled twice, but lost if that transaction commits before a later step fails), `claim` `skip` (a row being worked on is invisible to other readers) | `none` (a second loop, or a second instance of the loop's application, reads it again), `maxAttempts` 5, `backoff` 1000 (wait after a failed batch), `onExhaust` `park`|`block`, `timeout` 5000 (row lease).

### Actions

`{id, edge, ...}` in a service-kind node's `cfg.actions`, in execution order. Several actions may share an `edge`.

| Field | Default | Meaning |
|---|---|---|
| `name` | `""` | What the step is in the code (`"UPDATE status"`) |
| `if` | `""` | Run only when the message's type and fields satisfy this condition, e.g. `"$type=OrderCreated"`. Empty = always |
| `times` | `""` | Run once per item: a number, a range `"0-4"`, or a numeric field name. Each run is audited separately; 0 = not at all |
| `set` | `""` | Field values on the message or call this action sends: `"status=SHIPPED, sourceId=$id"` |
| `delayMs` | `""` | Write to a work table or publish to a queue: not readable before this delay (number, range or field name) |
| `check` | false | Database read only: stop the handler, as a duplicate, if it already wrote this table for this message. Concurrent copies both pass |
| `txEnd` | false | The open transaction commits after this action instead of after the last one |
| `op` | `write` | `read` has no side effects and is ignored by the audit |
| `tx` | false | Database write committed only if the whole handler succeeds. All `tx` actions of a handler on one database commit together after the last action |
| `guard` | false | Database write only: refused unless newer than the stored row (a version check). Late and repeated updates change nothing |
| `onError` | `abort` | `abort` returns an error and leaves earlier non-transactional effects in place; `continue` ignores the failure; `compensate` undoes earlier actions |
| `when` | `always` | `fallback` runs only if the previous action failed. `error` runs only after the handler has failed and rolled back (a catch block): if every `error` action succeeds, a message consumer acknowledges the message and the request is parked; if one fails, the original failure stands and the message is retried, unless that action has `onError: "continue"`, which swallows it and loses the message. A waiting caller always still gets the error |
| `as` | `""` | The message or call this action sends has this type (`Name` or `Name@version`) instead of the type being handled |
| `await` | true | false = fire-and-forget |
| `timeout` | 1000 | |
| `retries` | 0 | |
| `backoff` | 100 | Exponential with jitter |
| `breaker` | false | Circuit breaker: fails fast after 5 consecutive failures |
| `failPct` | 0 | This step fails on its own this often |

### Message types and contracts

A message carries an optional type name and a contract version (1 unless stated). They travel with it through services, topics, queues and tables until an action re-types it with `as`, or a server group's `emitVer` overrides the version of everything that build sends.

One list syntax, `Name[@version][:weight]` separated by commas, serves two settings:

- **Source `types`**, the mix it sends: `"OrderCreated:60, OrderUpdated:30, OrderCancelled@2:10"`.
- **Service `contract`**, the newest version it understands per type: `"OrderCreated@2, *@1"`. `*` covers every type not listed, including untyped messages. A type with no entry and no `*` is accepted at any version.

A message newer than the consumer's contract is handled by the node's `badData` setting:

| `badData` | Result |
|---|---|
| `reject` | Refused and not retried; on a topic it goes to the DLQ or is dropped |
| `crash` | Retried: a poison message |
| `ignore` | Processed and counted as corrupt |

### Message fields and conditions

A source's `fields` gives every message it sends named values, for payload fields and headers alike: `"status=PAID:70|PENDING:30, items=0-4, region=eu|us"`. `name=a|b|c` picks one alternative (`:weight` sets its share); `name=1-500` picks a whole number in the range; `name=#3` gives each entity one of 3 values that never changes for it (a tenant or customer id). Fields travel with the message through services, topics, queues and tables; an action's `set` changes them on what that action sends.

A condition (`if` on an action, `cfg.if` on an edge into a consumer) is one or more tests joined with `&`:

| Test | True when |
|---|---|
| `status=PAID`, `status=PAID|SHIPPED` | the field equals one of the values |
| `status!=CANCELLED` | the field is absent or has another value |
| `amount>100`, `>=`, `<`, `<=` | numeric comparison |
| `priority`, `!priority` | the field is present / absent |
| `$type=OrderPaid` | the message type; `$key`, `$id` (request id), `$seq`, `$ver` are also available |

In `set`, a value starting with `$` copies another field or one of those built-ins (`sourceId=$id`, `was=$status`); `name=` removes a field. An action in the `error` path receives the field `error` with the failure reason.

### Provenance

Every node, edge and action may carry:

| Field | Meaning |
|---|---|
| `assumed` | List of its setting names whose values you did not find in code or config, e.g. `["rateMin", "rateMax"]` on a source, `["timeout"]` on an action. For an edge, names from `cfg`, `cfg.sub` and `cfg.poll` |
| `inferred` | `true` when the component or connection itself was not observed (a caller you deduced, an `ext` node standing for an unseen consumer). Nodes and edges only |
| `evidence` | `repo/path:line` for a node, shown in the editor |

A setting you leave out is a simulator default and is reported as such. The editor and `validate.js` then state how many settings are observed, assumed and defaulted, list what is inferred, and label the results as illustrative when arrival rates are assumed.

### Applications (`groups`)

A box on the canvas is one deployable. Its hierarchy:

- **Application** `{id, name, x, y, w, h, cfg, clusters}`. `cfg`: `startMs` 3000, `detectMs` 2000 (time until dead instances stop receiving traffic), `sticky` false (pin each key to one server group), `canarySteps` `"5,25,50,100"`, `canaryStepS` 6, `canaryRollback` 10 (error % that rolls a canary back; 0 = never), `routing` `any`|`local`|`localFirst`, `autoscale` false, `scaleMin` 1, `scaleMax` 10 (instances per server group), `scaleTargetPct` 70 (busy workers plus queued requests as a share of capacity), `scaleCooldownS` 10. Added instances serve after `startMs`.
- **Cluster** `{id, name, sgs}`: a shard. Requests are assigned to a cluster by key.
- **Server group** `{id, name, cfg, regions}`: one deployed build. `cfg`:
  - `weight`: share of its cluster's traffic.
  - `stopped` false: true = not running until a cut-over starts it.
  - `consume` `shared` (server groups split a topic between them) | `own` (this build has its own consumer group and also reads every message).
  - `emitVer` 0: when above 0, every message and call this build sends carries that contract version.
- **Region** `{id, name, instances}`.

Each service-kind, proxy and cache node inside the box runs once per server group. A scheduler inside the box runs once for the application. A deployable with no sharding, one build and no manifest detail is one cluster, one server group, one region.

### Regions and sites

Region names tie three things together: the `regions` of server groups, `region` on a source (where its requests come from), and `region` on a database, cache, topic, queue, pub/sub or third party (where it lives). Top-level `xRegionMs` (default 40) is the latency added each way to a call that crosses regions. None of this has any effect until a map sets a `region`, a `routing` other than `any`, or an `isolate` fault.

- A handler runs in one region of its server group and its calls carry that region onward. `routing: "any"` picks the region by instance count; `local` serves a request in the region it came from and fails it if that region has no live instances; `localFirst` fails over to another region, paying `xRegionMs` both ways. A request routed to a region waits for that region's instances even if another region is idle.
- A call to a component pinned to a different region pays `xRegionMs` each way.
- The region fault `isolate` cuts the **site of that name** off from everything outside it, in every application and for every component pinned to it. Calls across the boundary vanish (the caller times out); instances inside keep running and still reach what is inside. A component with no `region` counts as outside every site.

### Comparison groups (`lanes`)

Optional, and only useful when one file holds several alternative designs side by side (as the built-in library does), each with its own sources. A group is `{id, name}` in top-level `lanes` (id prefix `l`); a node joins one with `"lane": "<id>"`. The dashboard, audit and trade-offs can then be read per group. A group that contains sources is counted from them. A group with no source of its own is a branch behind a shared source (three consumers of one topic, each a different design): put only the branch's own nodes in it and leave the shared source and topic out. It is then measured where work enters it, and each anomaly counts against the group of the component where it happened. Leave `lanes` out and groups are made automatically: every connected set of components containing a source becomes one, and a `note` placed just above it (within 130 of its top edge) is removed and becomes the group's name and frame caption: `"A · Dual write — save, then publish"` gives the name `A · Dual write`. A map of one real system is one connected design and gets no groups; do not add them.

### Scenarios

`{id, name, desc, faults, heal, triggers}`. `faults` maps a target id to the fault fields to set. `heal` is seconds until everything is cleared (0 = stays).

| Target | Fault fields |
|---|---|
| producer | `pause`, `surge` (× traffic), `badPct` |
| service, store, external | `down`, `errorRate`, `latencyMult`, `hang`, `capacityPct` |
| cache | `down`, `errorRate`, `latencyMult` |
| log, queue | `down`, `errorRate`, `latencyMult`, `pause` (consumers) |
| pubsub, proxy | `down`, `errorRate` |
| edge | `partition`, `drop`, `respDrop` (work done, reply lost), `reset`, `deny` (credentials refused: fails fast, never retried), `corrupt`, `dup` (all %), `extraLatency` |
| application | `down`, `partition` |
| cluster | `down` |
| server group | `down`, `instDown` (count), `errorRate`, `latencyMult` |
| region | `down`, `isolate` (the whole site of that name, see [Regions and sites](#regions-and-sites)) |

`triggers` are one-off events:

- On a node, `{node, what}`: `crash`, `errOnce` (next request fails), `rebalance` (topic), `flush` (cache), `burst` (50 requests from a source), `fire` (run a scheduler now), `replay` (manual recovery: a `hold` queue delivers what rests in it, a queue or topic re-delivers its dead letters, a database re-queues its parked rows). After a replay the audit shows whether it repeated work that had already been done.
- On a server group, `{group, what}`: `kill` (one instance), `rolling` (rolling restart), `restore`.
- A cut-over, `{group, what: "cutover", from, mode}`: moves traffic from server group `from` to `group`, with `mode` `canary`, `bluegreen`, `highlander`, `ab` or `rollback`.

### Layout

Nodes are 176 × 76; a database grows by 20 per table. Lay each flow out left to right, about 250 apart horizontally and 130 apart vertically, one flow per row. Keep handlers of one deployable adjacent so one box encloses them, and leave databases and brokers outside the boxes. Leave about 70 of headroom above the first node in a box for its title and server-group strip, and make a box with several server groups at least 330 wide so their names fit.
