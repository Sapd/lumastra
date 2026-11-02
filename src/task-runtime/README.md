<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Task runtime migration boundaries

The dedicated lean TypeScript host is the task runtime. The web process serves
requests and submits work; exactly one worker runs the existing TypeScript tasks
and plugins, scheduler and supervised Rust watcher child in the same container.
Combined web/task execution is unsupported. The host uses the same task registry
and lifecycle; `build:task-runtime` also builds a
consumer-free `build/task-executor.js` child and a small
`build/task-executor-guardian.js` process for the execution bridge.

The executor is launched through `startExecutorProcess`, with an exact authority
token and an explicit list of audited task IDs. It loads normal builtins and
external SDK plugins, validates persisted job identity and the supported BullMQ
lock API, and uses the existing `TaskRunner` context, policies and result paths.
It creates no BullMQ consumer, scheduler, watcher or orchestrator. Arbitrary
feature startup hooks are not run, so tasks needing additional services must be
audited before inclusion. This does not change existing plugin behavior.

The parent owns the BullMQ claim, renewal and finalization, and sends the exact
claim lock duration with each dispatch so validation cannot shorten its lease. The child returns
completed, delayed, waiting-children, unrecoverable, failed or unknown outcomes;
plugins do not need to implement this protocol. IPC uses bounded versioned
frames, a private owned socket directory and a per-process credential delivered
through inherited Node IPC. A separate bounded control socket preserves status,
cancellation and drain access when execution connections are full. The client
never retries an uncertain operation.
Query its durable execution admission/result before deciding how to reconcile.

`processJob` finishing is not proof that an inline plugin stopped. Executor-mode
runners track the actual execution continuation separately. Local drain remains
blocked while that work continues. An independent guardian runs no plugin code,
monitors controller loss and escalates ordinary POSIX process groups through TERM
and KILL, reporting whether the group disappeared. A CPU-blocked executor cannot
block the guardian.
It cannot contain a plugin that deliberately detaches into another group.

Durable invocation settlement is also distinct from ownership handoff: runtime
background writes and SQL connections can outlive a task invocation. Authority
storage requires separate process and SQL teardown attestations before transfer.
The ordinary completion path never supplies those attestations. The current
supervisor proves only its process-group boundary; it does not certify server-side
SQL cancellation or escaped children.

Rust-owned dispatch is rejected at the child entry point using the actual owner
kind in PostgreSQL. Fixed readiness blockers cover existing unfenced SQL,
Valkey/Lua, queue/recovery writers and external capabilities. There is no
production Rust owner selector. These helpers and their tests cannot waive the
remaining all-writer, coherent-partition, image, resource and soak gates.

The participating mutation paths retain their runtime's original authority:
existing history insertion, runner/orchestrator SQL mirrors, coverage transitions,
deferred SQL replay, state-machine Lua, progress and selected direct keyed writes.
Missing tokens reject managed boundaries rather than borrowing a successor token.
This is a global coherent `tasks` partition; command/run-attempt adoption, queue
publication/events, recovery, shared budgets, administrative writers and raw
capabilities are still subject to the fixed activation gates. The dedicated TypeScript worker preserves the existing SDK/task execution paths.

## Web recovery and endpoint validation

`TASK_CACHE_URL` is required. If `CACHE_URL` is configured, it must point to a
different server endpoint; database numbers, credentials and redis/rediss do not
isolate server-wide eviction policy. Equivalent host spellings and default ports
are normalized without DNS or network work at import. Different DNS aliases can
still address the same server, so deployment configuration must keep the instances
distinct. There is no task/coordination fallback to the disposable cache.

Web producer initialization retries transient dependency failures with exponential
backoff from one to thirty seconds. Concurrent callers share the current attempt;
successful stages and feature startup are retained across later-stage failures.
Permanent endpoint configuration errors fail immediately. Shutdown cancels retry
timers and prevents late initialization stages from starting.

## Dedicated startup and shutdown evidence

