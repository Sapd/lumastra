// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/catalog.service.test.ts
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type postgres from 'postgres';
import type {
    MediaItemRow,
    ExternalIdRow,
} from '$lib/server/database/queries/catalog-operations.queries.js';

// vi.hoisted ensures these are available when vi.mock factories run (hoisted)
const { mockSql, mockSqlFn, mockLogger } = vi.hoisted(() => {
    const sql = vi.fn().mockResolvedValue([] as unknown as postgres.RowList<never[]>);
    (sql as unknown as Record<string, unknown>).begin = vi.fn();
    (sql as unknown as Record<string, unknown>).json = vi.fn((v: Record<string, unknown>) => v);

    return {
        // `postgres.Sql` is a deeply generic callable; `vi.mocked()` over it
        // trips TS2589. Keep a simply-typed handle for queuing query results.
        mockSqlFn: sql as unknown as Mock<(...args: unknown[]) => Promise<unknown>>,
        mockSql: sql as unknown as postgres.Sql,
        mockLogger: {
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        },
    };
});

vi.mock('$lib/server/database/queries/sort-title.queries.js', () => ({
    refreshSortTitles: vi.fn().mockResolvedValue(0),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => mockLogger),
    },
}));

// Mock query modules — catalog service delegates reads to these
vi.mock('$lib/server/database/queries/catalog-operations.queries.js', () => ({
    getMediaItemById: vi.fn(),
    findMediaIdByExternalId: vi.fn(),
    getExternalIdsForMedia: vi.fn(),
    getProviderMetadata: vi.fn(),
    isMediaAvailable: vi.fn(),
    batchResolveExternalIds: vi.fn(),
}));

vi.mock('$lib/server/database/queries/metadata-aggregation.queries.js', () => ({
    aggregateMetadataForMedia: vi.fn(),
    isProviderUsedInAggregation: vi.fn(),
}));

// Provider context helpers used by getOrCreateByExternalId — mock to avoid network calls
vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    getProvidersByPriority: vi.fn().mockReturnValue([]),
    invokeProviderDetail: vi.fn().mockResolvedValue({}),
    isProviderConfigured: vi.fn().mockResolvedValue(false),
}));

vi.mock('$lib/server/providers/encode-id.js', () => ({
    encodeDetailId: vi.fn((_, __, id: string) => id),
}));

vi.mock('$lib/server/providers/normalize.js', () => ({
    normalizeDetail: vi.fn().mockReturnValue(null),
}));

vi.mock('$lib/server/plugins/runtime/field-authority-resolver.js', () => ({
    FieldAuthorityResolver: vi.fn().mockImplementation(() => ({
        merge: vi.fn().mockReturnValue({ merged: {}, fieldSources: {} }),
    })),
}));

vi.mock('$lib/server/plugins/runtime/field-authority-loader.js', () => ({
    buildFieldAuthorityConfigFromDefinitions: vi.fn().mockReturnValue({ defaultPriorities: {} }),
    loadProviderSettingsCached: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => null),
}));

import {
    findMediaIdByExternalId,
    getMediaItemById,
    getExternalIdsForMedia,
    isMediaAvailable,
    batchResolveExternalIds,
} from '$lib/server/database/queries/catalog-operations.queries.js';
import {
    aggregateMetadataForMedia,
    isProviderUsedInAggregation,
} from '$lib/server/database/queries/metadata-aggregation.queries.js';
import { CatalogService } from './catalog.service.js';

// Helper: cast a plain array to the return type expected by mockResolvedValue.
// postgres.Sql is a template tag whose return type includes ResultQueryMeta — we
// bypass this in tests by double-casting through unknown.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rows<T>(data: T[]): any {
    return data;
}

// A tagged-template SQL mock that is callable like `postgres.Sql` but also
// exposes the vitest mock controls. Avoids `vi.mocked(sql)` (which trips TS2589
// on the deeply generic `postgres.Sql` type) while keeping result queuing typed.
type TxSqlMock = postgres.Sql & Mock<(...args: unknown[]) => Promise<unknown>>;

