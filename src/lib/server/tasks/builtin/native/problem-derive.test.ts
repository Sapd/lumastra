// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the service so this suite is about the task DECLARATION and its delegation,
// not about the 30-module signal fan-out the real service imports.
const runAttentionDerivation = vi.fn();
vi.mock('$lib/server/services/attention/attention-service.js', () => ({
    runAttentionDerivation: (...args: unknown[]) => runAttentionDerivation(...args),
}));

import { problemDeriveTask } from './problem-derive.js';
import { registry } from '../../registry.js';

interface MinimalCtx {
    sql: unknown;
    logger: {
        warn: ReturnType<typeof vi.fn>;
        info: ReturnType<typeof vi.fn>;
        debug: ReturnType<typeof vi.fn>;
    };
}

function ctx(): MinimalCtx {
    return { sql: {}, logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } };
}

const outcome = {
    upserted: 3,
    resolved: 1,
    verdict: 'degraded' as const,
    unreadCount: 2,
    protectedPrefixes: [] as string[],
};

describe('problem-derive task declaration', () => {
    beforeEach(() => {
        runAttentionDerivation.mockReset();
        runAttentionDerivation.mockResolvedValue(outcome);
    });

    it('self-registers under the id the builtin loader lists', () => {
        expect(registry.getTask('problem-derive')).toBe(problemDeriveTask);
    });

    it('runs on startup — the cold-boot guarantee depends on it', () => {
        // Reads project the persisted table (populated by the previous process), so a
        // restart is naturally correct. A FRESH install has nothing to project, and
        // without runOnStartup its board would read "healthy" for a whole interval
        // before anything had ever been derived.
        expect(problemDeriveTask.schedule?.runOnStartup).toBe(true);
    });

    it('derives at the bell poll cadence', () => {
        expect(problemDeriveTask.schedule?.every).toBe('60s');
    });

    it('is leader-gated the way every other cluster-singleton builtin is', () => {
        // This task WRITES admin_attention_alerts, so it must run once cluster-wide.
        // The gate is the maintenance resource class (whose orchestrator leader lock is
        // itself WORKER_MODE-gated, so web replicas never lead) plus a constant global
        // identity, so the scheduler's fire claim and the orchestrator's SETNX identity
        // dedup collapse concurrent enqueues to one run.
        expect(problemDeriveTask.resourceClass).toBe('maintenance');
        expect(problemDeriveTask.scope).toBe('global');
        expect(problemDeriveTask.identityFor?.({})).toBe('global');
        expect(problemDeriveTask.quotas?.maxConcurrent).toBe(1);
        expect(problemDeriveTask.capabilities?.database).toBe(true);
    });

    it('delegates to the existing derive → reconcile → upsert path', async () => {
        const c = ctx();
        const res = await problemDeriveTask.execute?.(c as never);
        expect(runAttentionDerivation).toHaveBeenCalledWith(c.sql);
        expect(res).toMatchObject({
            success: true,
            itemsProcessed: 4,
            result: { upserted: 3, resolved: 1, verdict: 'degraded', unreadCount: 2 },
        });
    });

    it('warns when a source could not be read, so a carried-forward board is visible', async () => {
        runAttentionDerivation.mockResolvedValue({
            ...outcome,
            protectedPrefixes: ['circuit:', 'dead-letter:'],
        });
        const c = ctx();
        const res = await problemDeriveTask.execute?.(c as never);
        expect(c.logger.warn).toHaveBeenCalled();
        expect(res).toMatchObject({ result: { protectedNamespaces: 2 } });
    });

    it('does not warn when every protected prefix is only warming after boot', async () => {
        runAttentionDerivation.mockResolvedValue({
            ...outcome,
            protectedPrefixes: ['optional-dependency:', 'music-hygiene:'],
            warmingPrefixes: ['optional-dependency:', 'music-hygiene:'],
        });
        const c = ctx();
        const res = await problemDeriveTask.execute?.(c as never);
        expect(c.logger.warn).not.toHaveBeenCalled();
        expect(c.logger.debug).toHaveBeenCalled();
        // Still protected: the count is unchanged.
        expect(res).toMatchObject({ result: { protectedNamespaces: 2 } });
    });

    it('still warns when a non-warming prefix is protected alongside a warming one', async () => {
        runAttentionDerivation.mockResolvedValue({
            ...outcome,
            protectedPrefixes: ['optional-dependency:', 'circuit:'],
            warmingPrefixes: ['optional-dependency:'],
        });
        const c = ctx();
        await problemDeriveTask.execute?.(c as never);
        expect(c.logger.warn).toHaveBeenCalledTimes(1);
    });
});
