<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

# Task authority storage

## Managed mode is OFF (decided 2026-10-20)

Production runs the task partition unmanaged: no `tasks` row exists in
`task_runtime_authorities` and every writer passes no token. `AuthorityStore.initialize()`,
the only path that creates an authority row, throws `ManagedAuthorityDisabledError`
(code `managed_authority_disabled`) outside a non-production vitest process
(`enableManagedAuthorityForTesting()` switches it in tests). `assertTaskAuthorityUnmanaged(sql)`
fails when a `tasks` row exists, because every tokenless write would then fail with
`stale_authority`; the dedicated worker runs it at startup. Unmanaged queue writes are
not journaled: `withTaskQueueWrite` calls the queue directly so the caller sees the
original error and runs its own compensation. Every process (web producers included)
still refuses tokenless queue writes with `stale_authority` while a `tasks` row exists,
re-checking `NOT EXISTS` at most every 30 s; tokenless SQL writes check it in each
transaction (`withUnmanagedWrite`). The reconciler's journal janitor exports the pending-row gauges, removes
stale ownerless rows left by older builds and only logs stale managed rows.

Known managed-mode defects, to fix before anyone enables it:

- The mirror lease is never renewed (`store.ts` `renew`, no caller).
- Tokenless web producers are refused once a row exists (`store.ts` `withUnmanagedWrite`),
  and nothing hands web replicas a token.
- A crashed handover cannot be aborted (`handover.ts` `open`, the journal stays in
  `closing`/`quarantined`).
- The drain barrier blocks on delayed jobs and on stuck `task_history` rows
  (`handover.ts` `assertQueuesDrained` / `assertHistoryDrained`).
- Replaying a teardown after a lost acknowledgement conflicts (`store.ts`
  `confirmExpiredTeardown`).
- A receipt replay from a stale generation is accepted (`store.ts` `withMutation`).
- Valkey `TIME` and the PostgreSQL clock can disagree on lease expiry
  (`lib/server/tasks/lua/ownership-fence.lua`).

The rest of this file describes the managed design as built.

This is additive storage for the executor migration. It does not activate a queue
consumer. Participating existing history, runner/orchestrator mirrors, coverage
and deferred replay writers now use transaction fences. Production executor admission reads the
actual durable owner kind and rejects Rust ownership while the fixed readiness
gates remain unresolved.

`AuthorityStore` keeps monotonic decimal-string generations, boot-specific owner
UUIDs, database-clock leases, command receipts and execution drain records.
`withMutation` locks the authority row throughout its PostgreSQL callback and
receipt write, then checks the lease again. A callback failure or expired lease
rolls back both mutation and receipt. Duplicate command IDs return the original
receipt only when canonical payloads match. Receipt lookups can recover an
acknowledgment lost after commit without repeating work.

A mutation callback must await every query on the supplied transaction, must not
retain that transaction, and must not perform Redis, HTTP or filesystem effects.
This is a trusted application API, not a plugin sandbox or a restriction on a
caller possessing the database role. External effects remain at least once and
need idempotency or explicit reconciliation.

An admission records its invocation, dispatch, run, task and original authority.
Duplicate admissions fail; query `lookupExecution` after an uncertain acknowledgment.
`beginDrain` closes admission atomically. `settleExecution` records only that the
actual invocation continuation ended; it does not prove heartbeat, deferred
writes, plugin background work, SQL connections or descendant processes stopped.

Handoff additionally requires a separate `confirmDispatchTeardown` attestation
for every dispatch, bound to its generation and owner. The trusted supervisor
must establish both process-group termination and executor SQL connection drain.
The ordinary executor completion path never supplies that attestation. Escaped
plugin descendants and direct SQL/Valkey writers remain activation blockers.

An expired lease cannot be renewed or accept a successful completion. After an
explicit drain, `confirmExpiredTeardown` records a quiescent invocation with an
UNKNOWN outcome. The separate process/SQL teardown attestations are still
required before `recoverDrained` can transfer the exact expired generation to a
newer TypeScript compatibility owner. Expiry alone never authorizes takeover.

Existing task mutations use `withExistingTaskWrite` with an immutable original
`tasks` token. Its short transaction holds the authority lock through SQL and a
final lease check. These mirror writes do not create command receipts. Tokenless
compatibility is allowed only while the global task partition is unmanaged. A
shared advisory transaction lock serializes those writes against first ownership
initialization, closing the absent-row race. Never delete the authority row to
restore tokenless access. Arbitrary task/plugin SQL remains outside this boundary.

Deferred entries store their originating authority, including through outages;
stale entries are quarantined with their payload rather than replayed under a new
owner. Coverage writes use separate short transactions around execution; plugin
execution is never held inside the authority transaction. Administrative retention,
GDPR and media invalidation still require separate writer policy and qualification.

Valkey mirrors use independent atomic Lua validation and persistent managed
markers. PostgreSQL and Valkey are not a distributed transaction. The control
plane must close admissions, drain all writers/processes/SQL, quarantine each
coordination and cache mirror, reconcile partial or UNKNOWN outcomes, transfer
durable generation, and install verified snapshots explicitly. Complete mirror
loss must be reconciled from durable state before startup admits tokenless work.
No executor installs or renews its own mirrors, and no such production activation
protocol is enabled by these helpers. Both cache and coordination instances need
fences when they are separate; progress publication is fenced on its cache client.
