// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Import-stable submission boundary. T01 preserves the existing supported
// TypeScript adapter and its asynchronous result/error semantics. A future
// remote transport must be durable and fenced before replacing this delegate.
import type {
    StartRunOpts,
    StartRunResult,
    CancelRunResult,
} from '$lib/server/tasks/orchestrator.js';

export async function startRun(
    taskId: string,
    input: unknown,
    opts?: StartRunOpts,
): Promise<StartRunResult> {
    const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
    return orchestrator.startRun(taskId, input, opts);
}

export async function cancelRun(
    runId: string,
    opts: { hard?: boolean; reason?: string } = {},
): Promise<CancelRunResult> {
    const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
    return orchestrator.cancelRun(runId, opts);
}
