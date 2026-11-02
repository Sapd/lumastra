<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

# PostgreSQL queue pilot

This is an opt-in, isolated qualification suite for the published **BullMQ 6.3.15** PostgreSQL
backend and **pg 8.23.1**. It does not change application startup, queue selection, workers,
production dependencies, or deployment. The application lock already selects BullMQ 6.3.15;
the nested development project avoids trusting a stale ancestor `node_modules` installation.

Run from the app directory through the sanctioned remote test runner. Its normal setup installs
the app's locked dependencies first; compatibility fixtures use the existing app `esbuild`.
The isolated package needs its own `npm ci` as well:

```sh
lumastra-remote --slot bmq-pg-pilot 'npm --prefix tests/queue-postgres-pilot ci --ignore-scripts && BULLMQ_PG_PILOT=1 npm run test:queue:postgres'
```

The runner supplies `TEST_DATABASE_URL`. To run safety guards alone without database access:

```sh
lumastra-remote --slot bmq-pg-pilot npm --prefix tests/queue-postgres-pilot run test:safety
```

The core PostgreSQL tests fail if opt-in or a sanctioned test endpoint is absent; they do not
silently skip. `DATABASE_URL` is never a fallback. `PILOT_DATABASE_URL`, if supplied, takes
precedence and is subject to the same checks: `postgres`/`postgresql`, an explicit user, loopback
host, port 5432 or 5434, and database exactly `lumastra_tests` or `lumastra_t_<slot>` (lowercase
letters, digits, underscores). URL query connection overrides are rejected except `sslmode`.
Do not point this suite at a production, preproduction application, or development database.

Each harness creates a random `pilot_bmq_<uuid>` schema with `CREATE SCHEMA` (no adoption of an
existing schema), writes an ownership marker, and calls the published
`runMigrations(checkedOutClient, schema)` API explicitly. The harness checks the actual namespace
and migration ledger. Cleanup requires the exact original schema name, OID, owner and marker;
it closes workers/events/producers and their pools, then drops only that run-owned schema.
It never flushes shared queues or drops an existing application schema. Bounded cleanup errors
fail the run, including errors that BullMQ emits while resolving `Worker.close()`.

Backend resources use separate owned pools, each capped at two query connections. BullMQ
6.3.15 owns a separate dedicated LISTEN connection for each relevant resource. The control pool
is independent and capped at two. Queue and connection names contain the immutable run nonce.
Credentials and database URLs are not logged by the harness.

Cleanup assumes a controlled isolated runner slot: no hostile concurrent DDL and no
cross-namespace dependencies attached to the run's objects. Namespace identity validation
does not protect against a privileged actor replacing the schema between check and drop,
or `CASCADE` following an external dependency. This is not a general cleanup utility.

PostgreSQL event cursors use decimal bigint strings (`lastEventId: '0'` for full replay), not
Redis's `0-0` stream cursor. A `Job` retains the resource that loaded it: after closing an old
worker, reload the job through an open queue before testing its old claim token. The pinned
backend intentionally leaves queries against a closing connection pending, so using that old
worker's Job would hang instead of establishing an ownership fence.

| File                       | Evidence                                                                                                                                                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safety.test.mjs`          | Fail-closed opt-in/endpoint checks before dependency loading or connection; cleanup identity guards                                                                                                                                                                    |
| `isolation.test.mjs`       | Real database sentinel preservation and marker-drift cleanup refusal                                                                                                                                                                                                   |
| `core.test.mjs`            | Persisted payload/progress/results and events; identity/dedup; priorities/delay; retry/permanent failure; pause/concurrency; tree flows and dynamic real-child parking; renewal/stale ownership/recovery; real cancellation; scoped LISTEN connection failure/recovery |
| `process-crash.test.mjs`   | Real separate Node worker SIGKILL after a public active claim; bounded stalled recovery; dead-token renewal/completion/failure refusal through an open producer; conserved accepted identities and persisted result/attempt accounting                                 |
| `compatibility.test.mjs`   | Actual unchanged TypeScript SDK definitions and builtin task processor through PostgreSQL jobs; see `application-compatibility.md` for the host boundaries                                                                                                             |
| `retention-paths.test.mjs` | Real ordinary-insert trimming and two-queue global-ID trimming starvation; characterizes the retention blocker                                                                                                                                                         |
| `performance.test.mjs`     | Bounded submission/processing sample and actual PostgreSQL durability/connection settings; interpret only as pilot observations                                                                                                                                        |

The dynamic waiting-children probe establishes a queue API capability. It does not establish
that the current application runtime uses that mechanism. `moveToWaitingChildren()` without
pending dependencies returns false, so it is not a replacement for arbitrary application
manual parking.

Published event retention remains unqualified. `retention-paths.test.mjs` distinguishes
three public paths in BullMQ 6.3.15: ordinary inserts can trim after metadata initialization;
bulk insertion retains all 256 waiting events with `streams.events.maxLen` set to four;
and alternating progress writes across two active queues can starve one queue's trimming.
The published SQL reads the stored queue limit but triggers ordinary trimming only when
the **global** event ID is divisible by 256. The two-queue test observes actual event IDs
and retains all 768 progress events for one queue despite its configured limit of four.
A green characterization reproduces these gaps; it does not qualify bounded retention.
`trimEvents` is unsupported by this PostgreSQL backend. No private-table janitor,
synthetic trimming jobs, upstream fork or version change hides the blocker.

Scoped LISTEN termination is a real connection fault and must observe the resulting error before
successful reconnection and delivery. It does not establish lost commit acknowledgement behavior.
A true lost-ACK probe must interrupt transport after a committed write and before its response;
replacing `add()` with a fake rejection would not qualify it. If no separate fault-proxy probe is
present and passing, unknown commit acknowledgement remains unqualified.

Passing these tests does not establish task runtime parity, cluster/watchdog/pipeline recovery,
raw Redis/Lua administrative operations, plugin host capability parity, or safe removal of
Valkey. No production activation is included. The sanctioned test runner may disable `fsync`;
its timings cannot establish production durability or production throughput.

The harness uses the factory as the last public constructor argument for `Queue`, `Worker`,
`QueueEvents` and `FlowProducer`. It does not set a process-wide default or import private
BullMQ internals. Its source of API truth is the exact published 6.3.15 archive and the upstream
[PostgreSQL guide](https://docs.bullmq.io/guide/postgresql),
[PostgreSQL factory API](https://docs.bullmq.io/api/variables/v6.createPostgresBackend.html), and
[node-postgres pool API](https://node-postgres.com/apis/pool). The pinned release's migration
signature and connection ownership take precedence over documentation for newer versions.

The core abandoned-claim fixture closes a worker forcefully in the same process. The separate
`process-crash.test.mjs` starts a real Node child against the exact parent-owned schema, verifies
its public claim, kills only that child with SIGKILL, and requires bounded recovery of all three
accepted jobs. While the successor holds the original job, its dead token must fail renewal,
completion and failure settlement through the open producer; persisted attempts and results
must agree after completion. Every failure path reaps the child before schema cleanup. This
qualifies abrupt worker death only when the opt-in test actually passes; it does not establish
database-crash durability or application side-effect safety. The production plugin loader/context
gate remains separate; the SDK-definition fixture does not complete B01.
