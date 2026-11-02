<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

The executor bridge reuses the existing `TaskRunner`, registry and SDK context.
It creates no queue consumers. A controller supplies an already claimed per-task
job; the adapter reloads the real BullMQ job, verifies its task/run identity and
active state, and proves its lock token through BullMQ's supported `extendLock`
API. The claimant retains renewal and final queue transitions.

Only explicitly approved `eligibleTaskIds` execute (the default list is empty).
A registry entry alone does not prove that a task's required background services,
feature startup hooks or plugin lifetime assumptions exist in a dedicated child.
Existing tasks and plugins continue using the existing runtime by default.

IPC uses bounded length-prefixed JSON over a Unix socket in a process-owned
0700 directory, socket mode 0600, and a per-session 256-bit secret. It admits at
most 32 executions and four data sockets. A separate control socket reserves
two connections for status, cancellation and drain; execution requests are
rejected on that socket, so saturated data connections cannot starve control. No context or database credentials cross
this protocol. Durable authority admission is required before execution;
ambiguous admission remains UNKNOWN and is reconciled through durable receipts.

Protocol version 2 makes `execute` an admission acknowledgement
(`admitted`, with `duplicate: true` for a repeated invocation id, or `rejected`
with a `reason`). Completion is fetched with the `result` operation
(`running`, `done`, `unknown_invocation`), so a run has no total deadline; only
each single RPC is time-bounded. Receipts settle per run as soon as that run's
continuation is gone. The child environment is an allowlist applied inside the
supervisor, and the guardian removes only its own `lx-*` 0700 directory.

Cancellation requests SDK abort. Drain waits for the real execute continuation,
including a continuation that outlives the runner's watchdog result. A timeout
or logical task result is never proof that an inline plugin stopped. Process
supervision must terminate an uncooperative child and its descendants.

Local execution quiescence does not prove that every background SQL/log/progress
write or child process has stopped. Ownership handoff separately requires
process-group termination and SQL connection drain. Existing runner, recovery,
API and plugin mutations still require the authority writer audit before Rust
ownership can be activated. This bridge adds no activation selector.
