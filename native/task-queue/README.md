<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

# Native BullMQ qualification

This bounded test binary uses the published **`bullmq-official = 1.4.0`** crate
against the application's exact **npm `bullmq 6.3.15`** lock. It is a queue-client
qualification fixture, not an enabled task owner or a replacement for TypeScript
plugins, the SDK context, or the existing task state/history system.

`--version` needs no connection. Every operational command requires explicit
`LUMASTRA_TASK_QUEUE_TEST=1`, a loopback `TEST_CACHE_URL` with a nonzero database,
an owned `lumastra-native-compat-<random hex>` prefix, and a `compat-*` queue.
The parent harness passes only the test connection and minimal process settings.
Input, job count, flow depth, output buffering and process lifetime are bounded.
There is no production command, listener, task selection, or queue migration.

Run from the application directory against an isolated loopback Valkey database:

```sh
cargo +1.99.1 test --manifest-path native/task-queue/Cargo.toml --locked
cargo +1.99.1 build --manifest-path native/task-queue/Cargo.toml --locked
TEST_CACHE_URL="$CACHE_URL" node --test tests/native-conformance/task-queue/interop.mjs
```

After the shared native build helper, set
`NATIVE_TASK_QUEUE_BINARY="$PWD/build/lumastra-task-queue"` for the same harness.
Each test uses an independent random queue prefix and cleans that queue only;
there is no database flush. The harness fails if the installed npm version drifts.

## Exact source audit and upstream negative controls

The reviewed source is the [published 1.4.0 crate](https://crates.io/crates/bullmq-official/1.4.0)
and the [exact npm 6.3.15 package](https://registry.npmjs.org/bullmq/-/bullmq-6.3.15.tgz).
Compare expanded npm `dist/cjs/scripts` with Rust `src/commands`, rather than the
npm source files containing unexpanded includes. After removing comments and
whitespace, nine critical scripts match: `moveToActive`, `moveToFinished`,
`moveToDelayed`, `moveStalledJobsToWait`, `extendLock`, `addStandardJob`,
`addPrioritizedJob`, `addDelayedJob`, and `retryJob`. The automated source audit
also checks `moveToWaitingChildren`, `addParentJob`, and `removeJob`, preserving
string literal bytes while normalizing only surrounding comments/whitespace.
This establishes neither
wrapper equivalence nor compatibility with a future dependency release.

The actual binary negative control reproduces two 1.4.0 wrapper defects:

- `src/worker.rs:2400–2454` accepts a successful Redis reply to automatic lock
  renewal without rejecting Lua `0`. A lost lock does not cancel its processor.
  The terminal Lua script rejects the stale completion, but prior side effects
  can already have happened. Supported `Job::extend_lock` (`src/job.rs:942–971`)
  correctly rejects that result.
- `Worker::close` (`src/worker.rs:753–802`) can return after its timeout while a
  detached processor (`src/worker.rs:944`) is still alive. It is not confirmed drain.

To reproduce the currently failing **raw upstream worker** ownership acceptance
assertion, run the harness with `REQUIRE_NATIVE_QUEUE_SAFETY=1` and test-name
pattern `qualification exposes`. This is an explicit diagnostic red gate, not a
supported production selection. The ordinary regression suite asserts the
negative observations and independently requires our guarded positive cases.

## Supported manual API wrapper

`test-guarded-worker` never starts the client's automatic processing loop. Its
single claim loop owns each async handler future, checks the supported lease API,
rejects stale completion and stops admission before a bounded drain. Aborting
drops that owned future before acknowledging shutdown. Tests inspect actual
processor events, queue state and child exit, rather than trusting the reported
handler count. Only bounded echo/hold fixture actions are supported; this path
does not implement the application's retry or cancellation policy.

Periodic renewals are scheduled from their confirmation to avoid starving a
ready handler. Cancellation and hard drain deadlines have priority, start before
claim, retain their original time, and are rechecked after lease confirmation.
Tests delay initial, periodic and final real lease confirmations to exercise
those boundaries. Completion RPCs have a bounded receipt wait. Once sent, a Redis
mutation may commit even if its reply is lost or cancellation arrives: the tested
`completion-uncertain` outcome requires reconciliation, never blind replay. A
commit-time cancellation CAS and durable command receipts remain unimplemented.

Dropping a Rust future cannot stop arbitrary spawned work or a TypeScript plugin.
A separate process watchdog is tested for a non-yielding fixture. Real executor
supervision, confirmed TypeScript/FFmpeg termination, cancellation state CAS,
durable generations/receipts, all-writer fencing, generic SQL/external effects,
coherent per-task partitions, and rollback remain T02/T03/R gates. External effects
remain at-least-once unless their integration supplies a stable idempotency key.
No production activation or memory improvement is claimed by this fixture.