`start-worker.sh` runs the dedicated entry with `WORKER_MODE=enabled` and
`DEDICATED_WORKER=true`; `start.sh` runs only the web role with
`WORKER_MODE=disabled`. No task-runtime opt-in is required; obsolete runtime values fail clearly.
It preserves the current queue backend and strict coordination/watcher startup.
A signal immediately drops readiness and cancels later startup stages; an already
running startup hook must settle before cleanup begins. Repeated TERM/INT signals
share one cleanup operation. Independent cleanup steps are attempted after a
failure; strict dedicated shutdown propagates watcher, scheduler, runner and
orchestrator failures. The web lifecycle does not start task consumers, a scheduler or a watcher.

With a responsive Node event loop, the 60-second shutdown deadline exits nonzero and explicitly reports cleanup as
UNKNOWN. It is a containment deadline, never evidence of safe drain. In-process
plugins can retain raw SQL/background work or detached children outside the
observable runner boundary. Neither a successful process fixture nor an exit
code establishes full L03 workflow drain, rollback or safe ownership transfer.

Run the production bundle with `--startup-evidence` to emit bounded JSON lines
prefixed `TASK_RUNTIME_EVIDENCE` at initial imports and readiness. Each sample
contains Node/platform/architecture, elapsed process time, RSS/heap/native buffer
bytes, peak process RSS, CPU time and counts of active resource types. For an
import-only sample use:

```sh
node build/task-runtime.js --check-imports --startup-evidence
```

The import check starts no task consumers or health listener. Its sample measures
the initial evaluated graph only; it does not exercise lazy plugin/service loads.
The build metafile is the source-import inventory, while the actual-process test
loads an ordinary SDK plugin with real database/cache context. Paired runs on the
same platform/backend/workload must still include executor/watcher children,
database connections, container file cache and the rest of the deployment before
making any memory or throughput comparison. These samples claim no RAM saving.

Targeted verification (run through the sanctioned remote runner):

```sh
npx vitest run src/task-runtime/lifecycle.test.ts src/task-runtime/process-lifecycle.test.ts
npm run build:task-runtime
npm run test:integration -- src/task-runtime/process-lifecycle.integration.test.ts src/task-runtime/process.integration.test.ts
```

The signal fixture uses actual Node 24+ processes and native TypeScript type
stripping. The full host fixture requires the built runtime and runner-provided
test PostgreSQL/Valkey, and fails when either prerequisite is absent. Plugin
capability parity beyond the fixture, repeated paired resource measurements,
long-task/parent-child drain, image smoke and soak gates remain unqualified.

## Reversible dedicated-worker upgrade preparation

The dedicated worker logs `Dedicated task upgrade control ready` with its current
`socketPath`, process `pid` and fresh per-boot `instance`. The socket lives in a
new private mode-0700 directory with a random name under `$XDG_RUNTIME_DIR` (or
the OS temp directory when unset); the worker verifies its mode and owner after
creating it, removes it on shutdown, and never passes its path to the executor
child or plugins through the environment. The socket is mode 0600. The `instance`
only identifies the process; it does not authorize anything. Run the command in the
same container as its owning user, using the exact live socket path from that
worker's log. First coordinate the container supervisor and deployment controller
so the old worker cannot restart automatically and a replacement cannot start
early. A self-exit can trigger Docker's `restart: unless-stopped` or Kubernetes
reconciliation; this control socket does not change those policies. Use tooling
that enforces stop-before-start and restore supervision after replacement:

```sh
node build/task-runtime.js --prepare-upgrade /tmp/lumastra-upgrade-EXAMPLE/control.sock
node build/task-runtime.js --upgrade-status /tmp/lumastra-upgrade-EXAMPLE/control.sock
```