// Helper: build a fresh sql tag mock with configurable responses
function makeTxSql(): TxSqlMock {
    const tx = vi.fn().mockResolvedValue(rows([]));
    (tx as unknown as Record<string, unknown>).begin = vi.fn();
    (tx as unknown as Record<string, unknown>).json = vi.fn((v: Record<string, unknown>) => v);
    (tx as unknown as Record<string, unknown>).array = vi.fn((v: unknown) => v);
    return tx as unknown as TxSqlMock;
}

describe('CatalogService', () => {
    let service: CatalogService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new CatalogService(mockSql);
        mockSqlFn.mockResolvedValue(rows([]));
    });

    // =========================================================================
    // upsertExternalId — happy path
    // =========================================================================

    describe('upsertExternalId', () => {
        // Helper: set up `sql.begin(fn)` to invoke fn with a fresh txSql mock,
        // and return that txSql so assertions can target it. `selectRows` is
        // the SELECT result; `deleteRows` is the DELETE ... RETURNING result.
        function setupTx(
            selectRows: Array<{ media_id: string }> = [],
            deleteRows: Array<{ is_primary: boolean }> = [],
            liveRivalRows: Array<{ external_id: string }> = [],
        ): postgres.Sql {
            const txSql = vi
                .fn()
                // Lock target + ancestors. This fixture has no media row in
                // memory, so the disposition lookup is correctly skipped.
                .mockResolvedValueOnce(rows([]))
                // SELECT existing
                .mockResolvedValueOnce(rows(selectRows))
                // SELECT live rival — a freshly-written id for the same
                // (media_id, provider, media_type). Non-empty means another writer
                // just claimed this slot, and the write is skipped instead of
                // swapping the row (see catalog-identity-swap.integration.test.ts).
                .mockResolvedValueOnce(rows(liveRivalRows))
                // DELETE stale RETURNING
                .mockResolvedValueOnce(rows(deleteRows))
                // INSERT
                .mockResolvedValueOnce(rows([])) as unknown as postgres.Sql;
            (txSql as unknown as Record<string, unknown>).json = vi.fn(
                (v: Record<string, unknown>) => v,
            );

            (mockSql as unknown as Record<string, unknown>).begin = vi
                .fn()
                .mockImplementation((fn: (tx: postgres.Sql) => Promise<void>) => fn(txSql));
            return txSql;
        }

        it('inserts a new external ID when no existing mapping', async () => {
            const txSql = setupTx();

            await service.upsertExternalId(
                'media-uuid-1',
                { provider: 'tmdb', id: '550', mediaType: 'movie' },
                true,
            );

            // Lock chain + SELECT existing + SELECT live-rival + DELETE + INSERT
            expect(txSql).toHaveBeenCalledTimes(5);
        });

        it('applies the convergence guard to jellyfin, not just metadata providers', async () => {
            // It is tempting to argue the guard should cover only metadata providers
            // (tmdb/imdb/mal) and let a library's own id always win, on the reasoning
            // that a library is the single source of truth for its ids. On this
            // deployment that reasoning is backwards: of 49,786 identity.* events in a
            // 30h prod window, 49,497 were jellyfin and 277 tmdb. Jellyfin IS the
            // ping-pong — two Jellyfin entries for one title, each re-claiming the slot,
            // re-emitting identity.* and re-running the whole metadata fan-out
            // (~76k of ~112k weekly TMDB calls). Exempting library providers would
            // reintroduce exactly the bug the guard was written for.
            //
            // The cost is understood and measured: the losing id is dropped rather than
            // stored. The feared consequence was that a later lookup by the dropped id
            // would miss and mint a duplicate media item, so this was checked directly
            // on prod — media items sharing a tmdb id: 0 groups, 0 rows, none created
            // since the guard shipped. Resolution reaches the item by its metadata id
            // first, so the dropped library id costs reachability by that one id, not
            // an item split.
            const txSql = setupTx([], [], [{ external_id: 'a-freshly-written-jellyfin-id' }]);

            await service.upsertExternalId(
                'media-uuid-1',
                {
                    provider: 'jellyfin',
                    id: 'c5ae81227532f746c90e734d5e147b37',
                    mediaType: 'movie',
                },
                false,
            );

            // Lock chain + SELECT existing + SELECT live-rival, then STOP.
            expect(txSql).toHaveBeenCalledTimes(3);
        });

        it('always includes provider, external_id, and media_type as composite key in SELECT', async () => {
            const txSql = setupTx();

            await service.upsertExternalId(
                'media-uuid-1',
                { provider: 'tmdb', id: '603', mediaType: 'movie' },
                false,
            );

            expect(txSql).toHaveBeenCalledTimes(5);
        });

        it('does not throw when the existing row belongs to the same media item (idempotent upsert)', async () => {
            setupTx([{ media_id: 'media-uuid-1' }]);

            await expect(
                service.upsertExternalId(
                    'media-uuid-1',
                    { provider: 'tmdb', id: '550', mediaType: 'movie' },
                    true,
                ),
            ).resolves.toBe(true);
        });

        it('throws when the composite key is already mapped to a different media item', async () => {
            const txSql = setupTx([{ media_id: 'other-uuid' }]);

            await expect(
                service.upsertExternalId(
                    'media-uuid-1',
                    { provider: 'tmdb', id: '550', mediaType: 'movie' },
                    true,
                ),
            ).rejects.toThrow(
                'External ID tmdb:550 (movie) is already mapped to media item other-uuid',
            );

            // Only SELECT ran before the throw
            expect(txSql).toHaveBeenCalledTimes(2);
        });

        it('normalizes Jellyfin IDs to dashless format before checking and inserting', async () => {
            const txSql = setupTx();

            await service.upsertExternalId(
                'media-uuid-1',
                {
                    provider: 'jellyfin',
                    id: 'a1bc9a3d-39d6-8698-370b-bcd45cfb9c11',
                    mediaType: 'movie',
                },
                true,
            );

            expect(txSql).toHaveBeenCalledTimes(5);
        });

        it('uses default isPrimary=false when not specified', async () => {
            setupTx();

            await expect(
                service.upsertExternalId('media-uuid-1', {
                    provider: 'imdb',
                    id: 'tt0137523',
                    mediaType: 'movie',
                }),
            ).resolves.toBe(true);
        });

        it('accepts provided source and confidence values', async () => {
            const txSql = setupTx();

            await expect(
                service.upsertExternalId(
                    'media-uuid-1',
                    {
                        provider: 'imdb',
                        id: 'tt0137523',
                        mediaType: 'movie',
                        source: 'sync',
                        confidence: 0.9,
                    },
                    false,
                ),
            ).resolves.toBe(true);

            expect(txSql).toHaveBeenCalledTimes(5);
        });

        // Regression: artist-enrichment and ai-sync construct CatalogService
        // from inside an outer `sql.begin(...)`. postgres-js exposes the
        // tx-scoped `Sql` with `.savepoint` instead of `.begin`, so the
        // previous `this.sql.begin(...)` call threw
        // "this.sql.begin is not a function". `withTx` must fall back to
        // `savepoint` so callers can pass a TransactionSql instance.
        it('uses savepoint instead of begin when the constructor receives a tx-scoped sql (postgres-js TransactionSql)', async () => {
            // Build a tx-scoped sql mock: tagged-template callable, has
            // `.savepoint` and `.json`, no `.begin` (matches postgres-js shape).
            const txInner = vi
                .fn()
                .mockResolvedValueOnce(rows([])) // Lock chain, no media row
                .mockResolvedValueOnce(rows([])) // SELECT existing
                .mockResolvedValueOnce(rows([])) // SELECT live-rival
                .mockResolvedValueOnce(rows([])) // DELETE stale RETURNING
                .mockResolvedValueOnce(rows([])); // INSERT
            (txInner as unknown as Record<string, unknown>).json = vi.fn(
                (v: Record<string, unknown>) => v,
            );

            const savepoint = vi
                .fn()
                .mockImplementation((fn: (tx: postgres.Sql) => Promise<void>) =>
                    fn(txInner as unknown as postgres.Sql),
                );

            const txScopedSql = vi.fn() as unknown as postgres.Sql;
            (txScopedSql as unknown as Record<string, unknown>).savepoint = savepoint;
            (txScopedSql as unknown as Record<string, unknown>).json = vi.fn(
                (v: Record<string, unknown>) => v,
            );
            // begin is intentionally absent — that's the bug condition.

            const txService = new CatalogService(txScopedSql);

            await expect(
                txService.upsertExternalId(
                    'media-uuid-1',
                    {
                        provider: 'musicbrainz',
                        id: 'mbid-1',
                        mediaType: 'artist',
                    },
                    false,
                ),
            ).resolves.toBe(true);

            expect(savepoint).toHaveBeenCalledTimes(1);
            expect(txInner).toHaveBeenCalledTimes(5);
        });
    });

    // =========================================================================
    // batchUpsertExternalIds
    // =========================================================================

    describe('batchUpsertExternalIds', () => {
        it('returns immediately without touching the database for empty input', async () => {
            await service.batchUpsertExternalIds([]);

            expect((mockSql as unknown as Record<string, unknown>).begin).not.toHaveBeenCalled();
        });

        it('opens a transaction and inserts each item', async () => {
            const txSql = makeTxSql();

            (mockSql as unknown as Record<string, unknown>).begin = vi
                .fn()
                .mockImplementation((fn: (tx: postgres.Sql) => Promise<void>) => fn(txSql));

            await service.batchUpsertExternalIds([
                {
                    mediaId: 'uuid-1',
                    externalId: {
                        provider: 'tmdb',
                        id: '550',
                        mediaType: 'movie',
                    },
                    isPrimary: true,
                },
                {
                    mediaId: 'uuid-2',
                    externalId: {
                        provider: 'tmdb',
                        id: '1438',
                        mediaType: 'tv',
                    },
                },
            ]);

            expect((mockSql as unknown as Record<string, unknown>).begin).toHaveBeenCalledTimes(1);
            // Keep guard and conflict probes precede the batched stale-delete/insert.
            expect(txSql).toHaveBeenCalledTimes(5);
        });

        it('normalizes Jellyfin IDs within the batch transaction', async () => {
            const txSql = makeTxSql();

            (mockSql as unknown as Record<string, unknown>).begin = vi
                .fn()
                .mockImplementation((fn: (tx: postgres.Sql) => Promise<void>) => fn(txSql));

            await service.batchUpsertExternalIds([
                {
                    mediaId: 'uuid-1',
                    externalId: {
                        provider: 'jellyfin',
                        id: 'a1bc9a3d-39d6-8698-370b-bcd45cfb9c11',
                        mediaType: 'movie',
                    },
                },
            ]);

            // Keep guard and contested/owned probes precede DELETE/INSERT.
            expect(txSql).toHaveBeenCalledTimes(5);
        });
    });

    // =========================================================================
    // updateExternalIdMediaType
    // =========================================================================

    describe('updateExternalIdMediaType', () => {
        it('executes an UPDATE and logs the type correction', async () => {
            mockSqlFn.mockResolvedValueOnce(rows([]));

            await service.updateExternalIdMediaType('tmdb', '1429', 'movie', 'tv');

            expect(mockSql).toHaveBeenCalledTimes(1);
            expect(mockLogger.info).toHaveBeenCalledWith(
                'Updated media_type for tmdb:1429: movie → tv',
            );
        });
    });

    // =========================================================================
    // updateLibraryAvailability
    // =========================================================================

    describe('updateLibraryAvailability', () => {
        it('inserts or updates library availability', async () => {
            mockSqlFn.mockResolvedValueOnce(rows([]));

            await service.updateLibraryAvailability(
                'media-uuid-1',
                'jellyfin',
                'a1bc9a3d-39d6-8698-370b-bcd45cfb9c11',
                true,
                '1080p',
            );

            expect(mockSql).toHaveBeenCalledTimes(1);
        });

        it('normalizes Jellyfin library item IDs to dashless before upsert', async () => {
            mockSqlFn.mockResolvedValueOnce(rows([]));

            await service.updateLibraryAvailability(
                'media-uuid-1',
                'jellyfin',
                'a1bc9a3d-39d6-8698-370b-bcd45cfb9c11',
                true,
            );

            expect(mockSql).toHaveBeenCalledTimes(1);
        });

        it('does not normalize non-Jellyfin library item IDs', async () => {
            mockSqlFn.mockResolvedValueOnce(rows([]));

            await service.updateLibraryAvailability(
                'media-uuid-1',
                'plex',
                'some-plex-id-with-dashes',
                false,
            );

            expect(mockSql).toHaveBeenCalledTimes(1);
        });
    });

    // =========================================================================
    // findByExternalId — delegates to query module
    // =========================================================================

    describe('findByExternalId', () => {
        it('delegates to findMediaIdByExternalId query', async () => {
            vi.mocked(findMediaIdByExternalId).mockResolvedValue('media-uuid-1');

            const result = await service.findByExternalId({
                provider: 'tmdb',
                id: '550',
                mediaType: 'movie',
            });

            expect(findMediaIdByExternalId).toHaveBeenCalledWith(mockSql, {
                provider: 'tmdb',
                externalId: '550',
                mediaType: 'movie',
            });
            expect(result).toBe('media-uuid-1');
        });

        it('returns null when external ID is not found', async () => {
            vi.mocked(findMediaIdByExternalId).mockResolvedValue(null);

            const result = await service.findByExternalId({
                provider: 'tmdb',
                id: '99999',
                mediaType: 'movie',
            });

            expect(result).toBeNull();
        });
    });

    // =========================================================================
    // getById — delegates to query module
    // =========================================================================

    describe('getById', () => {
        it('returns shaped media item when found', async () => {
            const mockRow: MediaItemRow = {
                id: 'media-uuid-1',
                title: 'Quiet Orbit',
                original_title: 'Quiet Orbit',
                year: 1999,
                media_type: 'movie',
                is_local_only: false,
                status: 'active',
                file_path: null,
                runtime_seconds: null,
            };
            vi.mocked(getMediaItemById).mockResolvedValue(mockRow);

            const result = await service.getById('media-uuid-1');

            expect(getMediaItemById).toHaveBeenCalledWith(mockSql, 'media-uuid-1');
            expect(result).toEqual({
                id: 'media-uuid-1',
                title: 'Quiet Orbit',
                originalTitle: 'Quiet Orbit',
                year: 1999,
                mediaType: 'movie',
                isLocalOnly: false,
            });
        });

        it('returns null when media item is not found', async () => {
            vi.mocked(getMediaItemById).mockResolvedValue(null);

            const result = await service.getById('non-existent-uuid');

            expect(result).toBeNull();
        });

        it('omits optional fields when they are falsy', async () => {
            const mockRow: MediaItemRow = {
                id: 'media-uuid-2',
                title: 'Unknown Movie',
                original_title: null,
                year: null,
                media_type: 'movie',
                is_local_only: false,
                status: 'active',
                file_path: null,
                runtime_seconds: null,
            };
            vi.mocked(getMediaItemById).mockResolvedValue(mockRow);

            const result = await service.getById('media-uuid-2');

            expect(result?.originalTitle).toBeUndefined();
            expect(result?.year).toBeUndefined();
        });
    });

    // =========================================================================
    // getExternalIds — delegates to query module
    // =========================================================================

    describe('getExternalIds', () => {
        it('maps database rows to ExternalId shapes', async () => {
            const mockRows: ExternalIdRow[] = [
                {
                    provider: 'tmdb',
                    external_id: '550',
                    media_type: 'movie',
                    confidence: 1.0,
                    is_primary: true,
                },
                {
                    provider: 'imdb',
                    external_id: 'tt0137523',
                    media_type: 'movie',
                    confidence: 0.95,
                    is_primary: false,
                },
            ];
            vi.mocked(getExternalIdsForMedia).mockResolvedValue(mockRows);

            const result = await service.getExternalIds('media-uuid-1');

            expect(getExternalIdsForMedia).toHaveBeenCalledWith(mockSql, 'media-uuid-1');
            expect(result).toEqual([
                {
                    provider: 'tmdb',
                    id: '550',
                    mediaType: 'movie',
                    confidence: 1.0,
                },
                {
                    provider: 'imdb',
                    id: 'tt0137523',
                    mediaType: 'movie',
                    confidence: 0.95,
                },
            ]);
        });

        it('returns empty array when no external IDs exist', async () => {
            vi.mocked(getExternalIdsForMedia).mockResolvedValue([]);

            const result = await service.getExternalIds('media-uuid-1');

            expect(result).toEqual([]);
        });

        it('omits mediaType and confidence when falsy', async () => {
            const mockRows: ExternalIdRow[] = [
                {
                    provider: 'jellyfin',
                    external_id: 'a1bc9a3d39d68698370bbcd45cfb9c11',
                    media_type: null,
                    confidence: 0,
                    is_primary: true,
                },
            ];
            vi.mocked(getExternalIdsForMedia).mockResolvedValue(mockRows);

            const result = await service.getExternalIds('media-uuid-1');

            expect(result[0].mediaType).toBeUndefined();
            // confidence 0 is falsy — mapped to undefined
            expect(result[0].confidence).toBeUndefined();
        });
    });

    // =========================================================================
    // isAvailable — delegates to query module
    // =========================================================================

    describe('isAvailable', () => {
        it('returns true when media is available in a library', async () => {
            vi.mocked(isMediaAvailable).mockResolvedValue(true);

            const result = await service.isAvailable('media-uuid-1');

            expect(isMediaAvailable).toHaveBeenCalledWith(mockSql, 'media-uuid-1');
            expect(result).toBe(true);
        });

        it('returns false when media is not in any library', async () => {
            vi.mocked(isMediaAvailable).mockResolvedValue(false);

            const result = await service.isAvailable('media-uuid-1');

            expect(result).toBe(false);
        });
    });

    // =========================================================================
    // storeProviderMetadata
    // =========================================================================

    describe('storeProviderMetadata', () => {
        it('inserts provider metadata and triggers re-aggregation for known providers', async () => {
            vi.mocked(isProviderUsedInAggregation).mockReturnValue(true);
            vi.mocked(aggregateMetadataForMedia).mockResolvedValue(undefined);
            mockSqlFn.mockResolvedValueOnce(rows([]));

            await service.storeProviderMetadata('media-uuid-1', 'tmdb', {
                title: 'Quiet Orbit',
                year: 1999,
            });

            expect(mockSql).toHaveBeenCalledTimes(1);
            expect(isProviderUsedInAggregation).toHaveBeenCalledWith('tmdb');
            // force defaults to undefined when the caller doesn't pass options (C3)
            expect(aggregateMetadataForMedia).toHaveBeenCalledWith(mockSql, 'media-uuid-1', {
                force: undefined,
            });
        });

        it('passes force through to aggregateMetadataForMedia (C3, 2026-09-24 security review)', async () => {
            vi.mocked(isProviderUsedInAggregation).mockReturnValue(true);
            vi.mocked(aggregateMetadataForMedia).mockResolvedValue(undefined);
            mockSqlFn.mockResolvedValueOnce(rows([]));

            await service.storeProviderMetadata(
                'media-uuid-1',
                'tmdb',
                { title: 'Quiet Orbit' },
                undefined,
                undefined,
                { force: true },
            );

            expect(aggregateMetadataForMedia).toHaveBeenCalledWith(mockSql, 'media-uuid-1', {
                force: true,
            });
        });

        it('skips re-aggregation for the aggregated provider itself', async () => {
            mockSqlFn.mockResolvedValueOnce(rows([]));

            await service.storeProviderMetadata('media-uuid-1', 'aggregated', {
                title: 'Quiet Orbit',
            });

            expect(isProviderUsedInAggregation).not.toHaveBeenCalled();
            expect(aggregateMetadataForMedia).not.toHaveBeenCalled();
        });

        it('skips re-aggregation when provider is not used in aggregation', async () => {
            vi.mocked(isProviderUsedInAggregation).mockReturnValue(false);
            mockSqlFn.mockResolvedValueOnce(rows([]));

            await service.storeProviderMetadata('media-uuid-1', 'custom-source', {
                note: 'some data',
            });

            expect(aggregateMetadataForMedia).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // batchResolve — delegates to query module
    // =========================================================================

    describe('batchResolve', () => {
        it('delegates to batchResolveExternalIds', async () => {
            const mockMap = new Map([['tmdb:550:movie', 'media-uuid-1']]);
            vi.mocked(batchResolveExternalIds).mockResolvedValue(mockMap);

            const items = [{ provider: 'tmdb', externalId: '550', mediaType: 'movie' }];
            const result = await service.batchResolve(items);

            expect(batchResolveExternalIds).toHaveBeenCalledWith(mockSql, items);
            expect(result).toBe(mockMap);
        });

        it('returns an empty map when no items resolve', async () => {
            vi.mocked(batchResolveExternalIds).mockResolvedValue(new Map());

            const result = await service.batchResolve([{ provider: 'tmdb', externalId: '99999' }]);

            expect(result.size).toBe(0);
        });
    });

    // =========================================================================
    // getOrCreateMinimalByTmdb — validation guard
    // =========================================================================

    describe('getOrCreateMinimalByTmdb', () => {
        it('throws for TMDB ID zero', async () => {
            await expect(service.getOrCreateMinimalByTmdb(0, 'movie', 'Unknown')).rejects.toThrow(
                'Invalid TMDB ID',
            );
        });

        it('throws for negative TMDB IDs', async () => {
            await expect(service.getOrCreateMinimalByTmdb(-1, 'tv', 'Unknown')).rejects.toThrow(
                'Invalid TMDB ID',
            );
        });

        it('returns existing item without creating when found', async () => {
            const txSql = makeTxSql();
            // Advisory lock SELECT
            txSql.mockResolvedValueOnce(rows([]));
            // findByExternalIdTx → SELECT returns a row
            txSql.mockResolvedValueOnce(rows([{ media_id: 'existing-uuid' }]));

            (mockSql as unknown as Record<string, unknown>).begin = vi.fn().mockImplementation(
                (
                    fn: (tx: postgres.Sql) => Promise<{
                        id: string;
                        isNew: boolean;
                    }>,
                ) => fn(txSql),
            );

            const result = await service.getOrCreateMinimalByTmdb(550, 'movie', 'Quiet Orbit');

            expect(result).toEqual({ id: 'existing-uuid', isNew: false });
        });

        it('creates a new item when TMDB ID is not found', async () => {
            const txSql = makeTxSql();
            // Advisory lock SELECT
            txSql.mockResolvedValueOnce(rows([]));
            // findByExternalIdTx → not found
            txSql.mockResolvedValueOnce(rows([]));
            // INSERT media_items RETURNING id
            txSql.mockResolvedValueOnce(rows([{ id: 'new-uuid' }]));
            // INSERT external_ids
            txSql.mockResolvedValueOnce(rows([]));

            (mockSql as unknown as Record<string, unknown>).begin = vi.fn().mockImplementation(
                (
                    fn: (tx: postgres.Sql) => Promise<{
                        id: string;
                        isNew: boolean;
                    }>,
                ) => fn(txSql),
            );

            const result = await service.getOrCreateMinimalByTmdb(
                550,
                'movie',
                'Quiet Orbit',
                'Quiet Orbit',
                1999,
            );

            expect(result).toEqual({ id: 'new-uuid', isNew: true });
        });
    });

    // =========================================================================
    // getOrCreateMinimal
    // =========================================================================

    describe('getOrCreateMinimal', () => {
        it('returns existing item without creating when found', async () => {
            const txSql = makeTxSql();
            // Advisory lock
            txSql.mockResolvedValueOnce(rows([]));
            // findByExternalIdTx → found
            txSql.mockResolvedValueOnce(rows([{ media_id: 'existing-uuid' }]));

            (mockSql as unknown as Record<string, unknown>).begin = vi.fn().mockImplementation(
                (
                    fn: (tx: postgres.Sql) => Promise<{
                        id: string;
                        isNew: boolean;
                    }>,
                ) => fn(txSql),
            );

            const result = await service.getOrCreateMinimal('tt0137523', 'imdb', 'movie');

            expect(result).toEqual({ id: 'existing-uuid', isNew: false });
        });

        it('creates a stub item with default title when title is omitted', async () => {
            const txSql = makeTxSql();
            txSql.mockResolvedValueOnce(rows([])); // advisory lock
            txSql.mockResolvedValueOnce(rows([])); // findByExternalIdTx → not found
            txSql.mockResolvedValueOnce(rows([{ id: 'new-stub-uuid' }])); // INSERT media_items
            txSql.mockResolvedValueOnce(rows([])); // INSERT external_ids

            (mockSql as unknown as Record<string, unknown>).begin = vi.fn().mockImplementation(
                (
                    fn: (tx: postgres.Sql) => Promise<{
                        id: string;
                        isNew: boolean;
                    }>,
                ) => fn(txSql),
            );

            const result = await service.getOrCreateMinimal('tt0137523', 'imdb', 'movie');

            expect(result).toEqual({ id: 'new-stub-uuid', isNew: true });
        });
    });

    // =========================================================================
    // createLocalOnlyItem
    // =========================================================================

    describe('createLocalOnlyItem', () => {
        it('creates a media item, external ID, and library availability in one transaction', async () => {
            const txSql = makeTxSql();
            txSql
                .mockResolvedValueOnce(rows([{ id: 'local-uuid' }])) // INSERT media_items
                .mockResolvedValueOnce(rows([])) // INSERT external_ids
                .mockResolvedValueOnce(rows([])); // INSERT library_availability

            (mockSql as unknown as Record<string, unknown>).begin = vi
                .fn()
                .mockImplementation((fn: (tx: postgres.Sql) => Promise<string>) => fn(txSql));

            const result = await service.createLocalOnlyItem(
                'a1bc9a3d-39d6-8698-370b-bcd45cfb9c11',
                'Local Movie',
                'movie',
                2020,
            );

            expect(result).toBe('local-uuid');
            expect(txSql).toHaveBeenCalledTimes(3);
            expect(mockLogger.info).toHaveBeenCalledWith(
                'Created local-only media item',
                expect.objectContaining({
                    id: 'local-uuid',
                    title: 'Local Movie',
                    mediaType: 'movie',
                }),
            );
        });

        it('normalizes the Jellyfin ID for storage', async () => {
            const txSql = makeTxSql();
            txSql
                .mockResolvedValueOnce(rows([{ id: 'local-uuid-2' }]))
                .mockResolvedValueOnce(rows([]))
                .mockResolvedValueOnce(rows([]));

            (mockSql as unknown as Record<string, unknown>).begin = vi
                .fn()
                .mockImplementation((fn: (tx: postgres.Sql) => Promise<string>) => fn(txSql));

            const result = await service.createLocalOnlyItem(
                'a1bc9a3d-39d6-8698-370b-bcd45cfb9c11',
                'Series',
                'tv',
            );

            expect(result).toBe('local-uuid-2');
        });
    });
});
