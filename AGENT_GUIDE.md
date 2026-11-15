# Mapping a codebase into Faultline

Faultline is a single-page simulator (`index.html`) that draws a system as components and connections, runs traffic through it, injects failures, and audits every request for lost, duplicated, partial or out-of-order effects. It loads a system from one JSON file through its **Import** button.

Your job: read one or more codebases and write that JSON file so it is a faithful map of how requests and messages actually flow, plus a report of what you could not represent.

**If an element of the application's architecture is missing from Faultline, call it out and say what would be needed to fill the gap.** This feedback is how Faultline gets more complete, so a precise gap is as valuable as a mapped node. See [Gaps](#gaps).

## What you deliver

1. **`<system>.faultline.json`**: the map, in the [file format](#file-format) below.
2. **`<system>.faultline-report.md`** with three sections:
   - **Evidence**: one row per node and per edge: its id, its name, and the `repo/path:line` that proves it exists and behaves as mapped.
   - **Assumed values**: every number or setting you set without finding it in code or config, and why you chose it.
   - **Gaps**: required even when empty. See [Gaps](#gaps).

Map what the code does, and name things what the code names them (service, topic, table, queue and endpoint names). A setting belongs in the JSON when the code or config states it; otherwise leave it out so the default applies, or list it under Assumed values.

## Procedure

Work through these in order. Each step ends when its criterion holds.

1. **List the deployables.** Every separately deployed unit in every repo: services, workers, schedulers, functions. *Done when every Dockerfile, deployment manifest, serverless config and process entry point is assigned to a deployable or listed as out of scope.*
2. **List every entry point of every deployable.** HTTP/gRPC routes, message subscriptions, scheduled jobs, table polling loops. *Done when every route registration, consumer/listener registration and scheduler registration in the code is on the list.*
3. **Trace each entry point to its side effects, in execution order.** Database writes and reads, cache calls, publishes, calls to other services and third parties. Record for each: transaction boundaries, timeout, retries, what happens on failure, whether the code waits for the result, and for messages the type, key and version. *Done when every outbound client call reachable from the handler appears in the trace or in Gaps.*
4. **Resolve shared infrastructure across repos.** The same topic, queue, database or table named in two codebases is one node. Match by the configured name, and record both sightings as evidence. A counterpart outside the codebases you were given (a caller or consumer you cannot find) becomes an `ext` node or a source, and a line in the report. *Done when every topic, queue, database and table name from step 3 maps to exactly one node.*
5. **Write nodes, edges and actions** using the [mapping rules](#mapping-rules) and [file format](#file-format). *Done when every entry point from step 2 is a node and every side effect from step 3 is an action, or a gap.*
6. **Write the deployment** (application boxes) from deployment manifests: shards, builds running side by side, regions, instance counts. *Done when every deployable from step 1 is an application box.*
7. **Write scenarios.** *Done when there is one per dependency that can fail (down), one per broker connection (duplicate delivery), and one per deployment cut-over the codebase's pipeline performs.*
8. **Validate** with `node validate.js <file>` (it needs `index.html` beside it). Without Node, re-check [Rules that break a file](#rules-that-break-a-file) by hand. *Done when it reports no errors and the report explains every remaining warning.*
9. **Read the audit** that `validate.js` prints for a healthy 30-second run: per source, how many requests ended lost, duplicate, partial, ghost, corrupt, out of order, stale or parked. An anomaly with no faults applied is either a real weakness in the system or a mistake in the map. *Done when each one is fixed in the map or explained in the report from the code.*
10. **Write the report.** *Done when every node and edge has an evidence row and every item in [Known gaps](#known-gaps) has been checked against the code.*

## Mapping rules

**One handler is one node.** A service-kind node has a single ordered action list that runs for every request it receives, whichever connection the request arrived on. A deployable with several entry points that do different work becomes several nodes, named `<deployable>: <entry point>` (`order-service: POST /orders`, `order-service: onPaymentSettled`), all placed inside the same application box. The exception is a single consumer that switches on the event type: keep it as one node and limit each action to its types.

**One caller behaviour is one source.** A client that calls two endpoints is two `client` nodes. Sources that act on the same entities share a `keyspace` (for example `"order"`), which is what lets the audit detect a reader seeing stale data from a writer.

**A connection out of a service-kind node is a call that node makes**, and needs an action. Order the actions as the code executes them.

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
| Outbox table read by a separate process | `queue` table + `poller` + the poller's publish action |
| Outbox handled by a library inside the service | publish action with `outbox: true` (the service must also write a database) |
| Read-through cache | service → `cache` edge (action `op: "read"`), plus `cache` → database edge |
| Read from a replica | `replica` node with `replicaLag` |

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

### Messaging

| In the code | In the map |
|---|---|
| SNS → SQS → consumer | `pubsub` → `queue` → `worker` |
| Consumers sharing a Kafka group id | same `cfg.sub.group` on their edges from the topic |
| Producer record key (`ProducerRecord(topic, key, …)`) | `cfg.pkey` on the edge into the topic: `entity`, `none` (null key) or `coarse` (tenant, region) |
| Event/message classes or a `type` discriminator | `types` on the source that originates them |
| Consumer ignores event types it does not handle | `cfg.types` on its edge from the topic, queue or table |
| `switch` on event type inside one handler | `types` on each action |
| Handler receives one event and publishes a different one | `as` on the publishing action |
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

- **Branching on anything but the message type.** An action can be limited to certain message types, or run only if the previous action failed. Branching on a field value, an amount, a feature flag or a lookup result is a gap.
- **Fan-out per item.** One request carries one entity key. A request that loops over N line items and writes or publishes once per item is a gap.
- **Message contents.** A message has a type name and a contract version only. Fields, schemas, compatibility rules beyond "newest version understood", and response bodies are gaps.
- **Keys other than entity / none / coarser.** A key unrelated to the entity (a second id), per-type keys and custom partitioners are gaps. Sharding and caching always use the entity key.
- **Delays and timers.** Delay queues, retries scheduled for a later time, TTL-triggered events and visibility delays. Only a subscription's retry backoff exists.
- **Locks and coordination.** Distributed locks, leader election and leases. Only a version check on a single database write exists (`guard`).
- **Workflow engines and orchestrators** (Temporal, Step Functions, Camunda). Only a fixed action list with compensation exists.
- **Stream processing.** Joins, windows, aggregations, compaction and stateful topic-to-topic topologies.
- **Change data capture from arbitrary tables.** Only a service's built-in outbox can use CDC; any other table is read by polling.
- **Database-to-database flows.** Replication topology, triggers, stored procedures and ETL between stores. Only a read replica's lag exists.
- **Long-lived connections.** WebSockets, server-sent events, gRPC streaming, long polling.
- **Region-aware behaviour.** Regions only hold instance counts. Per-region routing, failover order, data residency and cross-region latency are gaps.
- **Security and tenancy.** Authentication, authorisation, tenant isolation and secrets.
- **Autoscaling and resource limits.** Instance counts are fixed, with no memory, CPU or disk model.

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

- **Ids** are a prefix letter plus an integer, and every id is unique: `n` node, `e` edge, `a` action, `t` table, `g` application, `c` cluster, `v` server group, `r` region, `s` scenario. Use one counter for the whole file.
- **Every edge leaving a service-kind node needs exactly one action** in that node's `cfg.actions`, with `edge` set to the edge id. An edge without an action is never called. Nodes of other kinds have no actions.
- **A node whose `type` is not in the table below is dropped**, together with its edges.
- **Connection rules:**
  - Nothing connects *to* a source.
  - Third-party nodes never initiate a connection.
  - A database initiates a connection only from a `queue` table, and only to a service-kind node; the edge carries `cfg.table`.
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
- Requests: `op` `write`|`read`, `keys` 20 (distinct entity ids), `keyspace` `""`, `types` `""` (see [Message types and contracts](#message-types-and-contracts)), `badPct` 0, `dupPct` 0 (client double-submits).
- Waiting: `timeout` 2000, `retries` 0, `backoff` 200.
- `cron` adds: `mode` `schedule`|`rate`, `everyS` 15, `release` `"200"` (messages per run: a number, a repeating list `"0,0,0,2000"`, or a range `"100-300"`), `spreadMs` 0, `perInstance` false (true = every app instance fires its own copy, as with no leader lock).

A source sends each request to every node it is connected to.

**service**

- Capacity: `concurrency` 8, `procMs` 20, `queueCap` 100 (rejects when full), `rateLimit` 0 (off), `restartMs` 3000.
- Behaviour: `respond` `after`|`ack`, `idempotent` false, `badData` `reject`|`crash`|`ignore` (also applies to a contract version the node does not understand), `contract` `""`, `actions` [].
- Built-in outbox relay, used by actions with `outbox: true`: `outboxMode` `poll`|`cdc`, `outboxPollMs` 100, `outboxBatch` 50, `outboxSend` `seq`|`parallel`, `outboxMark` `each`|`batch`, `outboxTimeout` 500.
- Built-in inbox: `inbox` false, `inboxPollMs` 200, `inboxBatch` 20, `inboxMax` 5, `inboxCap` 10000.
- Type defaults differ: `worker` concurrency 4; `poller` concurrency 4, procMs 5; `fn` concurrency 100, procMs 40, queueCap 10.

Use explicit tables and a `poller` when the code has a separate relay or inbox processor; use the built-in options when a library does it inside the service.

**store:** `latency` 5, `maxConc` 20 (connection pool), `queueCap` 200, `idempotent` false (upsert / unique key), `supportsTx` true, `replicaLag` 0, `tables` []. `nosql`, `blob` and `search` default to `supportsTx` false and `idempotent` true.

Tables (`cfg.tables`) are `{id, name, kind}`:

- `data`: an ordinary table.
- `queue`: a work table (inbox, outbox, job table). Rows written to it wait until a polling loop connected to it reads them.
- `dedupe`: a unique-key table. A repeated message's insert is rejected and the handler skips the rest of its actions.

**external:** `latency` 150, `maxConc` 100, `queueCap` 100, `rateLimit` 0, `idempotent` false.

**cache:** `latency` 1, `ttlMs` 10000, `capacity` 1000, `onWrite` `update`|`invalidate`, `writeThrough` false, `timeout` 1000.

**log:** `latency` 3, `partitions` 4, `retention` 5000 (messages per partition), `rateLimit` 0, `idempotent` false (idempotent producer).

**queue:** `latency` 4, `capacity` 10000, `fifo` false, `rateLimit` 0, `idempotent` false.

**pubsub:** `latency` 3, `retries` 1, `timeout` 2000.

**proxy:** `latency` 1, `strategy` `rr`|`random`|`least`|`sticky`, `rateLimit` 0, `hitRatio` 0 (edge cache, % of reads), `healthEject` false, `ejectAfter` 3, `ejectMs` 5000, `retryNext` false, `timeout` 5000.

### Edges

`{id, from, to, cfg}`. What an edge means depends on where it starts:

| From | Meaning | Extra `cfg` |
|---|---|---|
| source | sends requests to the target | `pkey` when the target is a topic |
| service-kind | a call made by an action | `table` when the target database has tables; `pkey` when the target is a topic |
| proxy | a target it balances across | |
| topic or queue | a subscription | `sub`, `types` |
| pubsub | push delivery to a subscriber | `types` |
| database `queue` table | a polling loop reading that table | `table`, `poll`, `types` |
| cache | read-through to its backing database | |

| `cfg` field | Applies to | Values |
|---|---|---|
| `latency` | every edge | Network latency each way, default 2 |
| `table` | edges to or from a database with tables | A table id on that database |
| `pkey` | edges into a topic or stream | `entity` (default; one entity's messages share a partition and stay in order) \| `none` (round-robin; one entity's messages can overtake each other) \| `coarse` (keyed by a coarser grouping such as tenant) |
| `pkeyN` | with `pkey: "coarse"` | Number of distinct key values, default 3 |
| `types` | edges from a topic, queue, pub/sub or table into a service-kind node | Consumer-side filter such as `"OrderCreated, OrderCancelled"`. Other messages are still delivered and acknowledged but run no actions. Empty = everything |
| `sub` | edges from a topic or queue | See below |
| `poll` | edges from a `queue` table | See below |

**`cfg.sub`:** `ack` `after` (at-least-once) | `before` (at-most-once), `maxAttempts` 3, `backoff` 500, `onExhaust` `dlq`|`skip`|`block`, `timeout` 5000 (redelivered if not finished), `prefetch` 10, `group` `""`. On a topic, subscriptions with the same `group` form one consumer group and split the partitions; an empty `group` is a group of its own.

**`cfg.poll`:** `everyMs` 200, `batch` 20, `send` `keyed` (parallel, one at a time per key) | `seq` (strict order) | `parallel` (unordered), `mark` `each`|`batch` (how rows are marked done), `maxAttempts` 5, `backoff` 1000 (wait after a failed batch), `onExhaust` `park`|`block`, `timeout` 5000 (row lease).

### Actions

`{id, edge, ...}` in a service-kind node's `cfg.actions`, in execution order.

| Field | Default | Meaning |
|---|---|---|
| `op` | `write` | `read` has no side effects and is ignored by the audit |
| `tx` | false | Database write committed only if the whole handler succeeds. All `tx` actions of a handler on one database commit together after the last action |
| `guard` | false | Database write only: refused unless newer than the stored row (a version check). Late and repeated updates change nothing |
| `outbox` | false | Publish through the service's built-in transactional outbox |
| `onError` | `abort` | `abort` returns an error and leaves earlier non-transactional effects in place; `continue` ignores the failure; `compensate` undoes earlier actions |
| `when` | `always` | `fallback` runs only if the previous action failed |
| `types` | `""` | Run this action only for these message types. Empty = always |
| `as` | `""` | The message or call this action sends has this type (`Name` or `Name@version`) instead of the type being handled |
| `await` | true | false = fire-and-forget |
| `timeout` | 1000 | |
| `retries` | 0 | |
| `backoff` | 100 | Exponential with jitter |
| `breaker` | false | Circuit breaker: fails fast after 5 consecutive failures |
| `failPct` | 0 | This step fails on its own this often |

### Message types and contracts

A message carries an optional type name and a contract version (1 unless stated). They travel with it through services, topics, queues and tables until an action re-types it with `as`, or a server group's `emitVer` overrides the version of everything that build sends.

One list syntax, `Name[@version][:weight]` separated by commas, serves three settings:

- **Source `types`**, the mix it sends: `"OrderCreated:60, OrderUpdated:30, OrderCancelled@2:10"`.
- **Filters** (edge `cfg.types`, action `types`): `"OrderCreated, OrderCancelled"`.
- **Service `contract`**, the newest version it understands per type: `"OrderCreated@2, *@1"`. `*` covers every type not listed, including untyped messages. A type with no entry and no `*` is accepted at any version.

A message newer than the consumer's contract is handled by the node's `badData` setting:

| `badData` | Result |
|---|---|
| `reject` | Refused and not retried; on a topic it goes to the DLQ or is dropped |
| `crash` | Retried: a poison message |
| `ignore` | Processed and counted as corrupt |

### Applications (`groups`)

A box on the canvas is one deployable. Its hierarchy:

- **Application** `{id, name, x, y, w, h, cfg, clusters}`. `cfg`: `startMs` 3000, `detectMs` 2000 (time until dead instances stop receiving traffic), `sticky` false (pin each key to one server group), `canarySteps` `"5,25,50,100"`, `canaryStepS` 6, `canaryRollback` 10 (error % that rolls a canary back; 0 = never).
- **Cluster** `{id, name, sgs}`: a shard. Requests are assigned to a cluster by key.
- **Server group** `{id, name, cfg, regions}`: one deployed build. `cfg`:
  - `weight`: share of its cluster's traffic.
  - `stopped` false: true = not running until a cut-over starts it.
  - `consume` `shared` (server groups split a topic between them) | `own` (this build has its own consumer group and also reads every message).
  - `emitVer` 0: when above 0, every message and call this build sends carries that contract version.
- **Region** `{id, name, instances}`.

Each service-kind, proxy and cache node inside the box runs once per server group. A scheduler inside the box runs once for the application. A deployable with no sharding, one build and no manifest detail is one cluster, one server group, one region.

### Scenarios

`{id, name, desc, faults, heal, triggers}`. `faults` maps a target id to the fault fields to set. `heal` is seconds until everything is cleared (0 = stays).

| Target | Fault fields |
|---|---|
| producer | `pause`, `surge` (× traffic), `badPct` |
| service, store, external | `down`, `errorRate`, `latencyMult`, `hang`, `capacityPct` |
| cache | `down`, `errorRate`, `latencyMult` |
| log, queue | `down`, `errorRate`, `latencyMult`, `pause` (consumers) |
| pubsub, proxy | `down`, `errorRate` |
| edge | `partition`, `drop`, `respDrop` (work done, reply lost), `reset`, `corrupt`, `dup` (all %), `extraLatency` |
| application | `down`, `partition` |
| cluster | `down` |
| server group | `down`, `instDown` (count), `errorRate`, `latencyMult` |
| region | `down` |

`triggers` are one-off events:

- On a node, `{node, what}`: `crash`, `errOnce` (next request fails), `rebalance` (topic), `flush` (cache), `burst` (50 requests from a source), `fire` (run a scheduler now).
- On a server group, `{group, what}`: `kill` (one instance), `rolling` (rolling restart), `restore`.
- A cut-over, `{group, what: "cutover", from, mode}`: moves traffic from server group `from` to `group`, with `mode` `canary`, `bluegreen`, `highlander`, `ab` or `rollback`.

### Layout

Nodes are 176 × 76; a database grows by 20 per table. Lay each flow out left to right, about 250 apart horizontally and 130 apart vertically, one flow per row. Keep handlers of one deployable adjacent so one box encloses them, and leave databases and brokers outside the boxes. Leave about 70 of headroom above the first node in a box for its title and server-group strip, and make a box with several server groups at least 330 wide so their names fit.
