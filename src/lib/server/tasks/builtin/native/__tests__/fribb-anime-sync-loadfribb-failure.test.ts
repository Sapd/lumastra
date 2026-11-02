// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * fribb-anime-sync: loadFribbData failure classification.
 *
 * `loadFribbData` is the task's SINGLE external dependency. A total failure to
 * fetch the Fribb dataset used to throw a RAW Error out of execute(), classified
 * only by the generic infra fallback — inconsistent with the explicit
 * `new TaskError({ kind: 'transient' })` this family raises for every other
 * failure mode. execute() now wraps the load so a fetch failure surfaces as a
 * transient (retriable, breaker-visible) TaskError.
 *
 * This lives in its OWN test file because fribb-anime-sync.ts caches the dataset
 * in a module-level variable (24h TTL) primed on the first successful http.get.
 * A fresh module registry (one file = one registry in vitest) guarantees the
 * cache is empty so the failing http.get is actually reached.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

// Stage-state writes are never reached (load fails first) but the import must resolve.
vi.mock('$lib/server/database/queries/stage-state.queries.js', () => ({
    upsertCompletedRow: vi.fn().mockResolvedValue(undefined),
    upsertSkippedPermanentRow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/config.js', () => ({
    config: {
        get DISABLE_FRIBB_ANIME_SYNC() {
            return false;
        },
    },
    getAuthoritativeStageIds: vi.fn(() => new Set<string>()),
}));

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerTask: vi.fn() },
    TaskRegistry: vi.fn(),
    getRegistry: vi.fn(),
    setTestRegistry: vi.fn(),
}));

vi.mock('$lib/server/services/catalog.service.js', () => {
    class CatalogService {
        upsertExternalId = vi.fn().mockResolvedValue(undefined);
        constructor(_sql: unknown, _opts?: unknown) {}
    }
    // Real subclass, not a stub: fribb branches on `err instanceof
    // ExternalIdOwnedByAnotherItemError` to tell a DURABLE id conflict (tombstone)
    // apart from a transient write failure (error + retry). A mock that omitted it
    // would make every conflict look transient — the exact bug this distinguishes.
    class ExternalIdOwnedByAnotherItemError extends Error {
        readonly ownerMediaId: string;
        constructor(provider: string, externalId: string, mediaType: string, ownerMediaId: string) {
            super(
                `External ID ${provider}:${externalId} (${mediaType}) is already mapped to media item ${ownerMediaId}`,
            );
            this.name = 'ExternalIdOwnedByAnotherItemError';
            this.ownerMediaId = ownerMediaId;
        }
    }
    return { CatalogService, ExternalIdOwnedByAnotherItemError };
});

// drain-backlog is dynamically imported before loadFribbData — it must resolve,
// but its functions are never invoked because the load throws first.
vi.mock('$lib/server/plugins/runtime/drain-backlog.js', () => ({
    drainBacklog: vi.fn(),
    resolveDrainMode: vi.fn().mockReturnValue('catchup'),
    formatStopReason: vi.fn().mockReturnValue(''),
    computeRemainingHint: vi.fn().mockReturnValue(0),
    isAbortedStop: vi.fn().mockReturnValue(false),
    lazyBacklog: vi.fn((fn: () => unknown) => fn),
}));

import { fribbAnimeSyncTask } from '../fribb-anime-sync.js';

function makeCtx(httpGet: () => Promise<unknown>, aborted = false) {
    const ac = new AbortController();
    if (aborted) ac.abort();
    // One candidate, so the empty-backlog short-circuit doesn't skip the load.
    const sql = vi.fn(() =>
        Promise.resolve([{ media_id: 'm1', media_type: 'movie', tmdb_id: '1' }]),
    ) as unknown as postgres.Sql;
    return {
        sql,
        http: { get: vi.fn(httpGet) },
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() },
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run',
        input: {},
        reportProgress: vi.fn(),
    } as unknown as Parameters<typeof fribbAnimeSyncTask.execute>[0];
}

describe('fribb-anime-sync: loadFribbData failure → transient TaskError', () => {
    beforeEach(() => vi.clearAllMocks());

    it('a fetch rejection surfaces as a transient TaskError (retriable + breaker-visible)', async () => {
        const ctx = makeCtx(() => Promise.reject(new Error('ECONNREFUSED')));
        await expect(fribbAnimeSyncTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
        });
    });

    it('a non-2xx response surfaces as a transient TaskError', async () => {
        const ctx = makeCtx(() =>
            Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable' }),
        );
        await expect(fribbAnimeSyncTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
        });
    });

    it('a malformed (empty) dataset surfaces as a transient TaskError', async () => {
        const ctx = makeCtx(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));
        await expect(fribbAnimeSyncTask.execute(ctx)).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
        });
    });

    it('does not download the dataset when there is nothing to match (fresh install)', async () => {
        const get = vi.fn();
        const ctx = makeCtx(get);
        (ctx as unknown as { sql: unknown }).sql = vi.fn(() => Promise.resolve([]));

        await expect(fribbAnimeSyncTask.execute(ctx)).resolves.toMatchObject({
            success: true,
            itemsProcessed: 0,
        });
        expect(get).not.toHaveBeenCalled();
    });
});
