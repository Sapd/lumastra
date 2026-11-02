<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Watcher lab qualification

Run from the application directory on Linux after building the actual Rust
executable. The existing `vitest.config.ts` process suite
remains separate; this resource fixture does not enter the ordinary unit suite.

```sh
npm run build:watcher
node tests/native-conformance/watcher/qualify.mjs --output build/watcher-qualification.json
```

Missing Rust executable or Linux process information fails the explicit
qualification; nothing silently falls back or skips. `LUMASTRA_WATCHER_BINARY`
can select an already built executable.

The harness launches four fresh equivalent Node hosts, each supervising the native
watcher through its production bridge with 500 ms write stability. No leadership,
database, Valkey, BullMQ or ingestion services are started.

Every trial recreates a deterministic 10,005-file fixture (2,004 useful and
8,001 junk files) across 404 directories, with small payloads. Configured
vendor-named roots, an explicitly configured nested root within vendor junk,
legitimate dot-prefixed titles, audio, lyrics, vendor subtrees, nonmedia and
AppleDouble files are represented. Caps are 30,000 files, 1,000 directories and
less than 32 MiB logical payload. Setup happens outside the measured hosts.

Immediately after observing ready, the parent starts twelve serialized useful
add/change/unlink operations and checks their literal ordered event sequence.
Initial files and three live junk mutation sequences must remain silent; extra,
duplicate, missing events, errors or reconciliation requests fail the run. The
artifact retains operation start/completion and parent event receipt timestamps
and latency. Completion-to-receipt values can be negative if event receipt wins
the write completion race. This measures watcher callbacks including IPC, not
database ingestion latency. Readiness means initial registration completed with
initial events suppressed. Quiet and steady observation windows follow mutations.

An external sampler reads Linux `/proc` every approximately 100 ms, recording
the host and all descendants in its dedicated process group. Node RSS already
includes worker threads and is counted once. Summed RSS can double-count shared
pages; optional PSS is recorded where readable. Samples exclude filesystem cache
and kernel watch memory and are not whole-container accounting. Peaks are sampled
peaks; gaps and sampler duration are retained. The artifact includes raw process
topology, steady median and total sampled peak, source/binary/bundle hashes,
Git state, Node/kernel/architecture, load, host memory and available cgroup evidence.
No hard RSS-saving or latency assertion is made.

Startup is bounded to 30 seconds, each required event to 10 seconds, shutdown to
10 seconds, and the main run to eight minutes. Failure cleanup has its own bounded
TERM/KILL escalation and checks that the exact owned process group disappeared.
The JSON artifact is written on failure as well as success. Graceful shutdown,
actual child observation and correctness are required before success.
Final useful event, error and reconciliation checks run after host exit, IPC disconnect
and stream closure, so shutdown callbacks cannot arrive after a passing decision.

For a negative control, append `--fault-late-callback` and choose a separate
output artifact. The host injects one extra callback after watcher close; the
run must exit nonzero with a late/unexpected-event failure. This mode does not
produce a valid resource comparison and is recorded in the artifact.

Fixture creation warms filesystem caches; shared caches are never dropped. Four
native trials are a small lab sample. Interpret observations with recorded load
and sample coverage; they do not establish whole-container RAM use or network
filesystem behavior.

## Repeated failure and native restart

After building the native executable, run the separate lifecycle fixture:

```sh
npx vitest run --config tests/native-conformance/watcher/lifecycle.vitest.config.ts
```

It writes `build/native-validation/watcher-lifecycle.json` on success or failure.
`LUMASTRA_WATCHER_LIFECYCLE_OUTPUT` selects another artifact path. Linux `/proc`
and the executable are required. The fixture kills the real child twice during
useful/junk churn, verifies each predecessor is reaped before replacement, and
checks coalesced recovery rescan signals and later useful events. It then stops and starts
a fresh native host across a gap, checking live changes to a gap-created file.
Initial/gap events stay suppressed; durable gap repair is exercised separately
by `tests/integration/watcher-gap-reconciliation.integration.test.ts`.

The main deadline is 270 seconds plus twenty seconds for cleanup. Readiness is
bounded to thirty seconds, events and shutdown to ten seconds. The fixture caps
paths at 128, mutations at 200 and payload at 64 KiB. Each recovery notification
is allowed 65 seconds for the production 60-second rescan coalescer. Production restart delays
and write stability are unchanged. Closed pipes and disappearance of every owned
process group precede final callback/error/rescan assertions.
