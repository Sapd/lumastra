// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { AuthorityStore } from '../authority/store.js';
import { ExecutionOutcomeSchema, type ExecutionCommand } from './protocol.js';
import type { ExecutorServerOptions } from './server.js';

/** Shared production reconciliation consumer. Never converts an old attempt
 * into new execution, including durable UNKNOWN after owner lease expiry. */
export async function reconcileExecutorAdmission(
    store: AuthorityStore,
    command: ExecutionCommand,
): ReturnType<NonNullable<ExecutorServerOptions['reconcile']>> {
    const existing = await store.reconcileExecutionAdmission(
        command.authority,
        command.invocationId,
    );
    if (!existing) return { state: 'absent' };
    if (
        existing.dispatchId !== command.dispatchId ||
        existing.runId !== command.runId ||
        existing.taskId !== command.taskId
    )
        throw new Error('Executor admission identity conflict');
    if (existing.state === 'active') return { state: 'active' };
    return { state: 'settled', outcome: ExecutionOutcomeSchema.parse(existing.outcome) };
}
