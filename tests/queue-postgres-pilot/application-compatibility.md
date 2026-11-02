<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

# Application compatibility boundary

This package qualifies a PostgreSQL-backed BullMQ queue independently of the
running application. Passing it does **not** qualify moving all current plugins,
the filesystem watcher, or the task control plane into a new container.

## Actual TypeScript exercised

`compatibility.test.mjs` compiles the current SDK **source**, the existing
`src/lib/server/tasks/builtin/native/dummy-sync.ts` source, and an ordinary SDK
plugin fixture with the application's existing esbuild. Neither plugin imports a
queue implementation or changes its SDK imports. Generated ESM lives in a
per-run temporary directory and is deleted after the test.

The test calls the actual `defineTask`, Zod input schema, identity function,
`TaskError`, and `execute` definitions inside a real PostgreSQL BullMQ processor.
It checks persisted queue results/progress, attempt metadata, transient retry,
explicit permanent/fatal no-retry mapping, and the builtin's ordinary failure
and cooperative `AbortSignal` response. Missing compiler/source/backend causes a
failure; these checks never silently skip.

The **context is the real SDK-testing `mockContext` helper**, with progress wired
to `Job.updateProgress`, metadata supplied from the real job, and an
`AbortController`. It is not `TaskRunner`'s production context. The builtin's
single import-time registry dependency is replaced at compile time by a
registration-only sink; the plugin body and SDK factory are unchanged. The
production registry, external loader, plugin install/signature checks,
capability gates, actual SQL/catalog/cache/secrets/http services, and process
supervisor are not exercised here. A direct abort is not the application's
distributed cancel channel. A plugin returning `{success:false,stopReason:
'aborted'}` is queue-**completed** in this small processor; application
`task_history.state='cancelled'` requires the real runner and is unqualified.

The fixture maps non-transient `TaskError` to BullMQ `UnrecoverableError` only to
exercise that public queue API. Production `classifyError`, circuit breakers,
exclusivity release, retry state reseeding, event publication, and terminal SQL
writes still need integration qualification. No plugin ABI change is established
or required by this test; it also cannot establish full ABI parity by itself.

## Bounded source inventory

Inventory scope: production TypeScript in `src/lib/server/tasks/` and
`src/task-runtime/`, plus queue connection callers. Tests/benchmarks/generated
files are excluded. In the table, `tasks/` abbreviates
`src/lib/server/tasks/`; other paths are relative to the application root. This is a
review of observed seams, not proof that no other plugin or dynamic import uses
Redis. An installed external plugin can contain arbitrary host-trusted code.

