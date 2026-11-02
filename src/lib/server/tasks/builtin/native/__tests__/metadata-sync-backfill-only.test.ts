// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * metadata-sync — original_title backfill only.
 *
 * metadata-sync used to run the TMDB discovery sweep (`generator.sync()`) that
 * tmdb-metadata-sync already runs every 12h: a third full-catalog detail
 * refetch per day on prod (~9.7k TMDB requests), which also pushed the
 * overlapping tmdb-metadata-sync sweep past its hard cap. It must never run
 * the sweep again, whatever the discovery-catalog gate says — only the
 * `MetadataUpdateGenerator` backfill.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRecordingSql } from '$lib/server/tasks/__testkit__/index.js';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

// ---------------------------------------------------------------------------
// Registry mock — prevents side-effect registration at import time
// ---------------------------------------------------------------------------

vi.mock('$lib/server/tasks/builtin/../../registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

// ---------------------------------------------------------------------------
// config mock — controls isDiscoveryCatalogEnabled
// ---------------------------------------------------------------------------

const configMock = vi.hoisted(() => ({
    isDiscoveryCatalogEnabled: vi.fn<() => boolean>(() => true),
}));
vi.mock('$lib/server/config.js', async (importOriginal: () => Promise<Record<string, unknown>>) => {
    const actual = await importOriginal();
    return {
        ...actual,
        isDiscoveryCatalogEnabled: configMock.isDiscoveryCatalogEnabled,
    };
});

// ---------------------------------------------------------------------------
// Generator mocks — TMDBMetadataSyncGenerator (phase 1) and
// MetadataUpdateGenerator (phase 2), spied on so tests can assert which
// phases actually ran.
// ---------------------------------------------------------------------------

const generatorMock = vi.hoisted(() => ({
    sync: vi.fn(),
    update: vi.fn(),
}));

vi.mock('$lib/server/ai/tmdb-metadata-sync.js', async () => {
    class FakeTMDBMetadataSyncGenerator {
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
            requestCount: number;
        }> {
            return generatorMock.sync(...args);
        }
    }
    class FakeMetadataUpdateGenerator {
        abort(_reason: string): void {
            /* noop */
        }
        isAborted(): boolean {
            return false;
        }
        update(...args: unknown[]): Promise<unknown> {
            return generatorMock.update(...args);
        }
    }
    const actual = await vi.importActual<typeof import('$lib/server/ai/tmdb-metadata-sync.js')>(
        '$lib/server/ai/tmdb-metadata-sync.js',
    );
    return {
        TMDBMetadataSyncGenerator: FakeTMDBMetadataSyncGenerator,
        MetadataUpdateGenerator: FakeMetadataUpdateGenerator,
        classifyTmdbFailure: actual.classifyTmdbFailure,
    };
});

// ---------------------------------------------------------------------------
// Import the task under test (AFTER all mocks are declared)
// ---------------------------------------------------------------------------

import { metadataSyncTask } from '../metadata-sync.js';

function makeCtx(): TaskContext<Record<string, unknown>> {
    const ac = new AbortController();
    const softAc = new AbortController();
    const rec = makeRecordingSql();
    return {
        runId: 'test-run-metadata-sync',
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
        softSignal: softAc.signal,
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

describe('metadata-sync: backfill only', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        generatorMock.sync.mockResolvedValue({
            success: true,
            total_fetched: 1,
            total_movies: 1,
            total_series: 0,
            created: 1,
            updated: 0,
            skipped: 0,
            errors: 0,
            message: 'ok',
            requestCount: 1,
        });
        generatorMock.update.mockResolvedValue({
            success: true,
            total_fetched: 2,
            total_movies: 0,
            total_series: 0,
            created: 0,
            updated: 2,
            skipped: 0,
            errors: 0,
            message: 'ok',
            requestCount: 2,
        });
    });

    it.each([true, false])(
        'discovery catalog enabled=%s: never runs the discovery sweep, runs the backfill',
        async (enabled) => {
            configMock.isDiscoveryCatalogEnabled.mockReturnValue(enabled);

            const result = await metadataSyncTask.execute(makeCtx());

            expect(generatorMock.sync).not.toHaveBeenCalled();
            expect(generatorMock.update).toHaveBeenCalledTimes(1);
            expect(result.success).toBe(true);
            expect(result.itemsProcessed).toBe(2);
        },
    );
});
