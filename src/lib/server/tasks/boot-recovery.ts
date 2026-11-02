// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// BootRecovery — thin shim that delegates to RunLivenessAuthority.
//
// Consolidation #1: the three-signal (BullMQ job state, Valkey hash,
// cluster-node presence) classification is replaced by a single heartbeat-age
// rule in RunLivenessAuthority. This file is kept as a one-release shim for
// call sites in orchestrator.ts; it will be deleted in the follow-up cleanup
// step once those sites import RunLivenessAuthority directly.

import type postgres from 'postgres';
import type { AuthorityToken } from '../../../task-runtime/authority/store.js';
import type { StateMachine } from './state-machine.js';
import type { TaskRegistry } from './registry.js';
import { type ValkeyLike } from './valkey-types.js';
import type { PendingWriteDrain } from './pending-write-drain.js';
import {
    RunLivenessAuthority,
    type RecoveryReport,
    type QueueResolver,
    type ResumeStarter,
} from './run-liveness-authority.js';

export type { RecoveryReport } from './run-liveness-authority.js';

export class BootRecovery {
    private readonly authority: RunLivenessAuthority;

    constructor(
        sql: postgres.Sql,
        stateMachine: Pick<StateMachine, 'transitionRun'>,
        getClient: () => Promise<ValkeyLike>,
        // getQueue is used ONLY for the pending-orphan job-existence guard
        // (RunLivenessAuthority.isPendingRunQueued). The active-zombie path uses
        // the heartbeat-age rule and never touches BullMQ.
        getQueue: QueueResolver | undefined,
        registry?: TaskRegistry,
        perTaskQueues?: boolean,
        emitTerminal?: (
            taskId: string,
            runId: string,
            to: 'completed' | 'failed' | 'cancelled',
            extra?: Record<string, string | number>,
            authority?: AuthorityToken,
        ) => Promise<void>,
        pendingWriteDrain?: Pick<PendingWriteDrain, 'enqueue'>,
        resumeRun?: ResumeStarter,
        authority?: AuthorityToken,
    ) {
        this.authority = new RunLivenessAuthority(
            sql,
            stateMachine,
            getClient,
            getQueue,
            registry,
            perTaskQueues,
            emitTerminal,
            pendingWriteDrain,
            resumeRun,
            authority,
        );
    }

    async run(): Promise<RecoveryReport> {
        return this.authority.runBoot();
    }

    async runForCandidates(runIds: string[]): Promise<RecoveryReport> {
        return this.authority.reclaimStaleRuns(runIds, 'reconciler');
    }

    async sweepStaleCounters(): Promise<void> {
        return this.authority.sweepStaleCounters();
    }
}
