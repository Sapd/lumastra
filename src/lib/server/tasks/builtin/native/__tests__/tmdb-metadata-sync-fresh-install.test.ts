// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * tmdb-metadata-sync fresh-install guard.
 *
 * A completely fresh install (zero `library_paths` rows, no admin account yet)
 * must NOT let the scheduled discovery sweep populate `media_items` — that
 * burns TMDB quota on data nobody asked for and surprises an admin auditing a
 * "blank" instance. `isFreshUnconfiguredInstall` (onboarding.queries.ts) is
 * the live precondition check; these tests assert the task:
 *
 *   A) Skips cleanly (success:true, zero work, explicit reason) when the
 *      instance is fresh — and never reaches the TMDB discovery-sweep
 *      generator (no TMDB calls made).
 *   B) Proceeds normally through the discovery sweep once the instance is NOT
 *      fresh (a library exists or setup completed) — no special-casing
 *      needed on the happy path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRecordingSql } from '$lib/server/tasks/__testkit__/index.js';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

// ---------------------------------------------------------------------------
// onboarding mock — drives the precondition under test
// ---------------------------------------------------------------------------

const onboarding = vi.hoisted(() => ({
    isFreshUnconfiguredInstall: vi.fn<() => Promise<boolean>>(),
}));
vi.mock('$lib/server/database/queries/onboarding.queries.js', () => onboarding);

// ---------------------------------------------------------------------------
// Registry mock — prevents side-effect registration at import time
// ---------------------------------------------------------------------------

vi.mock('$lib/server/tasks/builtin/../../registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

vi.mock('$lib/server/database/queries/stage-state.queries.js', () => ({
    upsertCompletedRow: vi.fn().mockResolvedValue(undefined),
    // Best-effort self-heal called at the top of the discovery sweep; return
    // value is discarded (awaited with .catch).
    healMisappliedFailedPermanentRows: vi.fn().mockResolvedValue(undefined),
}));

const configMock = vi.hoisted(() => ({
    getAuthoritativeStageIds: vi.fn<() => Set<string>>(() => new Set()),
    // Discovery-catalog gate defaults to true here so the pre-existing
    // fresh-install-guard scenarios keep exercising the sweep unchanged —
    // the gate's own on/off behavior is covered separately.
    isDiscoveryCatalogEnabled: vi.fn<() => boolean>(() => true),
}));
vi.mock('$lib/server/config.js', async (importOriginal: () => Promise<Record<string, unknown>>) => {
    const actual = await importOriginal();
    return {
        ...actual,
        getAuthoritativeStageIds: configMock.getAuthoritativeStageIds,
        isDiscoveryCatalogEnabled: configMock.isDiscoveryCatalogEnabled,
    };
});

// ---------------------------------------------------------------------------
// Discovery-sweep generator mock — spied on so tests can assert it was never
// invoked when the fresh-install guard skips the sync.
// ---------------------------------------------------------------------------

const syncMock = vi.hoisted(() => ({
    sync: vi.fn(),
}));
vi.mock('$lib/server/ai/tmdb-metadata-sync.js', async () => {
    class FakeGenerator {
        abort(_reason: string): void {
            /* noop */
        }
        isAborted(): boolean {
            return false;
        }
        sync(...args: unknown[]): Promise<{
            success: boolean;
            total_fetched: number;
            total_movies: number;
            total_series: number;
            created: number;
            updated: number;
            skipped: number;
            errors: number;
            message: string;
        }> {
            return syncMock.sync(...args);
        }
    }
    const actual = await vi.importActual<typeof import('$lib/server/ai/tmdb-metadata-sync.js')>(
        '$lib/server/ai/tmdb-metadata-sync.js',
    );
    return {
        TMDBMetadataSyncGenerator: FakeGenerator,
        classifyTmdbFailure: actual.classifyTmdbFailure,
    };
});

// ---------------------------------------------------------------------------
// Per-item path mocks — only exercised by the discovery-catalog-gate test
// that drives ctx.input.mediaItemId (the gate must not affect this path).
// ---------------------------------------------------------------------------

const syncSingleItemMock = vi.hoisted(() => ({
    syncSingleItem: vi.fn<() => Promise<{ updated: boolean; fieldsChanged: string[] }>>(),
}));
vi.mock('$lib/server/services/metadata-sync-single.service.js', () => syncSingleItemMock);

const connectionMock = vi.hoisted(() => ({
    getDb: vi.fn<() => unknown>(() => null),
    getTaskDb: vi.fn<() => unknown>(() => null),
}));
vi.mock('$lib/server/database/connection.js', () => connectionMock);

// ---------------------------------------------------------------------------
// Import the task under test (AFTER all mocks are declared)
// ---------------------------------------------------------------------------

import { tmdbMetadataSyncRealTask } from '../tmdb-metadata-sync-task.js';

function makeCtx(): TaskContext<Record<string, unknown>> {
    const ac = new AbortController();
    const rec = makeRecordingSql();
    return {
        runId: 'test-run-tmdb-fresh-install',
        attemptNumber: 1,
        input: {},
        scope: {},
        mode: 'scheduled',
        sql: rec.sql,
        logger: {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        reportProgress: vi.fn(),
        dep: vi.fn(),
        settings: vi.fn(),
        spend: vi.fn(),
        http: {
            get: vi.fn(),
            post: vi.fn(),
        },
        catalog: undefined as unknown as TaskContext['catalog'],
        mediaItems: undefined as unknown as TaskContext['mediaItems'],
        mediaFiles: undefined as unknown as TaskContext['mediaFiles'],
        userCredentials: undefined as unknown as TaskContext['userCredentials'],
    } as unknown as TaskContext<Record<string, unknown>>;
}

describe('tmdb-metadata-sync: fresh-install guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        syncMock.sync.mockResolvedValue({
            success: true,
            total_fetched: 1,
            total_movies: 1,
            total_series: 0,
            created: 1,
            updated: 0,
            skipped: 0,
            errors: 0,
            message: 'ok',
        });
    });

    it('A: skips cleanly and makes no TMDB calls when the instance is fresh and unconfigured', async () => {
        onboarding.isFreshUnconfiguredInstall.mockResolvedValue(true);

        const ctx = makeCtx();
        const result = await tmdbMetadataSyncRealTask.execute(ctx);

        expect(result).toMatchObject({
            success: true,
            itemsProcessed: 0,
            result: {
                total_fetched: 0,
                created: 0,
                updated: 0,
                errors: 0,
                message: 'skipped: no libraries configured yet',
            },
        });
        // The discovery-sweep generator must never be constructed/invoked.
        expect(syncMock.sync).not.toHaveBeenCalled();
    });

    it('B: proceeds through the normal discovery sweep when the instance is NOT fresh', async () => {
        onboarding.isFreshUnconfiguredInstall.mockResolvedValue(false);

        const ctx = makeCtx();
        const result = await tmdbMetadataSyncRealTask.execute(ctx);

        expect(syncMock.sync).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(true);
        expect(result.result?.created).toBe(1);
    });
});