| Source seam                                                                                                             | Current behavior                                                                                                                                                                         | Qualification / required action                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks/runner.ts:958`, `:1011`; `tasks/task-queue-registry.ts:77`; `tasks/orchestrator.ts:637`, `:664`, `:754`, `:1287` | Creates Queue/Worker/QueueEvents/FlowProducer using Redis connection settings and prefixes.                                                                                              | Public queue surface is a plausible port. The pilot's core cases qualify only the APIs they assert. Production constructors must explicitly use the PostgreSQL backend; changing the database URL alone does not switch them.                                                                        |
| `tasks/connection.ts`                                                                                                   | Builds/shares IORedis connections and Redis-specific configuration.                                                                                                                      | **Needs port** for queue connections. App Valkey services can remain independently until their own replacement is qualified.                                                                                                                                                                         |
| `task-runtime/executor/bullmq.ts:77-94`                                                                                 | Creates a Redis Queue, reloads `Job.fromId`, checks active state, verifies `extendLock` result against a supplied token.                                                                 | **Migration blocker unchanged.** Existing executor cannot load a PostgreSQL job through this Redis-configured bridge. The pilot does not modify or activate it. Use native Node PostgreSQL BullMQ Worker dispatch in a future host port; requalify any retained token bridge against that backend.   |
| `tasks/runner.ts:1318-1330`, `:1437-1450`                                                                               | Capacity deferral invokes job `moveToDelayed(timestamp,token)` and throws `DelayedError`.                                                                                                | Public API, but **production deferral semantics unqualified** until tested with the real budget/per-task limits and runner state transitions. Core queue deferral coverage is necessary but insufficient.                                                                                            |
| `tasks/runner.ts:1700`; `tasks/state-machine.ts:146`; `tasks/lua/claim-run.lua`                                         | Separate application ownership claim over Valkey run hashes, beyond the queue's own lock.                                                                                                | **Needs port or explicit retention.** PostgreSQL BullMQ job claiming does not replace the custom run ownership/state machine.                                                                                                                                                                        |
| `tasks/state-machine.ts`; `tasks/identity.ts`; `tasks/lua/fenced.ts:91-94`; `tasks/lua/loader.ts`                       | Atomic run/stage transitions, identity dedup, fenced `EVALSHA`/`EVAL` and raw Lua loading.                                                                                               | **Needs port or explicit retention.** PostgreSQL backend cannot execute these custom Redis Lua scripts. Must preserve owner fencing, compare-before-write and dedup behavior in SQL if removed.                                                                                                      |
| `tasks/orphan-sweep.ts:248-252`, `:367-371`                                                                             | Reads BullMQ's raw `<qualifiedName>:<id>:dependencies` SET and probes raw child-job hash keys using Valkey `SMEMBERS`/`EXISTS`.                                                          | **Needs port.** These Redis internals cannot describe PostgreSQL dependencies. Queue public dependency/state APIs or explicit SQL queries require equivalent orphan tests.                                                                                                                           |
| `tasks/hard-kill.ts:433-475`                                                                                            | Fallback Lua directly removes queue active/waiting lists, prioritized/delayed/waiting-children sets, job hash, lock and dependency keys; graceful branch uses `moveToFailed` with token. | **Needs port.** Public job failure support does not qualify direct Redis key deletion. Preserve acknowledged cleanup, parent dependency updates, cancellation intent and events under failures before enabling hard kill on the new backend.                                                         |
| `tasks/budget-semaphore.ts:131-145`; `tasks/leader-lock.ts`; `tasks/shared-rate-bucket.ts`                              | Redis Lua/TTL counters, fenced leader lease, shared provider rate limit.                                                                                                                 | **Needs port or explicit retention**, with contention/crash/expiry tests. Queue global concurrency and queue rate limiting alone do not prove cross-task physical-class budgets or provider dependency limits.                                                                                       |
| `tasks/cancel-channel.ts:58`; `tasks/runner.ts`; `tasks/orchestrator.ts`                                                | Valkey PUBLISH/subscription and run-state transitions propagate application cancellation.                                                                                                | **Unqualified.** The fixture's direct signal demonstrates cooperative task behavior only. Cross-process cancel delivery, cancellation terminal state and no later writes need real-runtime tests.                                                                                                    |
| `tasks/log-buffer.ts`; `tasks/run-resume.ts`; `tasks/observability/*`; `tasks/context-primitives.ts`                    | Redis logs/checkpoints/heartbeats and plugin namespaced cache; additional application coordination.                                                                                      | **Needs port or explicit retention** independently of the queue. The SDK test helper's in-memory stores are not evidence for these services.                                                                                                                                                         |
| `tasks/global-pause-reconcile.ts:151-167`, `:174-219`; queue pause/resume admin callers                                 | Constructs transient Redis Queues, pauses/resumes them and maintains separate Valkey flags/quiet-hours metadata.                                                                         | **Needs port** of queue construction and actual pause targeting. Queue-only pause tests do not qualify class mapping, reconciliation exemptions or UI flags.                                                                                                                                         |
| `tasks/pipeline-builder.ts`; `tasks/orchestrator.ts:754`; `tasks/runner.ts:3529`                                        | Creates FlowProducer trees; runner currently comments that dynamic FlowProducer + `moveToWaitingChildren` could be added in future.                                                      | Static flow behavior is only qualified by corresponding pilot assertions. No active production `moveToWaitingChildren` call found in this scope; comments are not a supported application feature. Dynamic waiting-children is a separate core queue probe, not proof of current runner integration. |
| `tasks/builtin/native/file-delta-ingest-queue.ts`; `file-delta-ingest.ts`; `file-reconcile-skips.ts`                    | Filesystem change ingestion uses Valkey pending/processing lists and skip windows independently of BullMQ jobs.                                                                          | **Needs port or explicit retention.** A queue swap alone does not move watcher durability, replay, skip handling or file side effects to PostgreSQL.                                                                                                                                                 |

There was no live `queue.client`/`job.queue.client` or custom BullMQ `scripts.*`
extension found in this bounded task/runtime scan. Raw queue-key access above
is already an escape hatch and is sufficient to block a blanket compatibility
claim. This finding does not audit every third-party plugin or all repository
Redis usage.

## Remaining host qualification before rollout

The intended host is a lean Node/TypeScript worker using native PostgreSQL
BullMQ, preserving the SDK and existing TypeScript task/plugin definitions. This
pilot adds no Rust controller, no custom replacement queue, and no activation
selector. Keeping watcher lifecycle in the task container is an architectural
requirement, not a result proven by these tests.

A production host still needs the actual loader/registry and production context
builders; background service and feature startup hooks; filesystem watcher
startup/drain/replay; all required mounts, credentials and subprocess tools;
bounded shutdown and descendant termination; and authoritative run/history/event
writes. Test those in the task container before routing any existing task there.

Qualification must be per task and capability. HTTP providers, ffmpeg/media
tasks, SQL migrations, secrets/user credentials, backlog/drain/checkpoint/resume,
dynamic schedules, pipeline conditions, watch-sync auto-tasks, worker-thread
isolation, external multi-contract bundles and long-lived integration/feature
hooks are **not qualified by this fixture**. The non-task contracts (provider,
trickplay, watch-sync, feature, integration, external-service, media-source,
subtitle, lyrics and auth provider) also have independent lifetime assumptions.
External tasks requesting worker isolation already have loader restrictions;
the queue backend does not lift them. Preserve installed plugin trust/restart
semantics and do not infer "all original plugins supported" from successful
`defineTask.execute` calls.