The preparation response binds its state to the live process PID and per-boot
instance. A successful command exits zero with `state: prepared` and prints a
one-time `nonce` (stop capability). Only the prepare response carries it: status
and logs never do. Keep it out of logs and shell history. A second prepare while
the worker is already prepared (or stopping) is refused: it returns the current
state with `error: already_prepared`, exits 2, never returns the nonce and does
not restart the timeout. Resume first, then prepare again. The worker
pauses local BullMQ claims and local scheduler dispatch, waits for the actual
worker loops, active handlers, raw execute continuations and retained terminal
lookup/batch persistence work, and drops readiness during that interval. It
preserves globally paused queues, existing local pauses, scheduler administrator
state and every accepted queued job's identity and delay. The watcher and existing
owner remain alive. Preparation does not certify arbitrary plugin background
work, detached descendants or physical SQL teardown beyond observed invocations.

Selective workflow drain is unsupported. If an active parent needs a queued
child, or any long task or continuation cannot settle within its 30-second work budget,
preparation returns `state: postponed` and exits 2 after restoring the local
claim and scheduler state. Setup and pause acknowledgements share that work
budget; restoration has a separate bounded five-second window. Unresolved pause
or resume operations retain their handles and report UNKNOWN until an explicit
restoration retry observes completion. The same parent/task continues without cancellation
or replay. An UNKNOWN restoration also exits 2, retains failed restoration
handles, and keeps readiness down. Do not terminate or start a replacement on
postponed/UNKNOWN, a missing receipt, or a command timeout. Inspect status and
restore explicitly when needed:

```sh
node build/task-runtime.js --resume-upgrade /tmp/lumastra-upgrade-EXAMPLE/control.sock
```

Prepared state deliberately stays paused until explicit resume or shutdown. A
lost client response or disconnect does not silently reopen claims. Use the
`nonce` from the prepare response to request a guarded stop through that same
socket (the value below is a placeholder):

If neither stop nor resume arrives within `TASK_UPGRADE_PREPARED_TIMEOUT_MS`
(default 900000, 15 minutes; values above 2147483647 are clamped, and non-numeric
or non-positive values fall back to the default) of the worker becoming prepared, it logs an error and
resumes automatically (restoring claims and readiness) and the nonce becomes
invalid. No replacement should have started without a stop, so this is safe.

```sh
node build/task-runtime.js --stop-upgrade /tmp/lumastra-upgrade-EXAMPLE/control.sock PREPARE_NONCE
# or read the nonce from stdin so it never appears in the process list:
printf %s "$NONCE" | node build/task-runtime.js --stop-upgrade /tmp/lumastra-upgrade-EXAMPLE/control.sock -
```

The server accepts stop only while prepared and only for the nonce issued by the
latest successful prepare (compared in constant time; resume or the prepared timeout
invalidates it), then returns `stopping` and runs normal strict shutdown. Observe the old
process/container termination before starting the replacement. If any pre-stop deployment step fails, call resume against
the original socket and confirm readiness/task progress return; an existing
administrator pause remains in force. Keep the tested old image for rollback.
The TERM/INT cleanup deadline remains a forced UNKNOWN boundary, never safe-drain
proof. This manual prepare/stop/start procedure is an implementation seam;
production deployment hooks and release/container/platform/soak qualification
remain separate activation work.

Known runner terminal writes remain owned until their SQL write or strict fenced
fallback handoff is acknowledged. Repeated preparation retries retained writes
with their original payload/authority and queue attempt. New deferred runner
writes validate the same attempt again before durable replay; an unavailable
lookup remains UNKNOWN, and a later attempt supersedes the old write. These
checks do not constitute an atomic fence across PostgreSQL and BullMQ. Pending
QueueEvents lookups also retry while preparation keeps the owner alive. A task
hot-loaded during the pause gets its consumer when restoration reconciles the
registry, without another plugin reload.

New runner terminal fallbacks retain their original result as well as queue
attempt provenance. A state-only terminal mirror does not acknowledge a missing
result. A freshly verified same attempt can fill a NULL result without changing
terminal state, error or completion time; conflicting existing results remain
UNKNOWN. Missing job provenance cannot silently discard that original result.