describe('tmdb-metadata-sync: discovery-catalog gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        onboarding.isFreshUnconfiguredInstall.mockResolvedValue(false);
        syncMock.sync.mockResolvedValue({
            success: true,
            total_fetched: 1,
            total_movies: 1,
            total_series: 0,
            created: 1,
            updated: 0,
            skipped: 0,
            errors: 0,
            message: 'ok',
        });
    });

    it('returns a clean skip and never constructs the sweep generator when the gate is disabled', async () => {
        configMock.isDiscoveryCatalogEnabled.mockReturnValue(false);

        const ctx = makeCtx();
        const result = await tmdbMetadataSyncRealTask.execute(ctx);

        expect(result).toMatchObject({
            success: true,
            itemsProcessed: 0,
            result: {
                total_fetched: 0,
                created: 0,
                updated: 0,
                skipped: 0,
                errors: 0,
            },
        });
        expect(result.result?.message).toContain('unavailable-media display is disabled');
        expect(syncMock.sync).not.toHaveBeenCalled();
    });

    it('still executes the per-item path when the gate is disabled (per-item refresh is not gated)', async () => {
        configMock.isDiscoveryCatalogEnabled.mockReturnValue(false);
        syncSingleItemMock.syncSingleItem.mockResolvedValue({
            updated: true,
            fieldsChanged: ['overview'],
        });

        const taskDb = makeRecordingSql({ rows: [] });
        const webSql = makeRecordingSql({ rows: [{ media_type: 'MOVIE' }] });
        connectionMock.getTaskDb.mockReturnValue(taskDb.sql);

        const ac = new AbortController();
        const ctx = {
            runId: 'test-run-tmdb-gate-per-item',
            attemptNumber: 1,
            input: { mediaItemId: 'movie-uuid-gate-test', force: false },
            scope: {},
            mode: 'scheduled',
            sql: webSql.sql,
            logger: {
                debug: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                child: vi.fn(),
            },
            signal: ac.signal,
            abortSignal: ac.signal,
            reportProgress: vi.fn(),
            dep: vi.fn(),
            settings: vi.fn(),
            spend: vi.fn(),
            http: {
                get: vi.fn(),
                post: vi.fn(),
            },
            catalog: undefined as unknown as TaskContext['catalog'],
            mediaItems: undefined as unknown as TaskContext['mediaItems'],
            mediaFiles: undefined as unknown as TaskContext['mediaFiles'],
            userCredentials: undefined as unknown as TaskContext['userCredentials'],
        } as unknown as TaskContext<Record<string, unknown>>;

        const result = await tmdbMetadataSyncRealTask.execute(ctx);

        // The per-item path must NOT be skipped by the discovery-catalog gate —
        // it proceeds through syncSingleItem, not the discovery-sweep generator.
        expect(syncSingleItemMock.syncSingleItem).toHaveBeenCalledTimes(1);
        expect(result.result?.message).not.toContain('unavailable-media display is disabled');
        expect(syncMock.sync).not.toHaveBeenCalled();
    });
});
